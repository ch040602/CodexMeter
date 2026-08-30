import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SETTINGS, type MeterSettings, type OverlayPosition } from './contracts';
import { normalizeGuardrail } from './usage';

export function normalizeOverlayOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.overlayOpacity;
  return Math.max(35, Math.min(100, Math.round(value)));
}

export function normalizeOverlayPosition(value: unknown): OverlayPosition | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<OverlayPosition>;
  if (
    typeof candidate.x !== 'number'
    || typeof candidate.y !== 'number'
    || !Number.isFinite(candidate.x)
    || !Number.isFinite(candidate.y)
    || Math.abs(candidate.x) > 100_000
    || Math.abs(candidate.y) > 100_000
  ) return null;
  return { x: Math.round(candidate.x), y: Math.round(candidate.y) };
}

export async function readSettings(filePath: string): Promise<MeterSettings> {
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Partial<MeterSettings>;
    return {
      guardrailPct: normalizeGuardrail(raw.guardrailPct),
      overlayVisible: raw.overlayVisible === true,
      overlayOpacity: normalizeOverlayOpacity(raw.overlayOpacity),
      overlayPosition: normalizeOverlayPosition(raw.overlayPosition),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function writeSettings(filePath: string, settings: MeterSettings): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}
