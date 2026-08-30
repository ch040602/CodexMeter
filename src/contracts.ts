export type MeterLevel = 'normal' | 'warning' | 'danger' | 'unknown';
export type MeterStatus = 'ready' | 'waiting' | 'expired' | 'error';

export interface LocalTotals {
  tokens: number;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface OverlayPosition {
  x: number;
  y: number;
}

export interface MeterSnapshot {
  generatedAt: number;
  status: MeterStatus;
  statusDetail: string;
  source: 'local-session-jsonl';
  planName: string | null;
  accountUsedPct: number | null;
  accountRemainingPct: number | null;
  accountObservedAt: number | null;
  resetAt: number | null;
  windowStart: number;
  exactWindow: boolean;
  local: LocalTotals;
  localCapacityPct: null;
  localCapacityReason: string;
  guardrailPct: number;
  guardrailExceeded: boolean;
  level: MeterLevel;
  filesIndexed: number;
  bytesRead: number;
}

export interface MeterSettings {
  guardrailPct: number;
  overlayVisible: boolean;
  overlayOpacity: number;
  overlayPosition: OverlayPosition | null;
}

export const DEFAULT_SETTINGS: MeterSettings = {
  guardrailPct: 80,
  overlayVisible: false,
  overlayOpacity: 90,
  overlayPosition: null,
};

export interface MeterApi {
  getSnapshot(): Promise<MeterSnapshot>;
  getSettings(): Promise<MeterSettings>;
  setGuardrail(value: number): Promise<MeterSettings>;
  setOverlay(visible: boolean): Promise<MeterSettings>;
  setOverlayOpacity(value: number): Promise<MeterSettings>;
  refresh(): Promise<MeterSnapshot>;
  closeWindow(): Promise<void>;
  onUpdate(callback: (snapshot: MeterSnapshot, settings: MeterSettings) => void): () => void;
}
