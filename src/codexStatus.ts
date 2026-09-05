import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { AccountTokenUsage, CodexConnectionDiagnostics } from './contracts';
import type { AccountRateLimit } from './usage';

const WEEK_MINUTES = 10_080;
const INITIALIZE_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 20_000;

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() ? path.resolve(env.CODEX_HOME.trim()) : path.join(os.homedir(), '.codex');
}

function isFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}

function desktopBinaries(localAppData: string | undefined): string[] {
  if (!localAppData) return [];
  const directory = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => {
        const binary = path.join(directory, entry.name, 'codex.exe');
        try {
          const info = statSync(binary);
          return info.isFile() ? [{ binary, modified: info.mtimeMs }] : [];
        } catch { return []; }
      })
      .sort((left, right) => right.modified - left.modified)
      .map(entry => entry.binary);
  } catch { return []; }
}

function rpcErrorMessage(value: unknown): string {
  const error = record(value);
  const message = typeof error?.message === 'string' ? error.message : '';
  if (error?.code === -32601 || /method not found|unknown (method|variant)|experimentalApi/i.test(message)) {
    return '설치된 Codex가 이 조회 기능을 지원하지 않습니다. Codex를 업데이트한 뒤 새로고침하세요.';
  }
  if (/auth|log.?in|logged|401|403|api.?key|chatgpt.*required/i.test(message)) {
    return 'Codex의 ChatGPT 로그인과 계정 권한을 확인한 뒤 새로고침하세요. API 키만으로는 계정 사용량을 조회할 수 없습니다.';
  }
  return 'Codex 상태 조회가 거부되었습니다. 연결과 Codex 로그인 상태를 확인한 뒤 새로고침하세요.';
}

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
  const explicit = env.CODEX_METER_CODEX_PATH?.trim().replace(/^"|"$/g, '');
  if (explicit) return isFile(explicit) ? path.resolve(explicit) : null;

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
    const directory = entry.trim().replace(/^"|"$/g, '');
    if (!directory) continue;
    const directBinary = path.join(directory, 'codex.exe');
    if (isFile(directBinary)) pathBinaries.push(directBinary);
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
    const binary = codexPackageBinaries(root, target).find(isFile);
    if (binary) return binary;
  }
  return pathBinaries.find(isFile) ?? desktopBinaries(env.LOCALAPPDATA)[0] ?? null;
}

export class CodexStatusClient {
  private binaryPath: string | null = null;
  private rateLimitError: string | null = null;
  private tokenUsageError: string | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private ready: Promise<void> | null = null;
  private reconnectRequested = false;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private closed = false;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  getDiagnostics(): CodexConnectionDiagnostics {
    return {
      binaryPath: this.binaryPath,
      codexHome: codexHome(this.env),
      rateLimitError: this.rateLimitError,
      tokenUsageError: this.tokenUsageError,
    };
  }

  async readWeeklyLimit(): Promise<AccountRateLimit | null> {
    if (this.closed) return null;
    try {
      await this.ensureStarted();
      const result = await this.request('account/rateLimits/read', undefined, STATUS_TIMEOUT_MS);
      const parsed = parseCodexRateLimits(result);
      this.rateLimitError = parsed ? null : '이 계정에서 주간 Codex 사용 한도를 제공하지 않습니다. 로그인 계정과 요금제를 확인하세요.';
      return parsed;
    } catch (error) {
      // An optional/failed query must not cancel the other request on this connection.
      this.rateLimitError = error instanceof Error ? error.message : 'Codex 연결을 확인하세요.';
      this.reconnectRequested = true;
      return null;
    }
  }

  async readTokenUsage(): Promise<AccountTokenUsage | null> {
    if (this.closed) return null;
    try {
      await this.ensureStarted();
      const result = await this.request('account/usage/read', undefined, STATUS_TIMEOUT_MS);
      const parsed = parseCodexTokenUsage(result);
      this.tokenUsageError = parsed ? null : 'Codex가 계정 토큰 내역을 제공하지 않았습니다. 로컬 토큰은 확인할 수 있지만 계정 비율은 계산할 수 없습니다.';
      return parsed;
    } catch (error) {
      this.tokenUsageError = error instanceof Error ? error.message : 'Codex 연결을 확인하세요.';
      this.reconnectRequested = true;
      return null;
    }
  }

  close(): void {
    this.closed = true;
    this.stopChild(new Error('Codex Meter가 종료됩니다.'));
  }

  private async ensureStarted(): Promise<void> {
    // Retry on the next refresh, after other queries have had a chance to finish.
    if (this.reconnectRequested && this.pending.size === 0) {
      this.stopChild(new Error('Codex 상태 연결을 다시 시작합니다.'));
      this.reconnectRequested = false;
    }
    if (this.ready) return this.ready;
    this.binaryPath = findCodexBinary(this.env);
    if (!this.binaryPath) throw new Error('Codex 실행 파일을 찾지 못했습니다. Codex 데스크톱 앱을 한 번 실행하거나 Codex CLI를 설치한 뒤 새로고침하세요.');

    // Stdio is the default, including older releases without the --listen option.
    const child = spawn(this.binaryPath, ['app-server'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
      cwd: os.homedir(),
    });
    this.child = child;
    const onStreamError = (): void => this.stopChild(new Error('Codex 로컬 상태 연결이 끊어졌습니다.'), child);
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', onStreamError);
    child.stderr.resume();
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on('error', onStreamError);
    this.lines.on('line', line => this.handleLine(line));
    child.once('error', () => this.stopChild(new Error('Codex 로컬 상태 프로세스를 시작하지 못했습니다.'), child));
    child.once('exit', () => this.stopChild(new Error('Codex 로컬 상태 프로세스가 종료됐습니다.'), child));

    const ready = this.request('initialize', {
      clientInfo: { name: 'codex-meter', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    }, INITIALIZE_TIMEOUT_MS).then(() => new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`, error => {
        if (error) reject(new Error('Codex 초기화 완료 알림을 보내지 못했습니다.'));
        else resolve();
      });
    }));
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
        reject(new Error('Codex 응답 시간이 초과됐습니다. 잠시 후 자동 재시도합니다. 연결 상태도 확인하세요.'));
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
    if (message && 'error' in message) pending.reject(new Error(rpcErrorMessage(message.error)));
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
