import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { AccountRateLimit } from './usage';

const WEEK_MINUTES = 10_080;
const INITIALIZE_TIMEOUT_MS = 5_000;
const STATUS_TIMEOUT_MS = 8_000;

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

function installedCodexBinary(): string | null {
  if (process.platform !== 'win32' || !process.env.APPDATA) return null;
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const packageName = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
  const candidates = [
    path.join(
      process.env.APPDATA,
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      packageName,
      'vendor',
      target,
      'bin',
      'codex.exe',
    ),
    path.join(
      process.env.APPDATA,
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'vendor',
      target,
      'bin',
      'codex.exe',
    ),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

export class CodexStatusClient {
  private readonly binaryPath = installedCodexBinary();
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
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
