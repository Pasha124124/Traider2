const state = {
  market: null,
  analysis: null,
  forecasts: [],
  history: [],
  news: [],
  scorecard: null,
  range: '1H',
  view: 'overview',
  historyFilter: 'all',
  refreshTimer: null,
  chartHorizon: null,
  trading: { side: 'buy', kind: 'market' },
  chart: { data: [], min: 0, max: 1, width: 900, height: 340 },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const fmtPrice = (value, decimals = 2) => Number(value || 0).toLocaleString('ru-RU', { minimumFractionDigits: decimals === 0 ? 0 : 2, maximumFractionDigits: decimals });
const fmtSigned = (value, digits = 2) => `${value > 0 ? '+' : ''}${Number(value || 0).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const fmtRub = (value, digits = 2) => `${Number(value || 0).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ₽`;
const fmtGrams = (value) => `${Number(value || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} г`;
const actionName = (action) => ({ long: 'ЛОНГ', short: 'ШОРТ*', wait: 'ЖДАТЬ' })[action] || 'ЖДАТЬ';
const actionTitle = (action) => ({ long: 'ПОКУПАТЬ', short: 'ПРОДАВАТЬ', wait: 'НЕ ВХОДИТЬ' })[action] || 'НЕ ВХОДИТЬ';
const trendName = (trend) => ({ bullish: 'Восходящий уклон', bearish: 'Нисходящий уклон', neutral: 'Боковой / неясный' })[trend] || 'Нейтрально';

function notify(message, type = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $('#toast-region').append(toast);
  setTimeout(() => toast.remove(), 4300);
}

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function setLoading(button, loading, text = 'Загрузка…') {
  if (!button) return;
  if (loading) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = text;
  } else {
    button.disabled = false;
    if (button.dataset.originalText) button.textContent = button.dataset.originalText;
  }
}

function timeAgo(date) {
  if (!date) return '—';
  const difference = Math.max(0, Date.now() - new Date(date).getTime());
  if (!Number.isFinite(difference)) return '—';
  if (difference < 60_000) return 'сейчас';
  const minutes = Math.floor(difference / 60_000);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} дн назад`;
}

function setMarketState(provider, error = false, dataStatus = null) {
  const dot = $('#market-dot');
  const isLive = provider === 't-invest' && dataStatus === 'live-stream';
  dot.className = `status-dot ${error ? 'error' : isLive ? 'live' : 'demo'}`;
  $('#market-status-text').textContent = error ? 'ОШИБКА ДАННЫХ' : isLive ? 'LIVE' : provider ? 'РЕАЛЬНЫЕ ДАННЫЕ' : 'НЕТ ДАННЫХ';
}

async function loadMarket({ quiet = false } = {}) {
  try {
    const data = await api('/api/market');
    state.market = data.market;
    state.analysis = data.analysis;
    const HORIZON_MS = { '15m': 15 * 60_000, '1h': 3_600_000, '4h': 4 * 3_600_000, '1d': 86_400_000, '1w': 7 * 86_400_000, '1M': 30 * 86_400_000 };
    state.forecasts = (data.analysis?.forecasts || []).map((f) => ({
      ...f,
      expiresAt: f.expiresAt || (f.createdAt && HORIZON_MS[f.horizon] ? new Date(new Date(f.createdAt).getTime() + HORIZON_MS[f.horizon]).toISOString() : null),
    }));
    state.history = data.forecasts || [];
    state.news = data.news || [];
    state.scorecard = data.scorecard;
    renderAll(data.settings);
  } catch (error) {
    $('#global-alert').textContent = error.message;
    $('#global-alert').classList.remove('hidden');
    setMarketState(null, true);
  }
}

function renderAll(config) {
  renderMarket(state.market);
  renderActionCard();
  if (state.analysis) renderFactors(state.analysis.factors || []);
  renderForecasts(state.forecasts);
  renderHistory(state.history, state.scorecard);
  renderNewsPreview(state.news);
  renderConfig(config);
  setMarketState(state.market?.provider, false, state.market?.dataStatus);
  $('#history-count').textContent = String(state.history.length);
}

// ============ ГЛАВНАЯ КАРТОЧКА «ЧТО ДЕЛАТЬ СЕЙЧАС» ============

function bestForecast() {
  if (!state.forecasts?.length) return null;
  const actionable = state.forecasts.filter((f) => f.action !== 'wait')
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  return actionable[0] || state.forecasts.find((f) => f.horizon === '1h') || state.forecasts[0];
}

function renderActionCard() {
  const card = $('#action-card');
  const forecast = bestForecast();
  const icon = $('#action-icon');
  if (!forecast) {
    icon.className = 'action-icon wait';
    icon.textContent = '…';
    $('#action-title').textContent = 'Данных пока нет';
    $('#action-sub').textContent = 'нажмите «Обновить»';
    return;
  }
  const action = forecast.action;
  icon.className = `action-icon ${action}`;
  icon.textContent = action === 'long' ? '↑' : action === 'short' ? '↓' : '⏸';
  $('#action-title').textContent = actionTitle(action);
  $('#action-sub').textContent = `${forecast.horizonLabel} · ${actionName(action)}`;
  if (action !== 'wait') {
    $('#lv-entry').textContent = `${fmtPrice(forecast.entryLow)}–${fmtPrice(forecast.entryHigh)}`;
    $('#lv-stop').textContent = fmtPrice(forecast.stop);
    $('#lv-target').textContent = fmtPrice(forecast.target1);
    $('#lv-target2').textContent = fmtPrice(forecast.target2);
    $('#lv-until').textContent = forecast.expiresAt ? new Date(forecast.expiresAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    $('#lv-conf').textContent = `${forecast.confidence}%`;
    $('#action-why').textContent = forecast.rationale || '';
  } else {
    $('#lv-entry').textContent = fmtPrice(forecast.entryLow ?? forecast.entry);
    $('#lv-stop').textContent = fmtPrice(forecast.stop);
    $('#lv-target').textContent = fmtPrice(forecast.target1);
    $('#lv-target2').textContent = fmtPrice(forecast.target2);
    $('#lv-until').textContent = forecast.expiresAt ? new Date(forecast.expiresAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    $('#lv-conf').textContent = `${forecast.confidence}%`;
    $('#action-why').textContent = forecast.rationale || 'Сигнал неубедительный — вне зоны входа не заходить.';
  }
  const plan = Array.isArray(forecast.plan) ? forecast.plan.slice(0, 4) : [];
  $('#action-plan').innerHTML = plan.map((step) => `<div class="plan-step"><span class="plan-when">${esc(step.when)}</span><span class="plan-what">${esc(step.what)}${step.why ? ` <span style="color:#a8b3aa">— ${esc(step.why)}</span>` : ''}</span></div>`).join('');
  state.chartHorizon = forecast.horizon;
  if (state.market) drawChart(state.market.candles, state.range);
}

// ============ ИНТЕРАКТИВНЫЙ ГРАФИК ============

function renderMarket(market) {
  if (!market) return;
  const quote = market.quote || {};
  const candles = market.candles || [];
  const last = Number(quote.last || candles.at(-1)?.close || 0);
  const opening = Number(quote.open || candles[0]?.open || last);
  const change = Number(quote.change ?? (last - opening));
  const changePct = opening ? change / opening * 100 : 0;
  $('#current-price').textContent = last ? fmtPrice(last) : '—';
  const chip = $('#daily-change');
  chip.className = `change-chip ${change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral'}`;
  chip.textContent = `${fmtSigned(change, 2)} ₽ · ${fmtSigned(changePct, 2)}%`;
  const stamp = quote.updatedAt || market.fetchedAt;
  $('#quote-updated').textContent = stamp ? timeAgo(stamp) : '—';
  $('#quote-source').textContent = market.provider === 't-invest' ? 'T‑Инвестиции' : market.provider === 'moex-iss' ? 'MOEX ISS' : market.provider;
  drawChart(candles, state.range);
}

function drawChart(candles, range = state.range) {
  const svg = $('#price-chart');
  if (!svg) return;
  const intervals = { '1H': 60, '4H': 240, '1D': 1440, '1W': 10_080 };
  const maxPoints = intervals[range] || 60;
  let data = candles.slice(-Math.min(maxPoints, candles.length));
  if (data.length > 260) data = downsampleCandles(data, Math.ceil(data.length / 260));
  if (data.length < 2) {
    svg.innerHTML = '<text x="450" y="170" fill="#98a099" text-anchor="middle" font-size="13">Недостаточно данных для графика</text>';
    return;
  }
  const forecast = currentForecast();
  const closes = data.map((item) => Number(item.close));
  let low = Math.min(...data.map((item) => Number(item.low)));
  let high = Math.max(...data.map((item) => Number(item.high)));
  if (forecast && forecast.action !== 'wait') {
    low = Math.min(low, Number(forecast.stop), Number(forecast.target1), Number(forecast.target2));
    high = Math.max(high, Number(forecast.stop), Number(forecast.target1), Number(forecast.target2));
  }
  const spread = Math.max(high - low, high * 0.001, 1);
  const min = low - spread * 0.1;
  const max = high + spread * 0.1;
  const width = 900;
  const height = 340;
  const padRight = 62;
  const plotW = width - padRight;
  const volumeHeight = 34;
  const priceHeight = height - volumeHeight - 6;
  const x = (index) => (index / (data.length - 1)) * plotW;
  const y = (price) => priceHeight - ((price - min) / (max - min)) * priceHeight;
  state.chart = { data, min, max, width, height, plotW, priceHeight, x, y };

  const gridLines = 5;
  const grid = Array.from({ length: gridLines }, (_, i) => {
    const value = min + ((max - min) * i) / (gridLines - 1);
    const yy = y(value).toFixed(1);
    return `<line class="chart-grid-line" x1="0" y1="${yy}" x2="${plotW}" y2="${yy}"/><text class="price-scale" x="${plotW + 6}" y="${Number(yy) + 3}">${fmtPrice(value)}</text>`;
  }).join('');

  const bodyWidth = Math.max(2, Math.min(10, (plotW * 0.7) / data.length));
  const candlesMarkup = data.map((item, index) => {
    const cx = x(index);
    const up = Number(item.close) >= Number(item.open);
    const cls = up ? 'up' : 'down';
    const bodyTop = y(Math.max(Number(item.open), Number(item.close)));
    const bodyBottom = y(Math.min(Number(item.open), Number(item.close)));
    const bodyH = Math.max(1, bodyBottom - bodyTop);
    return `<line class="candle-wick" x1="${cx.toFixed(1)}" y1="${y(Number(item.high)).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(Number(item.low)).toFixed(1)}"/>`
      + `<rect class="candle-body ${cls}" x="${(cx - bodyWidth / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bodyWidth.toFixed(1)}" height="${bodyH.toFixed(1)}"/>`;
  }).join('');

  const volumes = data.map((item) => Number(item.volume || 0));
  const maxVolume = Math.max(...volumes, 1);
  const volumeBars = data.map((item, index) => {
    const vh = (Number(item.volume || 0) / maxVolume) * volumeHeight;
    if (vh <= 0.5) return '';
    const up = Number(item.close) >= Number(item.open);
    return `<rect class="volume-bar ${up ? 'up' : 'down'}" x="${(x(index) - bodyWidth / 2).toFixed(1)}" y="${(height - vh).toFixed(1)}" width="${bodyWidth.toFixed(1)}" height="${vh.toFixed(1)}"/>`;
  }).join('');

  const levels = [];
  if (forecast && forecast.action !== 'wait') {
    const levelLine = (value, cls, label) => `<line class="level-line ${cls}" x1="0" y1="${y(value).toFixed(1)}" x2="${plotW}" y2="${y(value).toFixed(1)}"/><text class="level-text ${cls}" x="${plotW + 4}" y="${(y(value) + 3).toFixed(1)}">${esc(label)}</text>`;
    levels.push(`<rect class="level-entry-zone" x="0" y="${y(Number(forecast.entryHigh)).toFixed(1)}" width="${plotW}" height="${Math.max(2, y(Number(forecast.entryLow)) - y(Number(forecast.entryHigh))).toFixed(1)}"/>`);
    levels.push(levelLine(forecast.stop, 'stop', fmtPrice(forecast.stop)));
    levels.push(levelLine((Number(forecast.entryLow) + Number(forecast.entryHigh)) / 2, 'entry', fmtPrice((Number(forecast.entryLow) + Number(forecast.entryHigh)) / 2)));
    levels.push(levelLine(forecast.target1, 'target', fmtPrice(forecast.target1)));
    levels.push(levelLine(forecast.target2, 'target', fmtPrice(forecast.target2)));
  }

  // Сделки демо-счёта: точки входа (треугольник) и выхода (кружок) на свечах.
  const tradeDots = (state.tradingHistory || []).map((trade) => {
    const time = new Date(trade.time).getTime();
    let idx = data.findIndex((candle) => new Date(candle.time).getTime() >= time);
    if (idx === -1) return '';
    if (idx > 0 && Math.abs(new Date(data[idx - 1].time).getTime() - time) < Math.abs(new Date(data[idx].time).getTime() - time)) idx -= 1;
    const cx = x(idx);
    const cy = y(Number(trade.priceRubPerG));
    if (trade.closeOf) return `<circle class="trade-dot exit ${trade.side === 'buy' ? 'up' : 'down'}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4"/>`;
    const up = trade.side === 'buy';
    return `<path class="trade-dot entry ${up ? 'up' : 'down'}" d="M ${cx.toFixed(1)} ${(cy + (up ? 6 : -6)).toFixed(1)} l -5 ${up ? 8 : -8} l 10 0 Z"/>`;
  }).join('');

  const lastClose = closes.at(-1);
  const lastDot = `<circle class="chart-last-dot" cx="${x(data.length - 1).toFixed(1)}" cy="${y(lastClose).toFixed(1)}" r="3.5"/>`;
  svg.innerHTML = `${grid}${candlesMarkup}${volumeBars}${levels.join('')}${tradeDots}${lastDot}`;
  attachChartHover(svg);
}

function attachChartHover(svg) {
  const tooltip = $('#chart-tooltip');
  const { data, min, max, plotW, priceHeight } = state.chart;
  const onMove = (event) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((event.clientX - rect.left) / rect.width) * state.chart.width;
    if (relX < 0 || relX > plotW) { tooltip.classList.add('hidden'); return; }
    const index = Math.round((relX / plotW) * (data.length - 1));
    const item = data[Math.max(0, Math.min(data.length - 1, index))];
    if (!item) return;
    const up = Number(item.close) >= Number(item.open);
    const time = item.time ? new Date(item.time).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    tooltip.innerHTML = `<div>${time}</div><div>Откр <b>${fmtPrice(item.open)}</b> · Макс <b>${fmtPrice(item.high)}</b></div><div>Мин <b>${fmtPrice(item.low)}</b> · Закр <b class="${up ? 'tt-up' : 'tt-down'}">${fmtPrice(item.close)}</b></div>`;
    tooltip.classList.remove('hidden');
    const px = ((event.clientX - rect.left) / rect.width) * 100;
    const py = ((event.clientY - rect.top) / rect.height) * 100;
    tooltip.style.left = `min(calc(${px}% + 14px), calc(100% - 190px))`;
    tooltip.style.top = `max(8px, calc(${py}% - 20px))`;
  };
  const onLeave = () => tooltip.classList.add('hidden');
  svg.onmousemove = onMove;
  svg.onmouseleave = onLeave;
}

function currentForecast() {
  if (!state.chartHorizon || !state.forecasts?.length) return null;
  return state.forecasts.find((item) => item.horizon === state.chartHorizon) || null;
}

function downsampleCandles(source, factor) {
  if (factor <= 1) return source;
  const result = [];
  for (let index = 0; index < source.length; index += factor) {
    const group = source.slice(index, index + factor);
    if (!group.length) break;
    result.push({
      time: group[0].time,
      open: Number(group[0].open),
      high: Math.max(...group.map((item) => Number(item.high))),
      low: Math.min(...group.map((item) => Number(item.low))),
      close: Number(group.at(-1).close),
      volume: group.reduce((sum, item) => sum + Number(item.volume || 0), 0),
    });
  }
  return result;
}

// ============ ФАКТОРЫ, СЦЕНАРИИ, НОВОСТИ ============

function renderFactors(factors) {
  $('#factor-list').innerHTML = factors.map((factor) => `<div class="factor-row"><span class="factor-label">${esc(factor.label)}</span><span class="factor-value">${esc(factor.value)}</span><i class="factor-dot ${factor.sentiment === 'negative' ? 'negative' : factor.sentiment === 'missing' ? 'missing' : ''}"></i></div>`).join('');
}

function renderForecasts(forecasts) {
  if (!forecasts?.length) return;
  $('#horizon-grid').innerHTML = forecasts.map((forecast) => `
    <article class="horizon-card ${state.chartHorizon === forecast.horizon ? 'selected' : ''}" data-horizon="${esc(forecast.horizon)}">
      <div class="horizon-card-head"><span>${esc(forecast.horizonLabel)}</span><b class="horizon-action ${esc(forecast.action)}">${actionName(forecast.action)}</b></div>
      <div class="horizon-action-price">${forecast.action === 'wait' ? fmtPrice(forecast.entryLow ?? forecast.entry) : `${fmtPrice(forecast.entryLow)}–${fmtPrice(forecast.entryHigh)}`}</div>
      <div class="horizon-action-label">${forecast.action === 'wait' ? 'диапазон наблюдения, ₽/г' : 'зона входа, ₽/г'}</div>
      <div class="horizon-detail"><span>стоп</span><b class="stop">${fmtPrice(forecast.stop)}</b></div>
      <div class="horizon-detail"><span>цель 1</span><b class="target">${fmtPrice(forecast.target1)}</b></div>
      <div class="horizon-detail"><span>цель 2</span><b class="target">${fmtPrice(forecast.target2)}</b></div>
      <div class="horizon-foot">уверенность ${forecast.confidence}% · до ${forecast.expiresAt ? new Date(forecast.expiresAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</div>
    </article>`).join('');
}

function renderHistory(history, scorecard) {
  const ordered = [...(history || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  state.history = ordered;
  const done = ordered.filter((item) => ['correct', 'incorrect', 'neutral'].includes(item.verification));
  const correct = done.filter((item) => item.verification === 'correct').length;
  const hitRate = done.length ? `${Math.round(correct / done.length * 100)}%` : '—';
  const score = scorecard || { total: ordered.length, evaluated: done.length, pending: ordered.length - done.length };
  $('#history-count').textContent = String(ordered.length);
  $('#scorecard-grid').innerHTML = `
    <div class="scorecard"><span>ТОЧНОСТЬ НАПРАВЛЕНИЯ</span><strong>${hitRate}</strong><small>${done.length} сверенных сценариев</small></div>
    <div class="scorecard"><span>СВЕРЕНО</span><strong>${score.evaluated ?? done.length}</strong><small>по истёкшим горизонтам</small></div>
    <div class="scorecard"><span>ОЖИДАЮТ</span><strong>${score.pending ?? ordered.length - done.length}</strong><small>горизонт не завершён</small></div>
    <div class="scorecard"><span>ВСЕГО СИГНАЛОВ</span><strong>${score.total ?? ordered.length}</strong><small>локальная история</small></div>`;
  let filtered = ordered;
  if (state.historyFilter === 'pending') filtered = ordered.filter((item) => item.verification === 'pending');
  if (state.historyFilter === 'evaluated') filtered = ordered.filter((item) => item.verification !== 'pending');
  if (!filtered.length) {
    $('#history-table-body').innerHTML = '<tr><td colspan="7" class="table-placeholder">Для этого фильтра пока нет прогнозов.</td></tr>';
    return;
  }
  $('#history-table-body').innerHTML = filtered.slice(0, 250).map((item) => {
    const date = item.createdAt ? new Date(item.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    const result = item.verification || 'pending';
    const resultLabel = result === 'correct' ? 'СОВПАЛ' : result === 'incorrect' ? 'НЕ СОВПАЛ' : result === 'neutral' ? 'НЕЙТРАЛЬНО' : 'ОЖИДАЕТ';
    return `<tr><td class="table-mono">${date}</td><td>${esc(item.horizonLabel || item.horizon)}</td><td><span class="scenario-dot ${esc(item.action)}"></span>${actionName(item.action)}</td><td class="table-mono">${fmtPrice(item.entry)} / ${fmtPrice(item.stop)}</td><td class="table-mono">${fmtPrice(item.target1)} / ${fmtPrice(item.target2)}</td><td>${item.confidence}%</td><td><span class="result-pill ${result}">${resultLabel}</span></td></tr>`;
  }).join('');
}

function renderNewsPreview(news) {
  if (!news?.length) return;
  $('#news-preview').innerHTML = news.slice(0, 4).map((item) => `<div class="news-item"><a href="${safeUrl(item.url)}" target="_blank" rel="noreferrer">${esc(item.title)}</a><div class="news-meta"><span>${esc(item.source || 'GDELT')}</span><span>${item.publishedAt ? timeAgo(item.publishedAt) : ''}</span></div></div>`).join('');
}

function renderNews(news, meta = {}) {
  state.news = news || [];
  $('#news-list').innerHTML = !news?.length
    ? '<div class="empty-state">Не найдено подходящих заголовков.</div>'
    : news.map((item) => {
      const d = item.publishedAt ? new Date(item.publishedAt) : null;
      const time = d && !Number.isNaN(d.getTime()) ? d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      return `<div class="news-full-item"><time class="news-time">${esc(time)}</time><div><a href="${safeUrl(item.url)}" target="_blank" rel="noreferrer">${esc(item.title)}</a><div class="news-full-meta">${esc(item.source || 'GDELT')}${item.publishedAt ? ` · ${timeAgo(item.publishedAt)}` : ''}</div></div></div>`;
    }).join('');
  renderNewsPreview(news);
  $('#ready-news').textContent = news?.length ? `${news.length} заголовков` : 'пусто';
}

function safeUrl(candidate) {
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) ? esc(url.toString()) : '#';
  } catch { return '#'; }
}

// ============ КОНФИГУРАЦИЯ ============

function renderConfig(config = {}) {
  if (!config) return;
  $('#t-status').textContent = config.tInvestConfigured ? 'КЛЮЧ СОХРАНЁН' : 'НЕ НАСТРОЕН';
  $('#t-status').classList.toggle('ok', Boolean(config.tInvestConfigured));
  $('#ai-status').textContent = config.yandexConfigured ? 'ПОДКЛЮЧЁН' : 'ОТКЛЮЧЁН';
  $('#ai-status').classList.toggle('ok', Boolean(config.yandexConfigured));
  $('#connection-dot').style.background = config.tInvestConfigured ? 'var(--up)' : '#c8cdc6';
  $('#ready-broker-dot').classList.toggle('pending', !config.tInvestConfigured);
  $('#ready-broker').textContent = config.tInvestConfigured ? 'подключён' : 'резерв ISS';
  $('#ready-ai-dot').classList.toggle('pending', !config.yandexConfigured);
  $('#ready-ai').textContent = config.yandexConfigured ? 'подключён' : 'необязательный';
  if (!$('#yandex-folder-id').value && config.yandexFolderId) $('#yandex-folder-id').value = config.yandexFolderId;
}

async function saveConfig(payload, success) {
  const result = await api('/api/config', { method: 'POST', body: JSON.stringify(payload) });
  renderConfig(result.settings);
  notify(success);
  await loadMarket({ quiet: true });
}

async function testTInvest() {
  const token = $('#t-invest-token').value.trim();
  if (!token) return notify('Введите токен T‑Invest API.', 'error');
  const button = $('#test-t-invest');
  setLoading(button, true, 'Проверяем…');
  try {
    const result = await api('/api/config/test', { method: 'POST', body: JSON.stringify({ provider: 't-invest', tInvestToken: token }) });
    $('#t-test-result').textContent = `${result.instrument} · ${fmtPrice(result.price)} ₽`;
    notify(`API отвечает: ${result.instrument}, получено ${result.candles} свечей.`);
  } catch (error) {
    $('#t-test-result').textContent = error.message;
    notify(error.message, 'error');
  } finally { setLoading(button, false); }
}

async function testYandex() {
  const apiKey = $('#yandex-api-key').value.trim();
  const folderId = $('#yandex-folder-id').value.trim();
  if (!apiKey || !folderId) return notify('Нужны API-ключ Yandex и ID каталога.', 'error');
  const button = $('#test-yandex');
  setLoading(button, true, 'Проверяем…');
  try {
    await api('/api/config/test', { method: 'POST', body: JSON.stringify({ provider: 'yandex', yandexApiKey: apiKey, yandexFolderId: folderId }) });
    notify('Yandex AI Studio подключён.');
  } catch (error) { notify(error.message, 'error'); }
  finally { setLoading(button, false); }
}

async function refreshAnalysis() {
  const button = $('#refresh-button');
  setLoading(button, true, 'Считаем…');
  try {
    const data = await api('/api/refresh', { method: 'POST', body: '{}' });
    state.analysis = data.analysis;
    state.forecasts = data.analysis.forecasts;
    state.market = { ...state.market, ...data.market, quote: data.market.quote || state.market?.quote };
    if (data.explanation) state.analysis.commentary = data.explanation;
    renderMarket(state.market);
    renderActionCard();
    renderForecasts(state.forecasts);
    const history = await api('/api/history');
    renderHistory(history.forecasts, history.scorecard);
    notify(data.aiError ? `Прогнозы сохранены; AI-объяснение не получено.` : 'Прогнозы обновлены и сохранены.');
  } catch (error) { notify(error.message, 'error'); }
  finally { setLoading(button, false); }
}

async function refreshNews(button) {
  setLoading(button, true, 'Загружаем…');
  try {
    const data = await api('/api/news');
    renderNews(data.news, data);
    notify(`Получено заголовков: ${data.news.length}.`);
  } catch (error) { notify(error.message, 'error'); }
  finally { setLoading(button, false); }
}

async function loadHistory() {
  try {
    const data = await api('/api/history');
    renderHistory(data.forecasts, data.scorecard);
  } catch (error) { notify(error.message, 'error'); }
}

// ============ ТОРГОВЛЯ ============

function renderTrading(data) {
  if (!data?.snapshot) return;
  const snap = data.snapshot;
  $('#trading-equity').textContent = fmtRub(snap.totalEquityRub ?? 0);
  $('#trading-cash').textContent = fmtRub(snap.cashRub);
  $('#trading-position').textContent = snap.positionGrams !== 0 ? `${fmtGrams(Math.abs(snap.positionGrams))} ${snap.positionGrams > 0 ? '(лонг)' : '(шорт)'}` : '—';
  $('#trading-avg').textContent = snap.avgPriceRubPerG > 0 ? fmtRub(snap.avgPriceRubPerG) : '—';
  const pnl = Number(snap.realizedPnlRub || 0);
  const pnlEl = $('#trading-pnl');
  pnlEl.textContent = fmtSigned(pnl) + ' ₽';
  pnlEl.className = pnl > 0 ? 'up' : pnl < 0 ? 'down' : '';
  $('#trading-fees').textContent = fmtRub(snap.feesRub);
  const chip = $('#trading-pnl-chip');
  const unrealized = snap.positionGrams !== 0 && data.price ? (data.price - snap.avgPriceRubPerG) * snap.positionGrams : 0;
  chip.className = `change-chip ${pnl + unrealized > 0 ? 'positive' : pnl + unrealized < 0 ? 'negative' : 'neutral'}`;
  chip.textContent = `${fmtSigned(pnl + unrealized)} ₽ итого`;
  $('#trading-updated-badge')?.replaceChildren();

  const actionable = state.forecasts.find((f) => f.action !== 'wait');
  $('#trade-levels').textContent = actionable
    ? `Сценарий ${actionable.horizonLabel}: вход ${fmtPrice(actionable.entryLow)}–${fmtPrice(actionable.entryHigh)} · стоп ${fmtPrice(actionable.stop)} · цель ${fmtPrice(actionable.target1)}`
    : 'Активных сценариев нет — нажмите «Обновить» на дашборде';

  const orders = data.orders || [];
  const open = orders.filter((o) => o.status === 'open');
  $('#orders-list').innerHTML = open.length ? open.map((o) => `
    <div class="order-row">
      <b class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? 'КУПИТЬ' : 'ПРОДАТЬ'}</b>
      <span class="table-mono">${fmtGrams(o.grams)} @ ${fmtPrice(o.limitPrice)}</span>
      <span class="trade-reason">${esc(o.reason || '')}</span>
      <button class="text-button danger" data-cancel="${o.id}">отменить</button>
    </div>`).join('') : '<div class="empty-state compact">Нет активных заявок</div>';

  const trades = data.trades || [];
  $('#trades-list').innerHTML = trades.length ? trades.slice(0, 20).map((t) => `
    <div class="trade-row-log">
      <span class="trade-time">${new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t.time))}</span>
      <b class="${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? 'покупка' : 'продажа'}</b>
      <span class="table-mono">${fmtGrams(t.grams)} @ ${fmtPrice(t.priceRubPerG)}</span>
      <span class="trade-reason">${esc(t.reason || t.source || '')}</span>
    </div>`).join('') : '<div class="empty-state compact">Сделок пока нет</div>';

  const auto = snap.autoTrading || {};
  $('#auto-state').textContent = auto.enabled ? `каждые ${auto.intervalMin} мин` : 'выключена';
  $('#auto-state-badge').classList.toggle('on', Boolean(auto.enabled));
  $('#auto-toggle').textContent = auto.enabled ? 'Остановить' : 'Запустить';
  if (auto.intervalMin) $('#auto-interval').value = auto.intervalMin;
  if (auto.maxOrderRub) $('#auto-budget').value = auto.maxOrderRub;
  const autoEvents = (data.trades || []).filter((t) => t.source === 'auto').slice(0, 4);
  if (autoEvents.length) {
    $('#auto-log').textContent = autoEvents.map((t) => `${t.side === 'buy' ? 'Куплено' : 'Продано'} ${t.grams}г @ ${fmtPrice(t.priceRubPerG)} — ${t.reason || ''}`).join(' · ');
  }
  const note = $('#trading-nav-note');
  if (note) note.textContent = auto.enabled ? `авто` : 'демо';

  $$('#orders-list [data-cancel]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api('/api/trading/cancel', { method: 'POST', body: JSON.stringify({ id: button.dataset.cancel }) });
      notify('Заявка отменена.');
      refreshTrading();
    } catch (error) { notify(error.message, 'error'); }
  }));
}

async function refreshTrading() {
  try {
    const data = await api('/api/trading');
    state.tradingHistory = buildTradeDots(data.trades || []);
    renderTrading(data);
    renderEquityCurve(data.equityCurve || []);
  } catch (error) {
    if (state.view === 'trading') notify(error.message, 'error');
  }
}

// Помечает закрывающие сделки (противоположные направлению предыдущей открытой позиции).
async function buildTradeDots(trades) {
  // Идём от старых к новым, отслеживая знак позиции.
  const ordered = [...trades].reverse();
  let qty = 0;
  return ordered.map((trade) => {
    const signed = trade.side === 'buy' ? trade.grams : -trade.grams;
    const closeOf = (qty > 0 && signed < 0) || (qty < 0 && signed > 0);
    qty += signed;
    return { ...trade, closeOf };
  });
}

function renderEquityCurve(curve) {
  const holder = $('#equity-spark');
  if (!holder) return;
  if (!curve.length) { holder.innerHTML = '<div class="empty-state compact">Кривая капитала появится по мере торговли</div>'; return; }
  const points = [...curve].reverse();
  const values = points.map((p) => Number(p.equityRub));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.max(max - min, 1);
  const w = 300; const h = 60;
  const path = points.map((p, i) => `${(i / (points.length - 1)) * w},${h - ((Number(p.equityRub) - min) / spread) * (h - 6) - 3}`).join(' ');
  const positive = values.at(-1) >= 100000;
  holder.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:60px"><polyline points="${path}" fill="none" stroke="${positive ? 'var(--up)' : 'var(--down)'}" stroke-width="1.5"/></svg><div class="trade-note">Капитал: ${fmtRub(values[0])} → ${fmtRub(values.at(-1))} · точек: ${points.length}</div>`;
}

async function submitTrade() {
  const grams = Number($('#trade-grams').value);
  const limitPrice = state.trading.kind === 'limit' ? Number($('#trade-limit').value) : null;
  if (!Number.isFinite(grams) || grams <= 0) return notify('Укажите объём в граммах.', 'error');
  if (state.trading.kind === 'limit' && (!Number.isFinite(limitPrice) || limitPrice <= 0)) return notify('Укажите лимитную цену.', 'error');
  const button = $('#trade-submit');
  setLoading(button, true, 'Отправляем…');
  try {
    const data = await api('/api/trading/order', { method: 'POST', body: JSON.stringify({ side: state.trading.side, grams, limitPrice }) });
    const order = data.order;
    notify(order.status === 'filled'
      ? `${order.side === 'buy' ? 'Куплено' : 'Продано'} ${order.grams} г по ${fmtPrice(order.fillPrice)} ₽/г`
      : `Лимитная заявка выставлена: ${order.grams} г по ${fmtPrice(order.limitPrice)} ₽/г`);
    refreshTrading();
  } catch (error) { notify(error.message, 'error'); }
  finally { setLoading(button, false); }
}

async function toggleAutoTrading() {
  const button = $('#auto-toggle');
  const enabled = button.textContent.trim() === 'Запустить';
  setLoading(button, true, 'Применяю…');
  try {
    await api('/api/trading/auto', {
      method: 'POST',
      body: JSON.stringify({ enabled, intervalMin: Number($('#auto-interval').value) || 10, maxOrderRub: Number($('#auto-budget').value) || 20000 }),
    });
    notify(enabled ? 'Автоторговля запущена.' : 'Автоторговля остановлена.');
    refreshTrading();
  } catch (error) { notify(error.message, 'error'); }
  finally { setLoading(button, false); }
}

async function resetTrading() {
  if (!confirm('Сбросить демо-счёт к 100 000 ₽? История сделок будет очищена.')) return;
  try {
    await api('/api/trading/reset', { method: 'POST', body: '{}' });
    notify('Демо-счёт сброшен.');
    refreshTrading();
  } catch (error) { notify(error.message, 'error'); }
}

// ============ НАВИГАЦИЯ / СОБЫТИЯ ============

function navigate(view) {
  state.view = view;
  const titles = { overview: 'ДАШБОРД', trading: 'ТОРГОВЛЯ', history: 'ИСТОРИЯ', news: 'НОВОСТИ', connections: 'ПОДКЛЮЧЕНИЯ' };
  $$('.view').forEach((element) => element.classList.toggle('active', element.id === `view-${view}`));
  $$('.nav-item[data-view]').forEach((element) => element.classList.toggle('active', element.dataset.view === view));
  $('#breadcrumb-current').textContent = titles[view] || 'ДАШБОРД';
  if (view === 'history') loadHistory();
  if (view === 'trading') refreshTrading();
  if (view === 'connections') api('/api/config').then(renderConfig).catch(() => {});
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateClock() {
  const now = new Date();
  $('#clock').textContent = `${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now)} MSK`;
  $('#footer-time').textContent = `${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(now)} MSK`;
}

function downloadHistory() {
  if (!state.history.length) return notify('История пока пуста.', 'error');
  const columns = ['createdAt', 'horizonLabel', 'action', 'entry', 'stop', 'target1', 'target2', 'confidence', 'verification', 'evaluatedPrice'];
  const csv = [columns.join(';'), ...state.history.map((item) => columns.map((column) => `"${String(item[column] ?? '').replaceAll('"', '""')}"`).join(';'))].join('\n');
  const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `gold-forecast-history-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function bindEvents() {
  $$('.nav-item[data-view]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
  $$('[data-view-link]').forEach((button) => button.addEventListener('click', (event) => { event.preventDefault(); navigate(button.dataset.viewLink); }));
  $('#refresh-button').addEventListener('click', refreshAnalysis);
  $('#load-news-button').addEventListener('click', (event) => refreshNews(event.currentTarget));
  $('#test-t-invest').addEventListener('click', testTInvest);
  $('#test-yandex').addEventListener('click', testYandex);
  $('#test-news').addEventListener('click', (event) => refreshNews(event.currentTarget));
  $('#save-t-invest').addEventListener('click', async () => {
    const token = $('#t-invest-token').value.trim();
    if (!token) return notify('Введите токен T‑Invest API.', 'error');
    try { await saveConfig({ provider: 't-invest', tInvestToken: token }, 'Токен сохранён локально.'); }
    catch (error) { notify(error.message, 'error'); }
  });
  $('#save-yandex').addEventListener('click', async () => {
    const yandexApiKey = $('#yandex-api-key').value.trim();
    const yandexFolderId = $('#yandex-folder-id').value.trim();
    if (!yandexApiKey || !yandexFolderId) return notify('Введите API-ключ и ID каталога Yandex Cloud.', 'error');
    try { await saveConfig({ yandexApiKey, yandexFolderId }, 'Ключ Yandex сохранён локально.'); }
    catch (error) { notify(error.message, 'error'); }
  });
  $('#clear-yandex').addEventListener('click', async () => {
    try { await saveConfig({ yandexApiKey: '', yandexFolderId: '' }, 'Ключ Yandex удалён.'); }
    catch (error) { notify(error.message, 'error'); }
  });
  $('#export-history').addEventListener('click', downloadHistory);
  $$('.range-button').forEach((button) => button.addEventListener('click', () => {
    state.range = button.dataset.range;
    $$('.range-button').forEach((element) => element.classList.toggle('active', element === button));
    if (state.market) drawChart(state.market.candles, state.range);
  }));
  $$('.filter-tab').forEach((button) => button.addEventListener('click', () => {
    state.historyFilter = button.dataset.historyFilter;
    $$('.filter-tab').forEach((item) => item.classList.toggle('active', item === button));
    renderHistory(state.history, state.scorecard);
  }));
  $$('.toggle-secret').forEach((button) => button.addEventListener('click', () => {
    const input = $(`#${button.dataset.target}`);
    input.type = input.type === 'password' ? 'text' : 'password';
    button.textContent = input.type === 'password' ? 'СКРЫТЬ' : 'ПОКАЗАТЬ';
  }));
  $('#horizon-grid').addEventListener('click', (event) => {
    const card = event.target.closest('.horizon-card');
    if (!card) return;
    state.chartHorizon = state.chartHorizon === card.dataset.horizon ? null : card.dataset.horizon;
    if (state.market) drawChart(state.market.candles, state.range);
    renderForecasts(state.forecasts);
  });
  // Торговля
  $('#trade-submit').addEventListener('click', submitTrade);
  $('#auto-toggle').addEventListener('click', toggleAutoTrading);
  $('#trading-reset').addEventListener('click', resetTrading);
  $$('.trade-type[data-side]').forEach((button) => button.addEventListener('click', () => {
    state.trading.side = button.dataset.side;
    state.trading.kind = 'market';
    $$('.trade-type').forEach((element) => element.classList.toggle('active', element === button));
    $('.limit-only')?.classList.toggle('hidden', true);
    $('#trade-submit').textContent = state.trading.side === 'buy' ? 'Купить по рынку' : 'Продать по рынку';
  }));
  $('.trade-type[data-kind="limit"]')?.addEventListener('click', () => {
    state.trading.kind = 'limit';
    $$('.trade-type').forEach((element) => element.classList.remove('active'));
    event.currentTarget.classList.add('active');
    $('.limit-only')?.classList.toggle('hidden', false);
    $('#trade-submit').textContent = 'Выставить лимитную заявку';
  });
  setInterval(() => { if (state.view === 'trading') refreshTrading(); }, 15_000);
}

async function initialize() {
  bindEvents();
  updateClock();
  setInterval(updateClock, 1000);
  await loadMarket();
  api('/api/config').then(renderConfig).catch(() => {});
  api('/api/news').then((data) => { if (data.news?.length) renderNewsPreview(data.news); }).catch(() => {});
  state.refreshTimer = setInterval(() => loadMarket({ quiet: true }), 5_000);
}

initialize();
