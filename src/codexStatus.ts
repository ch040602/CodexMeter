import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { AccountTokenUsage } from './contracts';
import type { AccountRateLimit } from './usage';

const WEEK_MINUTES = 10_080;
const INITIALIZE_TIMEOUT_MS = 5_000;
const STATUS_TIMEOUT_MS = 8_000;
const TOKEN_USAGE_CACHE_MS = 15_000;

type UnknownRecord = Record<string, unknown>;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function planName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 48) : null;
}

export function parseCodexRateLimits(value: unknown, observedAt = Date.now()): AccountRateLimit | null {
  const result = record(value);
  const byLimitId = record(result?.rateLimitsByLimitId);
  const snapshot = record(byLimitId?.codex) ?? record(result?.rateLimits);
  if (!snapshot) return null;

  for (const name of ['primary', 'secondary']) {
    const window = record(snapshot[name]);
    if (finite(window?.windowDurationMins) !== WEEK_MINUTES) continue;
    const usedPct = finite(window?.usedPercent);
    const resetSeconds = finite(window?.resetsAt);
    if (usedPct === null || resetSeconds === null || resetSeconds <= 0) continue;
    return {
      usedPct: Math.max(0, Math.min(100, usedPct)),
      resetAt: resetSeconds * 1_000,
      planName: planName(snapshot.planType),
      observedAt,
    };
  }
  return null;
}

export function parseCodexTokenUsage(value: unknown): AccountTokenUsage | null {
  const result = record(value);
  if (!Array.isArray(result?.dailyUsageBuckets)) return null;
  const dailyUsageBuckets = result.dailyUsageBuckets.flatMap(item => {
    const bucket = record(item);
    const startDate = typeof bucket?.startDate === 'string' ? bucket.startDate.trim() : '';
    const tokens = finite(bucket?.tokens);
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(startDate)
      && !Number.isNaN(Date.parse(`${startDate}T00:00:00Z`));
    if (!validDate || tokens === null) {
      return [];
    }
    return [{ startDate, tokens: Math.max(0, tokens) }];
  });
  return dailyUsageBuckets.length > 0 ? { dailyUsageBuckets } : null;
}

interface CodexTarget {
  packageName: string;
  triple: string;
}

