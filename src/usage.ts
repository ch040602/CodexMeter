import type {
  AccountTokenUsage,
  AccountTodayBasis,
  LocalTotals,
  LocalShareBasis,
  MeterLevel,
  MeterSnapshot,
  MeterStatus,
} from './contracts';

export const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DAILY_BASELINE_LOOKBACK_MS = 12 * 60 * 60 * 1_000;

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

export interface AccountRateLimit extends WeeklyRateLimit {
  observedAt: number;
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

function startOfLocalDay(timestampMs: number): number {
  const date = new Date(timestampMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function localDateKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

interface AccountTokenTotals {
  weekly: number;
  today: number;
  basis: Exclude<LocalShareBasis, 'unavailable'> | null;
}

function accountTokenTotals(
  accountUsage: AccountTokenUsage | null | undefined,
  windowStart: number,
  now: number,
): AccountTokenTotals {
  if (!accountUsage) return { weekly: 0, today: 0, basis: null };
  const firstDate = localDateKey(windowStart);
  const todayDate = localDateKey(now);
  let weekly = 0;
  let today = 0;
  for (const bucket of accountUsage.dailyUsageBuckets) {
    if (bucket.startDate < firstDate || bucket.startDate > todayDate) continue;
    weekly += bucket.tokens;
    if (bucket.startDate === todayDate) today += bucket.tokens;
  }
  let basis: AccountTokenTotals['basis'] = weekly > 0 ? 'account-token-usage' : null;
  // The endpoint returns calendar-day buckets. On a just-reset window, keep the
  // value useful but mark it as approximate instead of showing a blank weekly share.
  if (weekly <= 0) {
    const fallbackFirstDate = localDateKey(startOfLocalDay(now) - 6 * DAY_MS);
    weekly = accountUsage.dailyUsageBuckets
      .filter(bucket => bucket.startDate >= fallbackFirstDate && bucket.startDate <= todayDate)
      .reduce((sum, bucket) => sum + bucket.tokens, 0);
    basis = weekly > 0 ? 'recent-account-token-usage' : null;
  }
  return { weekly, today, basis };
}

function sharePercent(localTokens: number, accountTokens: number): number | null {
  if (!Number.isFinite(accountTokens) || accountTokens <= 0) return null;
  const value = Math.max(0, Math.min(100, localTokens / accountTokens * 100));
  return Math.round(value * 10) / 10;
}

interface AccountTodayUsage {
  usedPct: number | null;
  basis: AccountTodayBasis;
  baselineAt: number | null;
}

function accountTodayUsage(
  records: readonly LocalUsageRecord[],
  account: WeeklyRateLimit | null,
  windowStart: number,
  now: number,
): AccountTodayUsage {
  if (!account) return { usedPct: null, basis: 'unavailable', baselineAt: null };
  const midnight = startOfLocalDay(now);
  if (windowStart >= midnight && windowStart <= now) {
    return { usedPct: account.usedPct, basis: 'reset', baselineAt: windowStart };
  }

  const earliest = Math.max(windowStart, midnight - DAILY_BASELINE_LOOKBACK_MS);
  let baseline: LocalUsageRecord & { weekly: WeeklyRateLimit } | null = null;
  for (const item of records) {
    if (
      !item.weekly
      || item.weekly.resetAt !== account.resetAt
      || item.timestampMs > midnight
      || item.timestampMs < earliest
    ) continue;
    if (!baseline || item.timestampMs > baseline.timestampMs) {
      baseline = item as LocalUsageRecord & { weekly: WeeklyRateLimit };
    }
  }
  if (!baseline) return { usedPct: null, basis: 'unavailable', baselineAt: null };
  const usedPct = Math.round(Math.max(0, account.usedPct - baseline.weekly.usedPct) * 10) / 10;
  return { usedPct, basis: 'observed', baselineAt: baseline.timestampMs };
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
  accountRateLimit?: AccountRateLimit | null;
  accountTokenUsage?: AccountTokenUsage | null;
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

  const live = diagnostics.accountRateLimit && diagnostics.accountRateLimit.resetAt > now
    ? diagnostics.accountRateLimit
    : null;
  const logged = newest !== null && newest.weekly.resetAt > now
    ? { ...newest.weekly, observedAt: newest.timestampMs }
    : null;
  const account = live ?? logged;
  const active = account !== null;
  const windowStart = active ? account.resetAt - WEEK_MS : now - WEEK_MS;
  const accountUsedPct = active ? account.usedPct : null;
  const expired = newest !== null && !active;
  const status: MeterStatus = diagnostics.error ? 'error' : active ? 'ready' : expired ? 'expired' : 'waiting';
  const statusDetail = diagnostics.error
    ? diagnostics.error
    : active
      ? live
        ? 'Codex 로컬 상태가 보고한 최신 계정 주간 사용률입니다.'
        : '로컬 Codex 세션이 보고한 대체 계정 주간 사용률입니다.'
      : expired
        ? '마지막 주간 사용률이 만료되었습니다. 다음 Codex 작업 후 갱신됩니다.'
        : '주간 rate_limits가 포함된 로컬 Codex 세션을 기다리는 중입니다.';
  const level = levelFor(accountUsedPct, guardrailPct);
  const todayAccount = accountTodayUsage(values, active ? account : null, windowStart, now);
  const local = totals(values, windowStart, now);
  const localToday = totals(values, Math.max(windowStart, startOfLocalDay(now)), now);
  const accountTokens = accountTokenTotals(diagnostics.accountTokenUsage, windowStart, now);
  const localAccountSharePct = sharePercent(local.tokens, accountTokens.weekly);
  const localAccountShareTodayPct = sharePercent(localToday.tokens, accountTokens.today);
  const localShareBasis: LocalShareBasis = accountTokens.basis ?? 'unavailable';
  const localShareReason = localShareBasis === 'account-token-usage'
    ? '이 PC 토큰 ÷ Codex account/usage/read의 계정 토큰 사용량입니다. 계정 요금제 잔여율과는 다른 분모입니다.'
    : localShareBasis === 'recent-account-token-usage'
      ? '현재 주간 버킷이 비어 있어 최근 7일 계정 토큰 버킷으로 계산한 근사 비중입니다. 계정 요금제 잔여율과는 다른 분모입니다.'
      : diagnostics.accountTokenUsage
        ? '현재 주간 계정 토큰 사용량이 없어 이 PC 비중을 계산할 수 없습니다.'
        : 'Codex account/usage/read를 읽지 못해 이 PC 비중을 계산할 수 없습니다.';

  return {
    generatedAt: now,
    status,
    statusDetail,
    source: live ? 'codex-local-status' : 'local-session-jsonl',
    planName: active ? account.planName : null,
    accountUsedPct,
    accountRemainingPct: accountUsedPct === null ? null : Math.max(0, 100 - accountUsedPct),
    accountObservedAt: active ? account.observedAt : null,
    accountTodayUsedPct: todayAccount.usedPct,
    accountTodayBasis: todayAccount.basis,
    accountTodayBaselineAt: todayAccount.baselineAt,
    resetAt: active ? account.resetAt : null,
    windowStart,
    exactWindow: active,
    local,
    localToday,
    localAccountSharePct,
    localAccountShareTodayPct,
    localShareBasis,
    localShareReason,
    guardrailPct,
    guardrailExceeded: level === 'danger',
    level,
    filesIndexed: diagnostics.filesIndexed ?? 0,
    bytesRead: diagnostics.bytesRead ?? 0,
  };
}
