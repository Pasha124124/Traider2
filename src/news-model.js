'use strict';

// Новостная модель — независимый от ценовой сценарий.
//
// Она не берёт свечи и не пытается угадать направление по графику: единственный
// источник — заголовки. Поэтому её вывод отдельный от технического сценария,
// с собственным горизонтом, собственной историей и собственной сверкой.
// Цена здесь используется только для того, чтобы задать уровни в рублях.

const HORIZONS_MS = { '4h': 4 * 3_600_000, '1d': 86_400_000, '1w': 7 * 86_400_000 };
const MAX_EXPECTED_MOVE_PCT = 3.2;

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// Насколько источники единодушны: 1 — все одного знака, 0 — равные доли.
function agreement(votes) {
  if (!votes?.length) return 0;
  const positive = votes.filter((vote) => vote > 0.15).length;
  const negative = votes.filter((vote) => vote < -0.15).length;
  const decisive = positive + negative;
  if (decisive === 0) return 0;
  return round2(Math.max(positive, negative) / decisive);
}

function pickHorizon(impact, agreementRatio) {
  // Сильный и единодушный фон разворачивается быстрее; слабый и разношёрстный — медленно.
  const strength = Math.abs(impact.bias) * (impact.impact || 0);
  if (strength >= 0.45 && agreementRatio >= 0.99) return { key: '4h', label: '4ч' };
  if (strength >= 0.18) return { key: '1d', label: '1д' };
  return { key: '1w', label: '1н' };
}

function buildLevels(price, action, expectedMovePct) {
  const entry = round2(price);
  const step = entry * (expectedMovePct / 100);
  const direction = action === 'long' ? 1 : -1;
  const stop = round2(entry - direction * step * 1.6);
  const target1 = round2(entry + direction * step);
  const target2 = round2(entry + direction * step * 2);
  const entryPad = step * 0.35;
  return {
    entryLow: round2(entry - entryPad),
    entryHigh: round2(entry + entryPad),
    entry,
    stop,
    target1,
    target2,
    expectedLow: round2(Math.min(entry, target1) - (action === 'long' ? 0 : 0)),
    expectedHigh: round2(Math.max(entry, target2)),
  };
}

function newsForecast(impact, price, options = {}) {
  const at = options.at || new Date().toISOString();
  const px = Number(price);
  const base = {
    source: 'news',
    instrument: options.instrument || 'GLDRUB_TOM',
    generatedAt: at,
    price: Number.isFinite(px) && px > 0 ? round2(px) : null,
    available: Boolean(impact && impact.enabled && impact.enough && Number.isFinite(px) && px > 0),
  };

  if (!base.available) {
    const reason = !impact?.enabled
      ? 'Новостные ленты недоступны или нерелевантны.'
      : !impact?.enough
        ? `Новостный фон разрозненный: ${impact?.headlines || 0} заголовков из ${impact?.scoredSources || 0} источников. Считать по нему сценарий нельзя.`
        : 'Нет котировки — уровни в рублях посчитать не от чего.';
    return {
      ...base,
      action: 'wait',
      actionLabel: 'НЕТ СИГНАЛА',
      confidence: 0,
      horizonKey: null,
      horizonLabel: '—',
      rationale: reason,
      drivers: [],
      agreement: 0,
      expectedMovePct: 0,
      ...buildLevels(px > 0 ? px : 0, 'wait', 0),
    };
  }

  const agreementRatio = agreement(impact.sourceVotes || []);
  const horizon = pickHorizon(impact, agreementRatio);
  const strength = Math.abs(impact.bias) * (impact.impact || 0);
  // Уверенность новостной модели намеренно ниже технической: заголовки шумят чаще свечей.
  const confidence = Math.round(clamp(22 + strength * 55 + agreementRatio * 12, 0, 78));
  const action = strength < 0.08 || agreementRatio < 0.6 ? 'wait' : impact.bias > 0 ? 'long' : 'short';
  const expectedMovePct = round2(clamp(strength * MAX_EXPECTED_MOVE_PCT * 1.4, 0, MAX_EXPECTED_MOVE_PCT));
  const levels = buildLevels(px, action, expectedMovePct || 0.5);

  const actionLabel = action === 'long' ? 'ПОКУПАТЬ' : action === 'short' ? 'ПРОДАВАТЬ' : 'НЕ ВХОДИТЬ';
  const headline = action === 'wait'
    ? 'Фон неоднозначный: вход лучше не делать.'
    : action === 'long'
      ? 'Новостной фон поддерживает рост золота в рублях.'
      : 'Новостной фон давит на золото в рублях.';

  return {
    ...base,
    action,
    actionLabel,
    confidence,
    horizonKey: horizon.key,
    horizonLabel: horizon.label,
    durationMs: HORIZONS_MS[horizon.key],
    agreement: agreementRatio,
    expectedMovePct,
    bias: impact.bias,
    headlines: impact.headlines,
    sources: impact.sources,
    rationale: `${headline} ${impact.note || ''} Ожидаемое движение ${expectedMovePct}% в горизонте ${horizon.label}. Оценка построена только по заголовкам и не проверена на истории.`,
    drivers: (impact.top || []).slice(0, 4).map((item) => ({ title: item.title, source: item.source, tone: item.tone, url: item.url })),
    sourcesList: impact.sources,
    ...levels,
  };
}

