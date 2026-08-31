import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  session,
  Tray,
} from 'electron';
import os from 'node:os';
import path from 'node:path';
import { CodexStatusClient } from './codexStatus';
import {
  DEFAULT_SETTINGS,
  type MeterLevel,
  type MeterSettings,
  type MeterSnapshot,
  type OverlayPosition,
} from './contracts';
import { LocalUsageScanner } from './scanner';
import { normalizeOverlayMode, normalizeOverlayOpacity, readSettings, writeSettings } from './settings';
import { buildSnapshot, normalizeGuardrail } from './usage';

const REFRESH_MS = 20_000;
const STANDARD_OVERLAY_SIZE = { width: 350, height: 166 } as const;
const MINIMAL_OVERLAY_SIZE = { width: 150, height: 48 } as const;
const roots = ['sessions', 'archived_sessions'].map(name => path.join(os.homedir(), '.codex', name));
const scanner = new LocalUsageScanner(roots);
const codexStatus = new CodexStatusClient();

let dashboard: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let refreshTimer: NodeJS.Timeout | null = null;
let refreshInFlight: Promise<MeterSnapshot> | null = null;
let settingsFile = '';
let settings: MeterSettings = { ...DEFAULT_SETTINGS };
let snapshot = buildSnapshot([], settings.guardrailPct);
let lastNotifiedReset: number | null = null;
let settingsWrite: Promise<void> = Promise.resolve();

function compactTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}%`;
}

function quotaPercent(value: number | null): string {
  if (value === null) return '계산 대기';
  if (value > 0 && value < 0.1) return '≈<0.1%';
  return `≈${Number.isInteger(value) ? value : value.toFixed(value < 1 ? 2 : 1)}%`;
}

function tokenSummary(value: number | null): string {
  return value === null ? '계산 대기' : `${compactTokens(value)} tokens`;
}

function todayPercent(snapshotValue: MeterSnapshot): string {
  if (snapshotValue.accountTodayUsedPct === null) return '측정 중';
  const value = Math.round(snapshotValue.accountTodayUsedPct * 10) / 10;
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${snapshotValue.accountTodayBasis === 'observed' ? '약 ' : ''}${formatted}%`;
}

const GLYPHS: Record<string, readonly number[]> = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b010, 0b010, 0b010],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  '?': [0b111, 0b001, 0b010, 0b000, 0b010],
};

function paintPixel(buffer: Buffer, size: number, x: number, y: number, color: readonly [number, number, number]): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const offset = (y * size + x) * 4;
  buffer[offset] = color[2];
  buffer[offset + 1] = color[1];
  buffer[offset + 2] = color[0];
  buffer[offset + 3] = 255;
}

function meterIcon(level: MeterLevel, remainingPct: number | null) {
  const color: readonly [number, number, number] = level === 'danger'
    ? [226, 74, 74]
    : level === 'warning'
      ? [217, 154, 53]
      : level === 'normal'
        ? [105, 169, 129]
        : [138, 144, 153];
  const label = remainingPct === null ? '?' : String(Math.round(Math.max(0, Math.min(100, remainingPct))));
  const size = 20;
  const buffer = Buffer.alloc(size * size * 4);
  const background: readonly [number, number, number] = [17, 19, 21];
  const foreground: readonly [number, number, number] = [244, 246, 247];
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      if ((x === 1 || x === size - 2) && (y === 1 || y === size - 2)) continue;
      const edge = x < 3 || x >= size - 3 || y < 3 || y >= size - 3;
      paintPixel(buffer, size, x, y, edge ? color : background);
    }
  }
  const scale = label.length >= 3 ? 1 : 2;
  const gap = scale;
  const textWidth = label.length * 3 * scale + (label.length - 1) * gap;
  const startX = Math.floor((size - textWidth) / 2);
  const startY = Math.floor((size - 5 * scale) / 2);
  [...label].forEach((character, characterIndex) => {
    const glyph = GLYPHS[character] ?? GLYPHS['?'];
    glyph.forEach((row, rowIndex) => {
      for (let column = 0; column < 3; column += 1) {
        if ((row & (1 << (2 - column))) === 0) continue;
        for (let offsetY = 0; offsetY < scale; offsetY += 1) {
          for (let offsetX = 0; offsetX < scale; offsetX += 1) {
            paintPixel(
              buffer,
              size,
              startX + characterIndex * (3 * scale + gap) + column * scale + offsetX,
              startY + rowIndex * scale + offsetY,
              foreground,
            );
          }
        }
      }
    });
  });
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

function secureWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
}

function queueSettingsWrite(): Promise<void> {
  const value: MeterSettings = {
    ...settings,
    overlayPosition: settings.overlayPosition ? { ...settings.overlayPosition } : null,
  };
  const pending = settingsWrite
    .catch(() => undefined)
    .then(() => writeSettings(settingsFile, value));
  settingsWrite = pending;
  return pending;
}

function overlaySize(mode: MeterSettings['overlayMode']): Readonly<{ width: number; height: number }> {
  return mode === 'minimal' ? MINIMAL_OVERLAY_SIZE : STANDARD_OVERLAY_SIZE;
}

function resolvedOverlayPosition(
  size: Readonly<{ width: number; height: number }>,
  requested: OverlayPosition | null = settings.overlayPosition,
): OverlayPosition {
  const display = requested
    ? screen.getDisplayNearestPoint(requested)
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const maxX = Math.max(area.x, area.x + area.width - size.width);
  const maxY = Math.max(area.y, area.y + area.height - size.height);
  if (!requested) return { x: Math.max(area.x, maxX - 16), y: Math.min(maxY, area.y + 16) };
  return {
    x: Math.max(area.x, Math.min(maxX, requested.x)),
    y: Math.max(area.y, Math.min(maxY, requested.y)),
  };
}

