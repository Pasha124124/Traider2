const DEFAULT_HORIZONS = [
  { key: '15m', label: '15 минут', short: '15м', durationMs: 15 * 60_000, candles: 15 },
  { key: '1h', label: '1 час', short: '1ч', durationMs: 60 * 60_000, candles: 60 },
  { key: '4h', label: '4 часа', short: '4ч', durationMs: 4 * 60 * 60_000, candles: 240 },
  { key: '1d', label: '1 день', short: '1д', durationMs: 24 * 60 * 60_000, candles: 1440 },
  { key: '1w', label: '1 неделя', short: '1нед', durationMs: 7 * 24 * 60 * 60_000, candles: 10_080 },
  { key: '1mo', label: '1 месяц', short: '1мес', durationMs: 30 * 24 * 60 * 60_000, candles: 43_200 },
];

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function ema(values, period) {
  if (!values.length) return 0;
  const alpha = 2 / (period + 1);
  let current = values[0];
  for (let index = 1; index < values.length; index += 1) current = alpha * values[index] + (1 - alpha) * current;
  return current;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;
  const slice = values.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let index = 1; index < slice.length; index += 1) {
    const change = slice[index] - slice[index - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (!avgLoss) return avgGain ? 100 : 50;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function roundTo(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function computeIndicators(candles) {
  const closes = candles.map((item) => Number(item.close)).filter((value) => Number.isFinite(value) && value > 0);
  const price = closes.at(-1) || 0;
  const first = closes[0] || price;
  const returns = closes.slice(1).map((value, index) => Math.log(value / closes[index]));
  const maFast = mean(closes.slice(-20));
  const maSlow = mean(closes.slice(-50));
  const volatility = stddev(returns.slice(-50)) * Math.sqrt(Math.max(1, candles.length));
  const relativeVolatility = price ? Math.max(0.002, Math.min(0.05, stddev(returns.slice(-50)) * Math.sqrt(60))) : 0.01;
  const momentum = price ? (price / (closes[Math.max(0, closes.length - 15)] || price) - 1) : 0;
  const hourlyMomentum = price ? (price / (closes[Math.max(0, closes.length - 61)] || price) - 1) : 0;
  const dayLookback = Math.min(240, Math.max(1, closes.length - 1));
  const dayChange = first ? price / first - 1 : 0;
  const shortTrend = maFast ? price / maFast - 1 : 0;
  const longTrend = maSlow ? price / maSlow - 1 : 0;
  const RSI = rsi(closes);
  const ema12 = ema(closes.slice(-80), 12);
  const ema26 = ema(closes.slice(-120), 26);
  const macd = price ? (ema12 - ema26) / price : 0;
  const range = candles.slice(-Math.min(candles.length, dayLookback));
  const recentHigh = range.length ? Math.max(...range.map((item) => Number(item.high ?? item.close))) : price;
  const recentLow = range.length ? Math.min(...range.map((item) => Number(item.low ?? item.close))) : price;
  const avgVolume = mean(candles.slice(-30).map((item) => Number(item.volume || 0)));
  const currentVolume = Number(candles.at(-1)?.volume || 0);
  const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;
  const trendScore = clamp(shortTrend * 48 + longTrend * 24 + momentum * 16 + hourlyMomentum * 12 + macd * 30, -1, 1);
  const rsiScore = clamp((RSI - 50) / 35, -1, 1);
  const structureScore = price > recentHigh * 0.997 ? 0.15 : price < recentLow * 1.003 ? -0.15 : 0;
  const score = clamp(trendScore * 0.58 + rsiScore * 0.22 + structureScore + clamp(dayChange * 30, -0.12, 0.12), -1, 1);
  return {
    price,
    first,
    dailyChange: dayChange,
    momentum15m: momentum,
    momentum1h: hourlyMomentum,
    ma20: maFast,
    ma50: maSlow,
    rsi: RSI,
    macd,
    volatility,
    relativeVolatility,
    high: recentHigh,
    low: recentLow,
    averageVolume: avgVolume,
    volumeRatio,
    trendScore,
    score,
    trend: score > 0.18 ? 'bullish' : score < -0.18 ? 'bearish' : 'neutral',
    indicatorsAvailable: closes.length >= 30,
  };
}

function createForecast(metrics, horizon) {
  const { price, score, trend, relativeVolatility, rsi: RSI, high, low } = metrics;
  const trendMultiplier = horizon.key === '15m' ? 0.2 : horizon.key === '1h' ? 0.32 : horizon.key === '4h' ? 0.48 : horizon.key === '1d' ? 0.62 : horizon.key === '1w' ? 0.73 : 0.82;
  const volatilityMultiplier = Math.sqrt(horizon.durationMs / (60 * 60_000));
  const expectedMove = Math.max(0.0012, relativeVolatility * Math.min(volatilityMultiplier, 5) * 0.38);
  const directionScore = score * trendMultiplier;
  const side = directionScore > 0.12 ? 'long' : directionScore < -0.12 ? 'short' : 'wait';
  const confidence = Math.round(clamp(49 + Math.abs(directionScore) * 38 + (metrics.indicatorsAvailable ? 5 : -8) - (Math.abs(RSI - 50) > 33 ? 10 : 0), 40, 81));
  const entryLow = price * (1 - Math.min(expectedMove * 0.28, 0.0035));
  const entryHigh = price * (1 + Math.min(expectedMove * 0.28, 0.0035));
  const riskDistance = Math.max(price * expectedMove * 0.85, price * 0.002);
  const direction = side === 'short' ? -1 : 1;
  const stop = price - direction * riskDistance;
  const target1 = price + direction * riskDistance * 1.4;
  const target2 = price + direction * riskDistance * 2.2;
  const horizonLabel = horizon.label.toLowerCase();
  const rationale = side === 'wait'
    ? `Сигнал неубедительный: сводный импульс ${formatPercent(score * 100)}, RSI ${Math.round(RSI)}. Для входа дождаться выхода из диапазона ${formatPrice(low)}–${formatPrice(high)}.`
    : side === 'long'
      ? `Импульс преимущественно восходящий (оценка ${formatPercent(score * 100)}), цена ${price >= metrics.ma20 ? 'выше' : 'рядом с'} MA20. Вход только при удержании зоны; RSI ${Math.round(RSI)}.`
      : `Импульс преимущественно нисходящий (оценка ${formatPercent(score * 100)}), цена ${price <= metrics.ma20 ? 'ниже' : 'рядом с'} MA20. Сценарий шорта теоретический — проверьте доступность займа и короткой позиции у брокера.`;
  return {
    horizon: horizon.key,
    horizonLabel: horizon.short,
    durationMs: horizon.durationMs,
    action: side,
    confidence,
    entryLow: roundTo(entryLow),
    entryHigh: roundTo(entryHigh),
    entry: roundTo(price),
    stop: roundTo(stop),
    target1: roundTo(target1),
    target2: roundTo(target2),
    expectedLow: roundTo(price * (1 - expectedMove * (side === 'short' ? 0.95 : 0.48))),
    expectedHigh: roundTo(price * (1 + expectedMove * (side === 'long' ? 0.95 : 0.48))),
    expectedReturnPct: roundTo(directionScore * 0.55 * 100, 2),
    riskReward: '1 : 1.4 / 2.2',
    rationale,
    plan: buildPlanSteps({ side, price, stop, target1, target2, horizon, RSI, score, high, low, metrics }),
    invalidation: side === 'wait' ? `Сигнал изменится после закрепления вне диапазона ${formatPrice(low)}–${formatPrice(high)}.` : `Сценарий отменяется при достижении стоп-уровня ${formatPrice(stop)} или при смене структуры импульса.`,
    expiresLabel: horizonLabel,
    sampleSize: metrics.indicatorsAvailable ? 'sufficient' : 'limited',
    note: 'Оценочный количественный сценарий, не гарантия и не индивидуальная инвестиционная рекомендация.',
  };
}

function buildPlanSteps({ side, price, stop, target1, target2, horizon, RSI, score, high, low, metrics }) {
  const p = (value) => formatPrice(value);
  const zone = `${p(price * (1 - 0.003))}–${p(price * (1 + 0.003))}`;
  if (side === 'wait') {
    return [
      { when: 'сейчас', what: 'Ждать выхода цены из диапазона', why: `Сводный импульс слабый (${formatPercent(score * 100)}): торговать в боковике дороже комиссий и рисков.` },
      { when: `если цена ≥ ${p(high)}`, what: `Рассмотреть лонг (цели ${p(Math.min(target1, target2))} и ${p(Math.max(target1, target2))})`, why: 'Закрепление выше верхней границы диапазона — сигнал смены баланса спроса и предложения в пользу покупателей.' },
      { when: `если цена ≤ ${p(low)}`, what: 'Не покупать падение без подтверждения', why: `Пробой поддержки усиливает продавцов; RSI ${Math.round(RSI)} пока не в зоне перепроданности.` },
      { when: 'в течение горизонта', what: 'Обновить анализ после новых свечей', why: 'Сценарий живёт пока не исчерпан импульс; горизонт ' + horizon.label.toLowerCase() + ' требует свежих данных.' },
    ];
  }
  const isLong = side === 'long';
  return [
    { when: `у ${p(price)} (зона ${zone})`, what: isLong ? `Купить · стоп ${p(stop)}` : `Продать/не покупать · стоп ${p(stop)}`, why: isLong
      ? `Импульс вверх (${formatPercent(score * 100)}), цена ${price >= metrics.ma20 ? 'выше' : 'у'} MA20, RSI ${Math.round(RSI)} без перегрева.`
      : `Импульс вниз (${formatPercent(score * 100)}), цена ${price <= metrics.ma20 ? 'ниже' : 'у'} MA20. Шорт теоретический: проверьте доступность займа у брокера.` },
    { when: `если цена ${isLong ? '≥' : '≤'} ${p(Math.min(target1, target2))}`, what: isLong ? 'Зафиксировать ~50% позиции' : 'Откупить ~50% позиции', why: 'Первая цель по риску/прибыли 1:1.4; частичная фиксация снижает риск разворота против остатка позиции.' },
    { when: `если цена ${isLong ? '≥' : '≤'} ${p(Math.max(target1, target2))}`, what: 'Закрыть позицию полностью', why: `Вторая цель 1:2.2 — исчерпание импульса на горизонте ${horizon.label.toLowerCase()}.` },
    { when: `если цена ${isLong ? '≤' : '≥'} ${p(stop)}`, what: 'Немедленный выход — сценарий отменён', why: 'Стоп опровергает предположение о направлении: дальше удерживать позицию без сценария опаснее, чем принять убыток.' },
    { when: 'в течение всего горизонта', what: 'Не усредняться против стопа', why: 'Докупание против направления превращает ограниченный риск в неограниченный.' },
  ];
}

function analyzeMarket(candles, context = {}) {
  const safeCandles = (Array.isArray(candles) ? candles : [])
    .filter((item) => Number(item.close) > 0)
    .slice(-43_200);
  if (safeCandles.length < 2) throw new Error('Для расчёта недостаточно рыночных свечей');
  const indicators = computeIndicators(safeCandles);
  const longCandles = (Array.isArray(context.longCandles) ? context.longCandles : []).filter((item) => Number(item.close) > 0).slice(-1500);
  const dailyCandles = (Array.isArray(context.dailyCandles) ? context.dailyCandles : []).filter((item) => Number(item.close) > 0).slice(-1200);
  const longIndicators = longCandles.length >= 30 ? computeIndicators(longCandles) : null;
  const dailyIndicators = dailyCandles.length >= 20 ? computeIndicators(dailyCandles) : null;
  const forecasts = DEFAULT_HORIZONS.map((horizon) => {
    const usesDailyHistory = horizon.key === '1mo';
    const usesLongHistory = horizon.key === '1w';
    const sourceCandles = usesDailyHistory ? dailyCandles : usesLongHistory ? longCandles : safeCandles;
    const sourceIndicators = usesDailyHistory ? (dailyIndicators || longIndicators || indicators) : usesLongHistory ? (longIndicators || indicators) : indicators;
    const observedStart = sourceCandles.length ? new Date(sourceCandles[0].time).getTime() : Number.NaN;
    const observedEnd = sourceCandles.length ? new Date(sourceCandles.at(-1).time).getTime() : Number.NaN;
    const observedDurationMs = Number.isFinite(observedStart) && Number.isFinite(observedEnd) ? Math.max(0, observedEnd - observedStart) : 0;
    const forecastMetrics = usesLongHistory || usesDailyHistory ? { ...sourceIndicators, price: indicators.price } : sourceIndicators;
    const forecast = createForecast(forecastMetrics, horizon);
    forecast.coveragePct = Math.min(100, Math.round(observedDurationMs / horizon.durationMs * 100));
    forecast.sourceInterval = usesDailyHistory ? '1d' : usesLongHistory ? '1h' : '1m';
    if (observedDurationMs < horizon.durationMs * 0.8) {
      forecast.sampleSize = 'limited';
      forecast.confidence = Math.max(35, forecast.confidence - 18);
      forecast.rationale += ` Для горизонта ${horizon.label.toLowerCase()} доступной истории недостаточно (${forecast.coveragePct}% срока).`;
    }
    return forecast;
  });
  const price = indicators.price;
  const analysis = {
    instrument: context.instrument || 'GLDRUB_TOM',
    provider: context.provider || 'unknown',
    generatedAt: context.timestamp || new Date().toISOString(),
    price: roundTo(price),
    dailyChangePct: roundTo(indicators.dailyChange * 100, 2),
    trend: indicators.trend,
    trendScore: roundTo(indicators.score * 100, 1),
    confidence: Math.round(49 + Math.abs(indicators.score) * 34),
    indicators: {
      rsi: roundTo(indicators.rsi, 1),
      ma20: roundTo(indicators.ma20),
      ma50: roundTo(indicators.ma50),
      macd: roundTo(indicators.macd * 100, 3),
      volatility: roundTo(indicators.relativeVolatility * 100, 3),
      high: roundTo(indicators.high),
      low: roundTo(indicators.low),
      volumeRatio: roundTo(indicators.volumeRatio, 2),
    },
    commentary: buildCommentary(indicators),
    factors: buildFactors(indicators),
    forecasts,
    observations: safeCandles.length,
    dataQuality: safeCandles.length < 50 ? 'limited' : 'usable',
    caveat: 'Сценарии строятся по свечам; российский новостной фон учитывается лишь небольшой поправкой. Инструмент не «видит весь рынок»: стакан, XAU/USD, USD/RUB и комиссии брокера здесь не подключены.',
  };
  return applyNewsImpact(analysis, context.news, indicators);
}

// Российский новостной фон. Заголовки могут лишь слегка сдвинуть сводный импульс
// и снизить уверенность при конфликте с ценой — они никогда не создают сигнал сами.
const NEWS_SCORE_CAP = 15; // максимум, на который новости могут сдвинуть импульс, баллов
function applyNewsImpact(analysis, impact, metrics) {
  const news = impact && impact.enabled ? impact : { enabled: false, bias: 0, impact: 0, headlines: 0, sources: [], sources_conflict: false, note: 'Российские новостные ленты недоступны или нерелевантны — сценарий построен только по цене.' };
  const shift = news.impact ? news.bias * NEWS_SCORE_CAP * news.impact : 0;
  const before = analysis.trendScore;
  analysis.trendScore = roundTo(analysis.trendScore + shift, 1);
  analysis.technicalTrendScore = before;

  const technicalDirection = Math.sign(before) || 0;
  const conflict = Boolean(technicalDirection && Math.sign(shift) && Math.sign(shift) !== technicalDirection && Math.abs(shift) >= 3);
  if (conflict) {
    analysis.confidence = Math.max(30, Math.round(analysis.confidence * 0.88));
    analysis.trend = 'neutral';
  }
  if (news.impact && !conflict && Math.sign(shift) === technicalDirection && technicalDirection) {
    analysis.trend = before > 0 ? 'bullish' : 'bearish';
  }
  analysis.commentary = `${analysis.commentary} ${news.note || ''}`;
  analysis.factors = buildFactors(metrics, news);
  analysis.news = {
    ...news,
    shift: roundTo(shift, 2),
    conflict,
    headlinesUsed: news.headlines || 0,
  };
  return analysis;
}

function buildCommentary(metrics) {
  const direction = metrics.trend === 'bullish' ? 'умеренно позитивный' : metrics.trend === 'bearish' ? 'умеренно негативный' : 'нейтральный';
  const rsiText = metrics.rsi > 70 ? 'RSI указывает на перекупленность; повышен риск отката' : metrics.rsi < 30 ? 'RSI указывает на перепроданность; возможно техническое восстановление' : 'RSI не показывает экстремальной перекупленности или перепроданности';
  return `Сводный импульс ${direction} (${formatPercent(metrics.score * 100)}). ${rsiText}. Цена ${metrics.price >= metrics.ma20 ? 'находится выше' : 'находится ниже'} 20-периодной средней. Уровень ${formatPrice(metrics.low)} — ближайшая наблюдаемая поддержка, ${formatPrice(metrics.high)} — сопротивление за доступный участок истории. Это не фундаментальный анализ: глобальное XAU/USD и USD/RUB здесь не подключены.`;
}

function buildFactors(metrics, news) {
  const newsRow = news && news.enabled
    ? { label: 'Российские новости', value: `${news.headlines} заголовков · ${news.sources?.length || 0} источников · перевес ${news.bias > 0.05 ? 'в пользу роста' : news.bias < -0.05 ? 'в пользу снижения' : 'нейтральный'}`, sentiment: news.conflict ? 'negative' : news.bias > 0.05 ? 'positive' : news.bias < -0.05 ? 'negative' : 'neutral' }
    : { label: 'Российские новости', value: 'релевантных заголовков недостаточно', sentiment: 'missing' };
  return [
    { label: 'Тренд MA20/MA50', value: metrics.trendScore > 0.12 ? 'в пользу роста' : metrics.trendScore < -0.12 ? 'в пользу снижения' : 'без выраженного направления', sentiment: metrics.trendScore > 0.12 ? 'positive' : metrics.trendScore < -0.12 ? 'negative' : 'neutral' },
    { label: 'RSI(14)', value: `${Math.round(metrics.rsi)} · ${metrics.rsi > 70 ? 'перекупленность' : metrics.rsi < 30 ? 'перепроданность' : 'нейтральная зона'}`, sentiment: metrics.rsi > 70 ? 'negative' : metrics.rsi < 30 ? 'positive' : 'neutral' },
    { label: 'Импульс за 15 свечей', value: formatPercent(metrics.momentum15m * 100), sentiment: metrics.momentum15m > 0.001 ? 'positive' : metrics.momentum15m < -0.001 ? 'negative' : 'neutral' },
    { label: 'Объём', value: metrics.averageVolume > 0 ? `${metrics.volumeRatio.toFixed(2)}× средней активности` : 'нет данных об объёме', sentiment: 'neutral' },
    { label: 'Глобальное золото / USD/RUB', value: 'источник не подключён', sentiment: 'missing' },
    newsRow,
  ];
}

function evaluateForecasts(forecasts, candles, at = Date.now(), longCandles = [], dailyCandles = []) {
  let changed = false;
  const toSeries = (source) => (source || []).map((candle) => ({ time: new Date(candle.time).getTime(), close: Number(candle.close) })).filter((item) => Number.isFinite(item.time) && item.close > 0);
  const minuteSeries = toSeries(candles);
  const hourSeries = toSeries(longCandles);
  const daySeries = toSeries(dailyCandles);
  const tolerances = { '15m': 90 * 60_000, '1h': 4 * 60 * 60_000, '4h': 12 * 60 * 60_000, '1d': 36 * 60 * 60_000, '1w': 36 * 60 * 60_000, '1mo': 4 * 24 * 60 * 60_000 };
  const next = forecasts.map((forecast) => {
    if (forecast.verification !== 'pending' || !forecast.expiresAt || new Date(forecast.expiresAt).getTime() > at) return forecast;
    const referenceTime = new Date(forecast.referenceTime || forecast.createdAt).getTime();
    const targetTime = new Date(forecast.expiresAt).getTime();
    const series = forecast.horizon === '1mo' && daySeries.length ? daySeries : forecast.horizon === '1w' && hourSeries.length ? hourSeries : minuteSeries;
    const tolerance = tolerances[forecast.horizon] || 2 * 60 * 60_000;
    const sample = series
      .filter((item) => item.time >= Math.max(referenceTime, targetTime) && item.time <= at && item.time - targetTime <= tolerance)
      .sort((a, b) => Math.abs(a.time - targetTime) - Math.abs(b.time - targetTime))[0];
    if (!sample) return forecast;
    let verification = 'neutral';
    let outcome = 'Цена не изменилась достаточно для оценки направленного сигнала.';
    const change = sample.close / Number(forecast.entry) - 1;
    const threshold = Math.max(0.0005, Math.abs(Number(forecast.entry) - Number(forecast.stop)) / Number(forecast.entry) * 0.2);
    if (forecast.action === 'long') {
      verification = change > threshold ? 'correct' : change < -threshold ? 'incorrect' : 'neutral';
      outcome = verification === 'correct' ? 'Цена закрылась выше цены входа — направление сценария совпало.' : verification === 'incorrect' ? 'Цена закрылась ниже цены входа — направление сценария не совпало.' : outcome;
    } else if (forecast.action === 'short') {
      verification = change < -threshold ? 'correct' : change > threshold ? 'incorrect' : 'neutral';
      outcome = verification === 'correct' ? 'Цена закрылась ниже цены входа — направление сценария совпало.' : verification === 'incorrect' ? 'Цена закрылась выше цены входа — направление сценария не совпало.' : outcome;
    } else {
      verification = Math.abs(change) < threshold ? 'correct' : 'incorrect';
      outcome = verification === 'correct' ? 'Цена осталась в диапазоне — ожидание было уместно.' : 'Цена вышла из диапазона — сигнал ожидания оказался неудачным.';
    }
    changed = true;
    return { ...forecast, verifiedAt: new Date(at).toISOString(), evaluatedAt: new Date(at).toISOString(), evaluatedPrice: roundTo(sample.close), verification, outcome, priceChangePct: roundTo(change * 100, 3), verificationAnchorTime: new Date(referenceTime).toISOString() };
  });
  return { forecasts: next, changed };
}

function formatPrice(value) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value || 0);
}

function formatPercent(value) {
  const formatted = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, signDisplay: 'always' }).format(value || 0);
  return `${formatted}%`;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

module.exports = { DEFAULT_HORIZONS, computeIndicators, analyzeMarket, applyNewsImpact, evaluateForecasts, mean, stddev, rsi };