function codexTarget(architecture: string): CodexTarget | null {
  if (architecture === 'arm64') return { packageName: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' };
  if (architecture === 'x64') return { packageName: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' };
  return null;
}

function codexPackageBinaries(root: string, target: CodexTarget): string[] {
  return [
    path.join(root, 'node_modules', '@openai', target.packageName, 'vendor', target.triple, 'bin', 'codex.exe'),
    path.join(root, 'vendor', target.triple, 'bin', 'codex.exe'),
  ];
}

export function findCodexBinary(
  env: NodeJS.ProcessEnv = process.env,
  platformName = process.platform,
  architecture = process.arch,
): string | null {
  if (platformName !== 'win32') return null;
  const target = codexTarget(architecture);
  if (!target) return null;

  const packageRoots: string[] = [];
  const pathBinaries: string[] = [];
  const addPackageRoot = (value: string | undefined): void => {
    if (!value?.trim()) return;
    const root = path.resolve(value);
    if (!packageRoots.includes(root)) packageRoots.push(root);
  };
  const addNearbyPackageRoots = (startDirectory: string): void => {
    let current = path.resolve(startDirectory);
    for (let depth = 0; depth < 8; depth += 1) {
      addPackageRoot(path.join(current, 'node_modules', '@openai', 'codex'));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };

  addPackageRoot(env.CODEX_MANAGED_PACKAGE_ROOT);
  const pathValue = env.Path ?? env.PATH ?? '';
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim();
    if (!directory) continue;
    const directBinary = path.join(directory, 'codex.exe');
    if (existsSync(directBinary)) pathBinaries.push(directBinary);
    if (['codex.cmd', 'codex.ps1', 'codex'].some(name => existsSync(path.join(directory, name)))) {
      addNearbyPackageRoots(directory);
    }
  }

  const addGlobalPrefix = (prefix: string | undefined): void => {
    if (prefix) addPackageRoot(path.join(prefix, 'node_modules', '@openai', 'codex'));
  };
  addGlobalPrefix(env.npm_config_prefix);
  addGlobalPrefix(env.NPM_CONFIG_PREFIX);
  addGlobalPrefix(env.APPDATA ? path.join(env.APPDATA, 'npm') : undefined);
  addGlobalPrefix(env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'npm') : undefined);
  if (env.USERPROFILE) {
    addPackageRoot(path.join(env.USERPROFILE, '.bun', 'install', 'global', 'node_modules', '@openai', 'codex'));
  }

  for (const root of packageRoots) {
    const binary = codexPackageBinaries(root, target).find(candidate => existsSync(candidate));
    if (binary) return binary;
  }
  return pathBinaries.find(candidate => existsSync(candidate)) ?? null;
}

export class CodexStatusClient {
  private readonly binaryPath = findCodexBinary();
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private tokenUsageCache: { observedAt: number; value: AccountTokenUsage | null } | null = null;
  private closed = false;

  async readWeeklyLimit(): Promise<AccountRateLimit | null> {
    if (!this.binaryPath || this.closed) return null;
    try {
      await this.ensureStarted();
      const result = await this.request('account/rateLimits/read', undefined, STATUS_TIMEOUT_MS);
      return parseCodexRateLimits(result);
    } catch {
      this.stopChild(new Error('Codex 로컬 상태 연결이 끊겼습니다.'));
      return null;
    }
  }

  async readTokenUsage(): Promise<AccountTokenUsage | null> {
    if (!this.binaryPath || this.closed) return null;
    const now = Date.now();
    if (this.tokenUsageCache && now - this.tokenUsageCache.observedAt < TOKEN_USAGE_CACHE_MS) {
      return this.tokenUsageCache.value;
    }
    try {
      await this.ensureStarted();
      const result = await this.request('account/usage/read', undefined, STATUS_TIMEOUT_MS);
      const parsed = parseCodexTokenUsage(result);
      const value = parsed ?? this.tokenUsageCache?.value ?? null;
      this.tokenUsageCache = { observedAt: Date.now(), value };
      return value;
    } catch {
      // Older Codex builds may reject this optional method; keep the rate-limit channel alive.
      const value = this.tokenUsageCache?.value ?? null;
      this.tokenUsageCache = { observedAt: Date.now(), value };
      return value;
    }
  }

  close(): void {
    this.closed = true;
    this.stopChild(new Error('Codex Meter가 종료됩니다.'));
  }

  private async ensureStarted(): Promise<void> {
    if (this.ready) return this.ready;
    if (!this.binaryPath) throw new Error('Codex CLI를 찾지 못했습니다.');

    const child = spawn(this.binaryPath, ['app-server', '--listen', 'stdio://'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr.resume();
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => this.handleLine(line));
    child.once('error', () => this.stopChild(new Error('Codex 로컬 상태 프로세스를 시작하지 못했습니다.'), child));
    child.once('exit', () => this.stopChild(new Error('Codex 로컬 상태 프로세스가 종료됐습니다.'), child));

    const ready = this.request('initialize', {
      clientInfo: { name: 'codex-meter', version: '1.0.0' },
      capabilities: {},
    }, INITIALIZE_TIMEOUT_MS).then(() => undefined);
    this.ready = ready;
    try {
      await ready;
    } catch (error) {
      this.stopChild(error instanceof Error ? error : new Error('Codex 로컬 상태 초기화에 실패했습니다.'), child);
      throw error;
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child || child.stdin.destroyed) return Promise.reject(new Error('Codex 로컬 상태 연결이 없습니다.'));
    const id = this.nextId;
    this.nextId += 1;
    const payload: UnknownRecord = { id, method };
    if (params !== undefined) payload.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex 로컬 상태 응답 시간이 초과됐습니다.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(payload)}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error('Codex 로컬 상태 요청을 보내지 못했습니다.'));
      });
    });
  }

  private handleLine(line: string): void {
    let message: UnknownRecord | null;
    try {
      message = record(JSON.parse(line));
    } catch {
      return;
    }
    const id = finite(message?.id);
    if (id === null) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (message && 'error' in message) pending.reject(new Error('Codex 로컬 상태 요청이 거부됐습니다.'));
    else pending.resolve(message?.result);
  }

  private stopChild(error: Error, expectedChild: ChildProcessWithoutNullStreams | null = this.child): void {
    if (!expectedChild || this.child !== expectedChild) return;
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.lines?.close();
    this.lines = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (child && !child.killed) {
      child.stdin.end();
      child.kill();
    }
  }
}
