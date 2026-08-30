import type { LocalTotals, MeterLevel, MeterSnapshot, MeterStatus } from './contracts';

export const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface WeeklyRateLimit {
  usedPct: number;
  resetAt: number;
  planName: string | null;
}

export interface LocalUsageRecord {
  key: string;
  timestampMs: number;
  usage: TokenUsage | null;
  weekly: WeeklyRateLimit | null;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegative(value: unknown): number {
  return Math.max(0, finite(value) ?? 0);
}

function planName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 48) : null;
}

function weeklyRateLimit(rateLimits: UnknownRecord | null): WeeklyRateLimit | null {
  if (!rateLimits) return null;
  for (const name of ['primary', 'secondary']) {
    const candidate = record(rateLimits[name]);
    if (!candidate || finite(candidate.window_minutes) !== 10_080) continue;
    const usedPct = finite(candidate.used_percent);
    const resetSeconds = finite(candidate.resets_at);
    if (usedPct === null || resetSeconds === null || resetSeconds <= 0) continue;
    return {
      usedPct: Math.max(0, Math.min(100, usedPct)),
      resetAt: resetSeconds * 1_000,
      planName: planName(rateLimits.plan_type),
    };
  }
  return null;
}

export function sessionIdFromJsonlLine(line: string): string | null {
  if (!line.includes('"session_meta"')) return null;
  try {
    const root = record(JSON.parse(line));
    const payload = record(root?.payload);
    if (root?.type !== 'session_meta' || typeof payload?.id !== 'string') return null;
    const id = payload.id.trim();
    return id || null;
  } catch {
    return null;
  }
}

export function parseLocalUsageLine(line: string, key: string): LocalUsageRecord | null {
  if (!line.includes('"token_count"')) return null;
  let root: UnknownRecord | null;
  try {
    root = record(JSON.parse(line));
  } catch {
    return null;
  }
  const payload = record(root?.payload);
  if (root?.type !== 'event_msg' || payload?.type !== 'token_count') return null;
  const timestampMs = typeof root.timestamp === 'string' ? Date.parse(root.timestamp) : Number.NaN;
  if (!Number.isFinite(timestampMs)) return null;

  const info = record(payload.info);
  const rawUsage = record(info?.last_token_usage);
  let usage: TokenUsage | null = null;
  if (rawUsage) {
    const inputTokens = nonNegative(rawUsage.input_tokens);
    const cachedInputTokens = Math.min(inputTokens, nonNegative(rawUsage.cached_input_tokens));
    const outputTokens = nonNegative(rawUsage.output_tokens);
    const reportedTotal = nonNegative(rawUsage.total_tokens);
    const totalTokens = reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens;
    if (totalTokens > 0) usage = { inputTokens, cachedInputTokens, outputTokens, totalTokens };
  }

  const weekly = weeklyRateLimit(record(payload.rate_limits));
  return usage || weekly ? { key, timestampMs, usage, weekly } : null;
}

export function normalizeGuardrail(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 80;
  return Math.max(1, Math.min(100, Math.round(value)));
}

function totals(records: readonly LocalUsageRecord[], fromMs: number, toMs: number): LocalTotals {
  const result: LocalTotals = {
    tokens: 0,
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  const seen = new Set<string>();
  for (const item of records) {
    if (seen.has(item.key) || item.timestampMs < fromMs || item.timestampMs > toMs || !item.usage) continue;
    seen.add(item.key);
    result.tokens += item.usage.totalTokens;
    result.requests += 1;
    result.inputTokens += item.usage.inputTokens;
    result.cachedInputTokens += item.usage.cachedInputTokens;
    result.outputTokens += item.usage.outputTokens;
  }
  return result;
}

function levelFor(usedPct: number | null, guardrailPct: number): MeterLevel {
  if (usedPct === null) return 'unknown';
  if (usedPct >= guardrailPct) return 'danger';
  if (usedPct >= Math.max(0, guardrailPct - 10)) return 'warning';
  return 'normal';
}

export interface SnapshotDiagnostics {
  filesIndexed?: number;
  bytesRead?: number;
  error?: string;
}

export function buildSnapshot(
  records: readonly LocalUsageRecord[],
  guardrailValue: unknown,
  now = Date.now(),
  diagnostics: SnapshotDiagnostics = {},
): MeterSnapshot {
  const guardrailPct = normalizeGuardrail(guardrailValue);
  const unique = new Map<string, LocalUsageRecord>();
  for (const item of records) unique.set(item.key, item);
  const values = [...unique.values()];
  const newest = values
    .filter((item): item is LocalUsageRecord & { weekly: WeeklyRateLimit } => item.weekly !== null)
    .sort((left, right) => right.timestampMs - left.timestampMs)[0] ?? null;

  const active = newest !== null && newest.weekly.resetAt > now;
  const windowStart = active ? newest.weekly.resetAt - WEEK_MS : now - WEEK_MS;
  const accountUsedPct = active ? newest.weekly.usedPct : null;
  const expired = newest !== null && !active;
  const status: MeterStatus = diagnostics.error ? 'error' : active ? 'ready' : expired ? 'expired' : 'waiting';
  const statusDetail = diagnostics.error
    ? diagnostics.error
    : active
      ? '로컬 Codex 세션이 보고한 최신 계정 주간 사용률입니다.'
      : expired
        ? '마지막 주간 사용률이 만료되었습니다. 다음 Codex 작업 후 갱신됩니다.'
        : '주간 rate_limits가 포함된 로컬 Codex 세션을 기다리는 중입니다.';
  const level = levelFor(accountUsedPct, guardrailPct);

  return {
    generatedAt: now,
    status,
    statusDetail,
    source: 'local-session-jsonl',
    planName: active ? newest.weekly.planName : null,
    accountUsedPct,
    accountRemainingPct: accountUsedPct === null ? null : Math.max(0, 100 - accountUsedPct),
    accountObservedAt: active ? newest.timestampMs : null,
    resetAt: active ? newest.weekly.resetAt : null,
    windowStart,
    exactWindow: active,
    local: totals(values, windowStart, now),
    localCapacityPct: null,
    localCapacityReason: '계정 한도 대비 이 PC의 비율은 로컬 로그만으로 정확히 계산할 수 없어 표시하지 않습니다.',
    guardrailPct,
    guardrailExceeded: level === 'danger',
    level,
    filesIndexed: diagnostics.filesIndexed ?? 0,
    bytesRead: diagnostics.bytesRead ?? 0,
  };
}
