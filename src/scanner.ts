import { createReadStream } from 'node:fs';
import { open, opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AccountTokenUsage, MeterSnapshot } from './contracts';
import {
  buildSnapshot,
  parseLocalUsageLine,
  sessionIdFromJsonlLine,
  WEEK_MS,
  type AccountRateLimit,
  type LocalUsageRecord,
} from './usage';

const TAIL_PROBE_BYTES = 2 * 1024 * 1024;

interface FileCache {
  size: number;
  mtimeMs: number;
  carry: string;
  sessionId: string | null;
  nextRecordIndex: number;
  records: LocalUsageRecord[];
}

interface DiscoveredFile {
  filePath: string;
  mtimeMs: number;
  size: number;
}

interface ProbeCache {
  size: number;
  mtimeMs: number;
  latest: LocalUsageRecord | null;
}

interface ReadResult {
  cache: FileCache;
  bytesRead: number;
}

async function discoverJsonlFiles(roots: readonly string[], cutoffMs: number): Promise<DiscoveredFile[]> {
  const files: DiscoveredFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    let handle;
    try {
      handle = await opendir(directory);
    } catch {
      return;
    }
    for await (const entry of handle) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const info = await stat(fullPath);
          if (info.mtimeMs >= cutoffMs) files.push({ filePath: fullPath, mtimeMs: info.mtimeMs, size: info.size });
        } catch {
          // Codex may rotate a file between directory listing and stat.
        }
      }
    }
  };
  for (const root of roots) await visit(root);
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath));
}

function recordKey(filePath: string, sessionId: string | null, timestampMs: number, index: number): string {
  return `${sessionId ?? filePath}|${timestampMs}|${index}`;
}

function newestRecord(lines: readonly string[], filePath: string): LocalUsageRecord | null {
  let newest: LocalUsageRecord | null = null;
  let index = 0;
  for (const line of lines) {
    const parsed = parseLocalUsageLine(line, `probe:${filePath}:${index}`);
    index += 1;
    if (parsed && (!newest || parsed.timestampMs > newest.timestampMs)) newest = parsed;
  }
  return newest;
}

async function probeFile(file: DiscoveredFile, allowFullFallback: boolean): Promise<{ latest: LocalUsageRecord | null; bytesRead: number }> {
  const lengths = [Math.min(file.size, TAIL_PROBE_BYTES)];
  if (allowFullFallback && file.size > TAIL_PROBE_BYTES) lengths.push(file.size);
  let bytesRead = 0;
  for (const length of lengths) {
    if (length <= 0) continue;
    const start = file.size - length;
    const handle = await open(file.filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(length);
      const result = await handle.read(buffer, 0, length, start);
      bytesRead += result.bytesRead;
      let text = buffer.subarray(0, result.bytesRead).toString('utf8');
      if (start > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
      }
      const latest = newestRecord(text.split(/\r?\n/), file.filePath);
      if (latest) return { latest, bytesRead };
    } finally {
      await handle.close();
    }
  }
  return { latest: null, bytesRead };
}

async function readFileDelta(filePath: string, previous: FileCache | null): Promise<ReadResult> {
  const info = await stat(filePath);
  if (previous && previous.size === info.size && previous.mtimeMs === info.mtimeMs) {
    return { cache: previous, bytesRead: 0 };
  }

  const appendOnly = previous !== null && info.size > previous.size;
  const start = appendOnly ? previous.size : 0;
  let carry = appendOnly ? previous.carry : '';
  let sessionId = appendOnly ? previous.sessionId : null;
  let nextRecordIndex = appendOnly ? previous.nextRecordIndex : 0;
  const records = appendOnly ? [...previous.records] : [];
  let bytesRead = 0;

  if (info.size > start) {
    const stream = createReadStream(filePath, { start, encoding: 'utf8' });
    for await (const chunk of stream) {
      const text = String(chunk);
      bytesRead += Buffer.byteLength(text);
      carry += text;
      let newline = carry.indexOf('\n');
      while (newline >= 0) {
        const line = carry.slice(0, newline).replace(/\r$/, '');
        carry = carry.slice(newline + 1);
        sessionId ??= sessionIdFromJsonlLine(line);
        const parsed = parseLocalUsageLine(line, '');
        if (parsed) {
          parsed.key = recordKey(filePath, sessionId, parsed.timestampMs, nextRecordIndex);
          records.push(parsed);
          nextRecordIndex += 1;
        }
        newline = carry.indexOf('\n');
      }
    }
  }

  return {
    cache: {
      size: info.size,
      mtimeMs: info.mtimeMs,
      carry,
      sessionId,
      nextRecordIndex,
      records,
    },
    bytesRead,
  };
}