function createDashboard(): BrowserWindow {
  const window = new BrowserWindow({
    width: 450,
    height: 760,
    minWidth: 410,
    minHeight: 650,
    show: false,
    title: 'Codex Meter',
    backgroundColor: '#111315',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  secureWindow(window);
  void window.loadFile(path.join(__dirname, '..', 'ui', 'index.html'), {
    query: { mode: 'dashboard' },
  });
  window.once('ready-to-show', () => {
    rebuildTray();
    window.show();
  });
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  return window;
}

function createOverlay(): BrowserWindow {
  const size = overlaySize(settings.overlayMode);
  const position = resolvedOverlayPosition(size);
  const window = new BrowserWindow({
    ...position,
    ...size,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    backgroundColor: '#111315',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  secureWindow(window);
  window.setOpacity(settings.overlayOpacity / 100);
  window.setAlwaysOnTop(true, 'floating');
  void window.loadFile(path.join(__dirname, '..', 'ui', 'index.html'), {
    query: { mode: 'overlay' },
  });
  window.once('ready-to-show', () => window.showInactive());
  let positionSaveTimer: NodeJS.Timeout | null = null;
  const savePosition = (): void => {
    positionSaveTimer = null;
    if (window.isDestroyed()) return;
    const [x, y] = window.getPosition();
    if (settings.overlayPosition?.x === x && settings.overlayPosition.y === y) return;
    settings = { ...settings, overlayPosition: { x, y } };
    void queueSettingsWrite().catch(error => console.error('오버레이 위치를 저장하지 못했습니다.', error));
  };
  window.on('move', () => {
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(savePosition, 200);
  });
  window.on('closed', () => {
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
  });
  return window;
}

function resizeOverlay(window: BrowserWindow, mode: MeterSettings['overlayMode']): void {
  const size = overlaySize(mode);
  const [x, y] = window.getPosition();
  const position = resolvedOverlayPosition(size, { x, y });
  window.setBounds({ ...position, ...size });
}

function sendState(): void {
  for (const window of [dashboard, overlay]) {
    if (window && !window.isDestroyed()) window.webContents.send('meter:update', snapshot, settings);
  }
}

function trayTooltip(): string {
  const accountSource = snapshot.source === 'codex-local-status' ? 'Codex 로컬 상태' : '세션 기록 대체값';
  return [
    'Codex Meter',
    `계정 이번 주 (${accountSource}): 남음 ${percent(snapshot.accountRemainingPct)} · 사용 ${percent(snapshot.accountUsedPct)}`,
    `계정 총량 중 오늘: ${todayPercent(snapshot)}`,
    `계정 토큰 이번 주: ${tokenSummary(snapshot.accountWindowTokens)} · 추정 주간 절대 한도 ${tokenSummary(snapshot.accountWeeklyLimitTokens)}`,
    `계정 사용 중 이 PC 비중: 오늘 ${quotaPercent(snapshot.localAccountUsageShareTodayPct)} · 이번 주 ${quotaPercent(snapshot.localAccountUsageSharePct)}`,
    `이 PC 요금제 추정 사용: 오늘 ${quotaPercent(snapshot.localQuotaUsedTodayPct)} · 이번 주 ${quotaPercent(snapshot.localQuotaUsedPct)}`,
    `이 PC 오늘: ${compactTokens(snapshot.localToday.tokens)} tokens · ${snapshot.localToday.requests.toLocaleString('ko-KR')} requests`,
    `이 PC 이번 주: ${compactTokens(snapshot.local.tokens)} tokens · ${snapshot.local.requests.toLocaleString('ko-KR')} requests`,
    `경고선: 계정 사용 ${settings.guardrailPct}%`,
  ].join('\n');
}

function rebuildTray(): void {
  if (!tray) return;
  const statusIcon = meterIcon(snapshot.level, snapshot.accountRemainingPct);
  const remaining = percent(snapshot.accountRemainingPct);
  const used = percent(snapshot.accountUsedPct);
  const local = compactTokens(snapshot.local.tokens);
  const title = `Codex Meter · 계정 ${remaining} 남음 · 이 PC ${local}`;
  tray.setImage(statusIcon);
  tray.setToolTip(trayTooltip());
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.setTitle(title);
    if (process.platform === 'win32') dashboard.setOverlayIcon(statusIcon, `Codex 계정 ${remaining} 남음`);
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `계정 남음 ${remaining} · 사용 ${used}`, click: () => dashboard?.show() },
    { label: `계정 총량 중 오늘 ${todayPercent(snapshot)}`, click: () => dashboard?.show() },
    {
      label: `계정 토큰 이번 주 ${tokenSummary(snapshot.accountWindowTokens)} · 추정 주간 절대 한도 ${tokenSummary(snapshot.accountWeeklyLimitTokens)}`,
      click: () => dashboard?.show(),
    },
    {
      label: `계정 사용 중 이 PC 비중 · 오늘 ${quotaPercent(snapshot.localAccountUsageShareTodayPct)} · 이번 주 ${quotaPercent(snapshot.localAccountUsageSharePct)}`,
      click: () => dashboard?.show(),
    },
    {
      label: `이 PC 요금제 추정 사용 · 오늘 ${quotaPercent(snapshot.localQuotaUsedTodayPct)} · 이번 주 ${quotaPercent(snapshot.localQuotaUsedPct)}`,
      click: () => dashboard?.show(),
    },
    {
      label: `이 PC 오늘 ${compactTokens(snapshot.localToday.tokens)} tokens · ${snapshot.localToday.requests.toLocaleString('ko-KR')} requests`,
      click: () => dashboard?.show(),
    },
    {
      label: `이 PC 이번 주 ${local} tokens · ${snapshot.local.requests.toLocaleString('ko-KR')} requests`,
      click: () => dashboard?.show(),
    },
    { type: 'separator' },
    { label: '상세 사용량 열기', click: () => dashboard?.show() },
    {
      label: '오버레이',
      type: 'checkbox',
      checked: settings.overlayVisible,
      click: item => void setOverlay(item.checked),
    },
    { label: '지금 새로고침', click: () => void refresh() },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } },
  ]));
}

