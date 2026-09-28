const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeMarket, computeIndicators, evaluateForecasts, DEFAULT_HORIZONS } = require('../src/analysis');
const { YANDEX_MODEL_URI, YANDEX_FOLDER_ID_DEFAULT } = require('../server');

test('uses the documented YandexGPT Pro 5.1 model URI and the configured folder ID', () => {
  assert.equal(YANDEX_MODEL_URI('folder123'), 'gpt://folder123/yandexgpt-5.1');
  assert.equal(YANDEX_FOLDER_ID_DEFAULT, 'b1gq3nq7ufds51e5gj9e');
});

function series(direction = 1, length = 500, intervalMs = 60_000) {
  const start = Date.now() - length * intervalMs;
  return Array.from({ length }, (_, index) => {
    const close = 10_000 + direction * index * 1.5 + Math.sin(index * 0.23) * 1.1;
    return {
      time: new Date(start + index * intervalMs).toISOString(),
      open: close - direction * 0.2,
      high: close + 2,
      low: close - 2,
      close,
      volume: 100 + (index % 7) * 5,
    };
  });
}

test('computes moving averages and RSI on valid candles', () => {
  const result = computeIndicators(series(1, 100));
  assert.ok(result.price > 0);
  assert.ok(result.ma20 > 0);
  assert.ok(result.ma50 > 0);
  assert.ok(result.rsi > 50);
  assert.equal(result.indicatorsAvailable, true);
});

test('produces a complete forecast for every requested horizon', () => {
  const result = analyzeMarket(series(1, 500), { provider: 'unit-test' });
  assert.equal(result.forecasts.length, 6);
  assert.deepEqual(result.forecasts.map((item) => item.horizon), DEFAULT_HORIZONS.map((item) => item.key));
  for (const forecast of result.forecasts) {
    assert.ok(['long', 'short', 'wait'].includes(forecast.action));
    assert.ok(forecast.entryLow <= forecast.entryHigh);
    assert.ok(forecast.confidence >= 0 && forecast.confidence <= 100);
    assert.ok(Number.isFinite(forecast.stop));
    assert.ok(Number.isFinite(forecast.target1));
    assert.ok(Number.isFinite(forecast.target2));
  }
});

test('a sustained downtrend yields a bearish overall bias', () => {
  const result = analyzeMarket(series(-1, 500));
  assert.equal(result.trend, 'bearish');
  assert.ok(result.trendScore < 0);
});

test('marks week and month forecasts as limited when longer interval history is absent', () => {
  const result = analyzeMarket(series(1, 500));
  const week = result.forecasts.find((item) => item.horizon === '1w');
  const month = result.forecasts.find((item) => item.horizon === '1mo');
  assert.equal(week.sampleSize, 'limited');
  assert.equal(week.coveragePct, 0);
  assert.equal(month.sampleSize, 'limited');
  assert.equal(month.coveragePct, 0);
});

test('does not fabricate an outcome before forecast expiry', () => {
  const forecast = {
    id: 'pending',
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    entry: 10_000,
    stop: 9_800,
    action: 'long',
    verification: 'pending',
  };
  const result = evaluateForecasts([forecast], series(1, 500), Date.now());
  assert.equal(result.changed, false);
  assert.equal(result.forecasts[0].verification, 'pending');
});

test('evaluates a long forecast from observed prices only after expiry', () => {
  const now = Date.now();
  const targetTime = now - 5 * 60_000;
  const forecast = {
    id: 'long',
    createdAt: new Date(targetTime - 60 * 60_000).toISOString(),
    referenceTime: new Date(targetTime - 60 * 60_000).toISOString(),
    expiresAt: new Date(targetTime).toISOString(),
    entry: 10_000,
    stop: 9_800,
    action: 'long',
    verification: 'pending',
  };
  const observations = [
    { time: new Date(targetTime - 60_000).toISOString(), close: 10_010 },
    { time: new Date(targetTime + 60_000).toISOString(), close: 10_150 },
  ];
  const result = evaluateForecasts([forecast], observations, now);
  assert.equal(result.changed, true);
  assert.equal(result.forecasts[0].verification, 'correct');
  assert.equal(result.forecasts[0].evaluatedPrice, 10_150);
});

test('does not verify a forecast using only prices before its expiry', () => {
  const now = Date.now();
  const expiresAt = now - 5 * 60_000;
  const forecast = {
    createdAt: new Date(expiresAt - 60 * 60_000).toISOString(),
    referenceTime: new Date(expiresAt - 60 * 60_000).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    entry: 10_000,
    stop: 9_800,
    action: 'long',
    verification: 'pending',
  };
  const beforeExpiry = [{ time: new Date(expiresAt - 60_000).toISOString(), close: 10_200 }];
  const result = evaluateForecasts([forecast], beforeExpiry, now);
  assert.equal(result.changed, false);
  assert.equal(result.forecasts[0].verification, 'pending');
});

test('does not call a small or flat move a winning long forecast', () => {
  const now = Date.now();
  const forecast = {
    createdAt: new Date(now - 60 * 60_000).toISOString(),
    expiresAt: new Date(now - 5 * 60_000).toISOString(),
    entry: 10_000,
    stop: 9_800,
    action: 'long',
    verification: 'pending',
  };
  const result = evaluateForecasts([forecast], [{ time: new Date(now - 4 * 60_000).toISOString(), close: 10_002 }], now);
  assert.equal(result.forecasts[0].verification, 'neutral');
});
