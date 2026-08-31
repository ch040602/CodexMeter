export type MeterLevel = 'normal' | 'warning' | 'danger' | 'unknown';
export type MeterStatus = 'ready' | 'waiting' | 'expired' | 'error';
export type OverlayMode = 'account' | 'local';
export type AccountTodayBasis = 'reset' | 'observed' | 'unavailable';
export type LocalShareBasis = 'account-token-usage' | 'recent-account-token-usage' | 'unavailable';

export interface AccountUsageBucket {
  startDate: string;
  tokens: number;
}

export interface AccountTokenUsage {
  dailyUsageBuckets: readonly AccountUsageBucket[];
}

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
  source: 'codex-local-status' | 'local-session-jsonl';
  planName: string | null;
  accountUsedPct: number | null;
  accountRemainingPct: number | null;
  accountObservedAt: number | null;
  accountTodayUsedPct: number | null;
  accountTodayBasis: AccountTodayBasis;
  accountTodayBaselineAt: number | null;
  resetAt: number | null;
  windowStart: number;
  exactWindow: boolean;
  local: LocalTotals;
  localToday: LocalTotals;
  localAccountSharePct: number | null;
  localAccountShareTodayPct: number | null;
  localShareBasis: LocalShareBasis;
  localShareReason: string;
  guardrailPct: number;
  guardrailExceeded: boolean;
  level: MeterLevel;
  filesIndexed: number;
  bytesRead: number;
}

export interface MeterSettings {
  guardrailPct: number;
  overlayVisible: boolean;
  overlayMode: OverlayMode;
  overlayOpacity: number;
  overlayPosition: OverlayPosition | null;
}

export const DEFAULT_SETTINGS: MeterSettings = {
  guardrailPct: 80,
  overlayVisible: false,
  overlayMode: 'account',
  overlayOpacity: 90,
  overlayPosition: null,
};

export interface MeterApi {
  getSnapshot(): Promise<MeterSnapshot>;
  getSettings(): Promise<MeterSettings>;
  setGuardrail(value: number): Promise<MeterSettings>;
  setOverlay(visible: boolean): Promise<MeterSettings>;
  setOverlayMode(mode: OverlayMode): Promise<MeterSettings>;
  setOverlayOpacity(value: number): Promise<MeterSettings>;
  refresh(): Promise<MeterSnapshot>;
  closeWindow(): Promise<void>;
  onUpdate(callback: (snapshot: MeterSnapshot, settings: MeterSettings) => void): () => void;
}