function notifyIfNeeded(): void {
  if (!snapshot.guardrailExceeded || snapshot.resetAt === null || snapshot.resetAt === lastNotifiedReset) return;
  lastNotifiedReset = snapshot.resetAt;
  if (Notification.isSupported()) {
    new Notification({
      title: 'Codex 주간 경고선 도달',
      body: `계정 사용 ${percent(snapshot.accountUsedPct)} · 남음 ${percent(snapshot.accountRemainingPct)} · 경고선 ${settings.guardrailPct}%`,
      silent: false,
    }).show();
  }
}

async function refresh(): Promise<MeterSnapshot> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = Promise.all([
    codexStatus.readWeeklyLimit(),
    codexStatus.readTokenUsage(),
  ])
    .then(([accountRateLimit, accountTokenUsage]) => scanner.scan(settings.guardrailPct, Date.now(), accountRateLimit, accountTokenUsage))
    .catch(error => buildSnapshot([], settings.guardrailPct, Date.now(), {
      error: error instanceof Error ? error.message : '로컬 세션을 읽지 못했습니다.',
    }))
    .then(next => {
      snapshot = next;
      sendState();
      rebuildTray();
      notifyIfNeeded();
      return snapshot;
    })
    .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function persistSettings(): Promise<void> {
  await queueSettingsWrite();
  rebuildTray();
  sendState();
}

async function setOverlay(visible: boolean): Promise<MeterSettings> {
  settings = { ...settings, overlayVisible: visible };
  if (visible) {
    overlay ??= createOverlay();
    overlay.showInactive();
  } else if (overlay) {
    overlay.destroy();
    overlay = null;
  }
  await persistSettings();
  return settings;
}

async function setOverlayOpacity(value: unknown): Promise<MeterSettings> {
  settings = { ...settings, overlayOpacity: normalizeOverlayOpacity(value) };
  if (overlay && !overlay.isDestroyed()) overlay.setOpacity(settings.overlayOpacity / 100);
  await persistSettings();
  return settings;
}

async function setOverlayMode(value: unknown): Promise<MeterSettings> {
  const overlayMode = normalizeOverlayMode(value);
  settings = { ...settings, overlayMode };
  if (overlay && !overlay.isDestroyed()) resizeOverlay(overlay, overlayMode);
  await persistSettings();
  return settings;
}

function installIpc(): void {
  ipcMain.handle('meter:get-snapshot', () => snapshot);
  ipcMain.handle('meter:get-settings', () => settings);
  ipcMain.handle('meter:refresh', () => refresh());
  ipcMain.handle('meter:set-guardrail', async (_event, value: unknown) => {
    settings = { ...settings, guardrailPct: normalizeGuardrail(value) };
    await persistSettings();
    await refresh();
    return settings;
  });
  ipcMain.handle('meter:set-overlay', (_event, visible: unknown) => setOverlay(visible === true));
  ipcMain.handle('meter:set-overlay-mode', (_event, value: unknown) => setOverlayMode(value));
  ipcMain.handle('meter:set-overlay-opacity', (_event, value: unknown) => setOverlayOpacity(value));
  ipcMain.handle('meter:close-window', event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === overlay) return setOverlay(false).then(() => undefined);
    window?.hide();
  });
}

async function start(): Promise<void> {
  app.setAppUserModelId('local.codex.meter');
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  settings = await readSettings(settingsFile);
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  );
  installIpc();
  dashboard = createDashboard();
  tray = new Tray(meterIcon('unknown', null));
  tray.on('click', () => {
    if (!dashboard) return;
    if (dashboard.isVisible()) dashboard.hide();
    else dashboard.show();
  });
  if (settings.overlayVisible) overlay = createOverlay();
  rebuildTray();
  await refresh();
  refreshTimer = setInterval(() => void refresh(), REFRESH_MS);
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => dashboard?.show());
  app.whenReady().then(start).catch(error => {
    console.error(error);
    app.quit();
  });
}

app.on('before-quit', () => {
  quitting = true;
  if (refreshTimer) clearInterval(refreshTimer);
  codexStatus.close();
});

app.on('window-all-closed', () => {
  // The tray owns the application lifetime on Windows.
});
