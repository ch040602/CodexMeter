export type MeterLevel = 'normal' | 'warning' | 'danger' | 'unknown';
export type MeterStatus = 'ready' | 'waiting' | 'expired' | 'error';
export type OverlayMode = 'account' | 'local' | 'minimal';
export type AccountTodayBasis = 'reset' | 'observed' | 'unavailable';
export type AccountQuotaBasis = 'inferred' | 'unavailable';
export type AccountTokenBasis = 'current-window' | 'recent-estimate' | 'unavailable';

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

export interface CodexConnectionDiagnostics {
  binaryPath: string | null;
  codexHome: string;
  rateLimitError: string | null;
  tokenUsageError: string | null;
}

export interface MeterSnapshot {
  connection: CodexConnectionDiagnostics | null;
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
  localAccountUsageSharePct: number | null;
  localAccountUsageShareTodayPct: number | null;
  accountUsageShareReason: string;
  accountTokenBasis: AccountTokenBasis;
  accountWindowTokens: number | null;
  accountWeeklyLimitTokens: number | null;
  localQuotaUsedPct: number | null;
  localQuotaUsedTodayPct: number | null;
  accountQuotaBasis: AccountQuotaBasis;
  accountQuotaReason: string;
  guardrailPct: number;
  /** Warning state derived from this PC's inferred plan usage, not accountUsedPct. */
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
