const api = window.meter;
const mode = new URLSearchParams(location.search).get('mode') === 'overlay' ? 'overlay' : 'dashboard';
const $ = id => document.getElementById(id);

$(mode).hidden = false;

function compactNumber(value) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

function dateTime(value) {
  if (!value) return '초기화 시각 대기';
  const date = new Date(value);
  return `${date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 초기화`;
}

function shortReset(value) {
  if (!value) return '초기화 대기';
  return `${new Date(value).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })} 초기화`;
}

function ago(value) {
  if (!value) return '세션 대기';
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60_000));
  if (minutes < 1) return '방금 확인';
  if (minutes < 60) return `${minutes}분 전 확인`;
  return `${Math.floor(minutes / 60)}시간 전 확인`;
}

function setProgress(fill, marker, used, guardrail) {
  fill.style.width = `${Math.max(0, Math.min(100, used ?? 0))}%`;
  marker.style.left = `${Math.max(1, Math.min(99, guardrail))}%`;
}

function todayPercent(snapshot) {
  if (snapshot.accountTodayUsedPct === null) return null;
  const value = Math.round(snapshot.accountTodayUsedPct * 10) / 10;
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${snapshot.accountTodayBasis === 'observed' ? '≈' : ''}${formatted}%`;
}

function localQuotaPercent(snapshot, today = false) {
  const value = today ? snapshot.localQuotaUsedTodayPct : snapshot.localQuotaUsedPct;
  if (value === null) return null;
  if (value > 0 && value < 0.1) return '≈<0.1%';
  return `≈${Number.isInteger(value) ? value : value.toFixed(value < 1 ? 2 : 1)}%`;
}

function accountUsageSharePercent(snapshot, today = false) {
  const value = today ? snapshot.localAccountUsageShareTodayPct : snapshot.localAccountUsageSharePct;
  if (value === null) return null;
  if (value > 0 && value < 0.1) return '≈<0.1%';
  return `≈${Number.isInteger(value) ? value : value.toFixed(value < 1 ? 2 : 1)}%`;
}

function tokenSummary(value) {
  return value === null ? '계산 대기' : `${compactNumber(value)} tokens`;
}

function renderDashboard(snapshot, settings) {
  const remaining = snapshot.accountRemainingPct === null ? '—' : `${Math.round(snapshot.accountRemainingPct)}%`;
  document.title = `Codex Meter · 계정 ${remaining} 남음 · 이 PC ${compactNumber(snapshot.local.tokens)}`;
  $('accountUsed').textContent = snapshot.accountUsedPct === null ? '—' : `${Math.round(snapshot.accountUsedPct)}%`;
  $('accountTodayUsed').textContent = todayPercent(snapshot) ?? '—';
  $('accountTodayUsed').title = snapshot.accountTodayBasis === 'reset'
    ? '오늘 시작된 주간 제한 창의 0%부터 계산한 값입니다.'
    : snapshot.accountTodayBasis === 'observed'
      ? '자정 직전 로컬 관측값을 기준으로 계산한 근사값입니다.'
      : '오늘 시작 기준값이 없어 아직 계산할 수 없습니다.';
  $('accountRemaining').textContent = remaining;
  $('accountQuota').textContent = `계정 토큰 이번 주 ${tokenSummary(snapshot.accountWindowTokens)} · 추정 주간 절대 한도 ${tokenSummary(snapshot.accountWeeklyLimitTokens)}`;
  $('accountQuota').title = snapshot.accountQuotaReason;
  const accountSource = snapshot.source === 'codex-local-status' ? '로컬 상태' : '세션 기록';
  $('plan').textContent = snapshot.planName ? `Codex ${snapshot.planName} · ${accountSource}` : snapshot.statusDetail;
  $('freshness').textContent = ago(snapshot.accountObservedAt);
  $('resetAt').textContent = dateTime(snapshot.resetAt);
  $('guardrailCaption').textContent = `경고 ${settings.guardrailPct}%`;
  setProgress($('accountFill'), $('guardrailMarker'), snapshot.accountUsedPct, settings.guardrailPct);
  $('localTokens').textContent = compactNumber(snapshot.local.tokens);
  $('localRequests').textContent = snapshot.local.requests.toLocaleString('ko-KR');
  $('localAccountUsageShareWeek').textContent = accountUsageSharePercent(snapshot) ?? '계산 대기';
  $('localAccountUsageShareToday').textContent = accountUsageSharePercent(snapshot, true) ?? '계산 대기';
  $('localQuotaToday').textContent = localQuotaPercent(snapshot, true) ?? '—';
  $('localQuotaWeek').textContent = localQuotaPercent(snapshot) ?? '—';
  $('localAccountUsageShareWeek').title = snapshot.accountUsageShareReason;
  $('localAccountUsageShareToday').title = snapshot.accountUsageShareReason;
  $('localQuotaToday').title = snapshot.accountQuotaReason;
  $('localQuotaWeek').title = snapshot.accountQuotaReason;
  $('windowLabel').textContent = snapshot.exactWindow ? '계정 제한 창과 동일한 7일' : '정확한 제한 창 대기 · 최근 7일';
  $('quotaNote').textContent = snapshot.accountQuotaReason;
  $('guardrailRange').value = String(settings.guardrailPct);
  $('guardrailNumber').value = String(settings.guardrailPct);
  $('overlayMode').value = settings.overlayMode;
  $('overlayOpacityRange').value = String(settings.overlayOpacity);
  $('overlayOpacityValue').textContent = `${settings.overlayOpacity}%`;
  $('overlayToggle').textContent = settings.overlayVisible ? '오버레이 끄기' : '오버레이 켜기';
  $('sourceStatus').textContent = snapshot.status === 'ready'
    ? snapshot.source === 'codex-local-status'
      ? 'Codex 로컬 상태 · JSONL 처리량'
      : '세션 JSONL 대체값'
    : snapshot.statusDetail;
  $('scanStats').textContent = `${snapshot.filesIndexed} files · ${compactNumber(snapshot.bytesRead)}B read`;
}

function renderOverlay(snapshot, settings) {
  const dailyPct = todayPercent(snapshot);
  const localTodayPct = localQuotaPercent(snapshot, true);
  const localWeekPct = localQuotaPercent(snapshot);
  const accountShareTodayPct = accountUsageSharePercent(snapshot, true);
  const accountShareWeekPct = accountUsageSharePercent(snapshot);
  const remaining = snapshot.accountRemainingPct === null ? '—' : `${Math.round(snapshot.accountRemainingPct)}%`;
  const used = snapshot.accountUsedPct === null ? '—' : `${Math.round(snapshot.accountUsedPct)}%`;
  $('overlay').classList.toggle('overlay-minimal', settings.overlayMode === 'minimal');
  if (settings.overlayMode === 'minimal') {
    $('overlayAccount').textContent = remaining;
    $('overlayLocal').textContent = localWeekPct ?? '—';
    $('overlayAccount').title = 'Codex 계정 주간 잔여율';
    $('overlayLocal').title = `${snapshot.accountQuotaReason} ${snapshot.accountUsageShareReason}`;
    $('overlayTrack').hidden = true;
    return;
  }
  if (settings.overlayMode === 'local') {
    $('overlayAccount').textContent = localTodayPct ?? '—';
    $('overlayAccountMeta').textContent = '이 PC 요금제 추정 · 오늘';
    $('overlayLocal').textContent = localWeekPct ?? '—';
    $('overlayLocalMeta').textContent = '이 PC 요금제 추정 · 이번 주';
    $('overlayAccount').title = `${snapshot.accountQuotaReason} ${snapshot.accountUsageShareReason}`;
    $('overlayLocal').title = `${snapshot.accountQuotaReason} ${snapshot.accountUsageShareReason}`;
    $('overlayTrack').hidden = true;
    $('overlayStatus').textContent = `이 PC 요금제 추정 · 오늘 ${localTodayPct ?? '측정 중'} · 계정 비중 ${accountShareTodayPct ?? '측정 중'}`;
    $('overlayGuardrail').textContent = `요금제 이번 주 ${localWeekPct ?? '측정 중'} · 계정 비중 ${accountShareWeekPct ?? '측정 중'} · 요청 오늘 ${snapshot.localToday.requests.toLocaleString('ko-KR')}회 · 주간 ${snapshot.local.requests.toLocaleString('ko-KR')}회`;
    return;
  }

  $('overlayAccount').textContent = remaining;
  $('overlayAccountMeta').textContent = `계정 잔여 · 오늘 사용 ${dailyPct ?? '측정 중'}`;
  $('overlayLocal').textContent = localWeekPct ?? '—';
  $('overlayLocalMeta').textContent = '이 PC 요금제 추정 · 이번 주';
  $('overlayAccount').title = 'Codex 계정 주간 잔여율';
  $('overlayLocal').title = `${snapshot.accountQuotaReason} ${snapshot.accountUsageShareReason}`;
  $('overlayTrack').hidden = false;
  $('overlayStatus').textContent = snapshot.guardrailExceeded
    ? `사용 ${used} · 경고선 도달`
    : `사용 ${used} · ${shortReset(snapshot.resetAt)}`;
  $('overlayGuardrail').textContent = `이 PC 요금제 오늘 ${localTodayPct ?? '측정 중'} · 계정 비중 이번 주 ${accountShareWeekPct ?? '측정 중'} · 경고 ${settings.guardrailPct}%`;
  setProgress($('overlayFill'), $('overlayMarker'), snapshot.accountUsedPct, settings.guardrailPct);
}

function render(snapshot, settings) {
  document.documentElement.dataset.level = snapshot.level;
  if (mode === 'overlay') renderOverlay(snapshot, settings);
  else renderDashboard(snapshot, settings);
}

async function boot() {
  const [snapshot, settings] = await Promise.all([api.getSnapshot(), api.getSettings()]);
  render(snapshot, settings);
  api.onUpdate(render);
}

if (mode === 'dashboard') {
  const commitGuardrail = async value => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    await api.setGuardrail(numeric);
  };
  $('guardrailRange').addEventListener('input', event => { $('guardrailNumber').value = event.target.value; });
  $('guardrailRange').addEventListener('change', event => void commitGuardrail(event.target.value));
  $('guardrailNumber').addEventListener('change', event => {
    $('guardrailRange').value = event.target.value;
    void commitGuardrail(event.target.value);
  });
  let opacityCommitTimer;
  const commitOpacity = value => {
    if (opacityCommitTimer) clearTimeout(opacityCommitTimer);
    opacityCommitTimer = undefined;
    void api.setOverlayOpacity(Number(value));
  };
  $('overlayOpacityRange').addEventListener('input', event => {
    $('overlayOpacityValue').textContent = `${event.target.value}%`;
    if (opacityCommitTimer) clearTimeout(opacityCommitTimer);
    opacityCommitTimer = setTimeout(() => commitOpacity(event.target.value), 80);
  });
  $('overlayOpacityRange').addEventListener('change', event => commitOpacity(event.target.value));
  $('overlayMode').addEventListener('change', event => void api.setOverlayMode(event.target.value));
  $('overlayToggle').addEventListener('click', async () => {
    const current = await api.getSettings();
    await api.setOverlay(!current.overlayVisible);
  });
  $('refresh').addEventListener('click', () => void api.refresh());
  $('closeDashboard').addEventListener('click', () => void api.closeWindow());
} else {
  $('closeOverlay').addEventListener('click', () => void api.closeWindow());
}

void boot();