// Сверка новостного сценария: сравниваем знак движения цены с предсказанным через горизонт.
function evaluateNewsForecasts(forecasts, candles, at = Date.now()) {
  const series = (candles || []).map((candle) => ({ time: new Date(candle.time).getTime(), close: Number(candle.close) })).filter((item) => Number.isFinite(item.time) && item.close > 0);
  if (!series.length) return { forecasts, changed: false };
  let changed = false;
  const next = forecasts.map((forecast) => {
    if (forecast.verification !== 'pending') return forecast;
    const expiry = new Date(forecast.expiresAt || 0).getTime();
    if (!Number.isFinite(expiry) || expiry > at) return forecast;
    // Только цены после создания сценария — иначе сверяемся с задним числом.
    const after = series.filter((point) => point.time >= new Date(forecast.referenceTime || forecast.createdAt).getTime());
    if (after.length < 2) return forecast;
    const nearest = after.reduce((best, point) => (Math.abs(point.time - expiry) < Math.abs(best.time - expiry) ? point : best), after[0]);
    if (Math.abs(nearest.time - expiry) > (forecast.durationMs || 0) * 0.5) return forecast;
    const reference = Number(forecast.referencePrice);
    if (!(reference > 0)) return forecast;
    const move = nearest.close - reference;
    const predicted = forecast.action === 'long' ? 1 : forecast.action === 'short' ? -1 : 0;
    if (predicted === 0) {
      changed = true;
      return { ...forecast, verification: 'neutral', evaluatedPrice: nearest.close, evaluatedAt: new Date().toISOString(), outcome: 'Ожидание' };
    }
    const hit = Math.sign(move) === predicted;
    changed = true;
    return {
      ...forecast,
      verification: hit ? 'correct' : 'incorrect',
      evaluatedPrice: nearest.close,
      evaluatedAt: new Date().toISOString(),
      outcome: `${fmtPct(move / reference * 100)} · предсказано ${forecast.action === 'long' ? 'рост' : 'снижение'}`,
    };
  });
  return { forecasts: next, changed };
}

function fmtPct(value) {
  const rounded = round2(value);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function newsScorecard(forecasts) {
  const closed = (forecasts || []).filter((item) => ['correct', 'incorrect', 'neutral'].includes(item.verification));
  const correct = closed.filter((item) => item.verification === 'correct').length;
  const directional = closed.filter((item) => item.verification !== 'neutral');
  const neutral = closed.filter((item) => item.verification === 'neutral').length;
  const pending = (forecasts || []).filter((item) => item.verification === 'pending').length;
  return {
    total: (forecasts || []).length,
    evaluated: closed.length,
    pending,
    neutral,
    accuracy: directional.length ? Math.round((directional.filter((item) => item.verification === 'correct').length / directional.length) * 100) : null,
    // Expectancy новостной модели: средняя точность направления за вычетом «ожиданий».
    expectancyPct: directional.length
      ? round2(((directional.filter((i) => i.verification === 'correct').length / directional.length) - 0.5) * 200)
      : null,
    correct,
    incorrect: directional.length - correct,
  };
}

module.exports = { newsForecast, evaluateNewsForecasts, newsScorecard, agreement, HORIZONS_MS };