export class LocalUsageScanner {
  private fileCache = new Map<string, FileCache>();
  private probeCache = new Map<string, ProbeCache>();
  private activeWindowStart: number | null = null;

  constructor(private readonly roots: readonly string[]) {}

  private async updateProbes(files: readonly DiscoveredFile[]): Promise<number> {
    let bytesRead = 0;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const current = this.probeCache.get(file.filePath);
      if (current && current.size === file.size && current.mtimeMs === file.mtimeMs) continue;
      try {
        const result = await probeFile(file, index < 4);
        bytesRead += result.bytesRead;
        this.probeCache.set(file.filePath, { size: file.size, mtimeMs: file.mtimeMs, latest: result.latest });
      } catch {
        // A moved file will be rediscovered on the next refresh.
      }
    }
    const discovered = new Set(files.map(file => file.filePath));
    for (const filePath of this.probeCache.keys()) if (!discovered.has(filePath)) this.probeCache.delete(filePath);
    return bytesRead;
  }

  private newestWeeklyProbe(): LocalUsageRecord | null {
    let newest: LocalUsageRecord | null = null;
    for (const probe of this.probeCache.values()) {
      if (!probe.latest?.weekly) continue;
      if (!newest || probe.latest.timestampMs > newest.timestampMs) newest = probe.latest;
    }
    return newest;
  }

  async scan(
    guardrailPct: number,
    now = Date.now(),
    accountRateLimit: AccountRateLimit | null = null,
    accountTokenUsage: AccountTokenUsage | null = null,
  ): Promise<MeterSnapshot> {
    const discovered = await discoverJsonlFiles(this.roots, now - WEEK_MS - 24 * 60 * 60 * 1_000);
    let bytesRead = await this.updateProbes(discovered);
    if (accountRateLimit && accountRateLimit.resetAt > now) {
      this.activeWindowStart = accountRateLimit.resetAt - WEEK_MS;
    } else if (this.activeWindowStart === null) {
      const newest = this.newestWeeklyProbe();
      this.activeWindowStart = newest?.weekly ? newest.weekly.resetAt - WEEK_MS : null;
    }

    const selected = this.activeWindowStart === null
      ? discovered
      : discovered.filter(file => (
        this.fileCache.has(file.filePath)
        || (this.probeCache.get(file.filePath)?.latest?.timestampMs ?? 0) >= this.activeWindowStart!
      ));
    const selectedPaths = new Set(selected.map(file => file.filePath));
    for (const file of selected) {
      try {
        const result = await readFileDelta(file.filePath, this.fileCache.get(file.filePath) ?? null);
        this.fileCache.set(file.filePath, result.cache);
        bytesRead += result.bytesRead;
      } catch {
        // A concurrently moved session is picked up on the next scan.
      }
    }
    for (const filePath of this.fileCache.keys()) {
      if (!selectedPaths.has(filePath)) this.fileCache.delete(filePath);
    }

    const snapshot = buildSnapshot(
      [...this.fileCache.values()].flatMap(item => item.records),
      guardrailPct,
      now,
      { filesIndexed: this.fileCache.size, bytesRead, accountRateLimit, accountTokenUsage },
    );
    this.activeWindowStart = snapshot.exactWindow ? snapshot.windowStart : null;
    return snapshot;
  }
}
