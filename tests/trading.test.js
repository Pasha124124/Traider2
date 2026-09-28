// Спецификация из брокера, исполнение по стакану и метрики expectancy/просадки.
const test = require('node:test');
const assert = require('node:assert');
const trading = require('../src/trading');
const broker = require('../src/broker');
const { newsForecast, evaluateNewsForecasts, newsScorecard, agreement } = require('../src/news-model');

// Фабрика, а не общий объект: иначе тесты делят массивы заявок и сделок.
const freshState = (overrides = {}) => ({
  createdAt: new Date().toISOString(), cashRub: 100000, startCapitalRub: 100000,
  positionGrams: 0, avgPriceRubPerG: 0, realizedPnlRub: 0, feesRub: 0,
  orders: [], trades: [], equityCurve: [],
  autoTrading: { enabled: false, intervalMin: 10, maxOrderRub: 20000 },
  spec: { ticker: 'GLDRUB_TOM', lot: 1, minPriceIncrement: 0.01, shortCapable: false },
  ...overrides,
});

const book = {
  bids: [{ price: 11700, quantity: 1 }, { price: 11699, quantity: 2 }],
  asks: [{ price: 11701, quantity: 1 }, { price: 11703, quantity: 1 }, { price: 11706, quantity: 5 }],
};

test('лот берётся из спецификации, а не из константы', () => {
  const state = freshState({ spec: { ticker: 'GLDRUB_TOM', lot: 3, minPriceIncrement: 0.01, shortCapable: false } });
  assert.throws(() => trading.placeOrder(state, { side: 'buy', grams: 2, marketPrice: 11700 }), /Минимальный лот/);
  trading.placeOrder(state, { side: 'buy', grams: 7, marketPrice: 11700, book: null });
  assert.strictEqual(state.orders[0].grams, 6, '7 г должно округлиться вниз до 6 при лоте 3 г');
});

test('без спецификации от брокера запасной лот помечается', () => {
  const state = freshState({ spec: {} });
  const spec = trading.specOf(state);
  assert.strictEqual(spec.lot, trading.FALLBACK_LOT_GR);
  assert.strictEqual(spec.fromBroker, false);
});

test('продажа в шорт на споте отклоняется с понятной причиной', () => {
  const state = freshState();
  assert.throws(
    () => trading.placeOrder(state, { side: 'sell', grams: 5, marketPrice: 11700, book }),
    /короткая продажа недоступна/,
  );
});

test('на производном инструменте шорт проходит, но объём ограничен глубиной стакана', () => {
  const state = freshState({ spec: { ticker: 'GOLD-1M', lot: 1, minPriceIncrement: 1, shortCapable: true } });
  trading.placeOrder(state, { side: 'sell', grams: 5, marketPrice: 11700, book });
  assert.strictEqual(state.positionGrams, -3, 'в стакане только 3 г по бидам');
  assert.strictEqual(state.orders[0].status, 'open');
  assert.strictEqual(state.orders[0].remainingGrams, 2);
});

test('рыночная покупка исполняется по стакану со средней ценой и проскальзыванием', () => {
  const state = freshState();
  trading.placeOrder(state, { side: 'buy', grams: 2, marketPrice: 11701, book });
  const trade = state.trades[0];
  assert.strictEqual(trade.priceRubPerG, 11702, '1 г по 11701 + 1 г по 11703 = 11702');
  assert.strictEqual(trade.levelsUsed, 2);
  assert.strictEqual(trade.slippageRub, 4, 'разница 2 ₽ на каждом из 2 г');
  assert.ok(trade.execution.includes('по стакану'));
});

test('когда стакана нет, сделка помечается как исполненная по котировке', () => {
  const state = freshState();
  trading.placeOrder(state, { side: 'buy', grams: 3, marketPrice: 11700, book: null });
  assert.ok(state.trades[0].execution.includes('стакан недоступен'));
});

test('лимитная заявка частично исполняется и остаётся висеть', () => {
  const state = freshState();
  trading.placeOrder(state, { side: 'buy', grams: 4, limitPrice: 11703, marketPrice: 11700, book: null });
  const fills = trading.processOpenOrders(state, 11700, new Date().toISOString(), book);
  assert.strictEqual(fills.length, 1);
  assert.strictEqual(fills[0].grams, 2, 'выше лимита 11703 в стакане только 2 г');
  assert.strictEqual(state.orders.find((o) => o.id === state.orders[0].id).status, 'open');
});

test('симуляция исполнения считает проскальзывание и исчерпание глубины', () => {
  const fill = trading.fillFromLevels(broker.normalizeLevels(book.asks), 4);
  assert.strictEqual(fill.filledGrams, 4);
  assert.strictEqual(fill.levelsUsed, 3);
  assert.strictEqual(fill.exhausted, false);
  assert.ok(fill.slippageRub > 0);
  const partial = trading.fillFromLevels(broker.normalizeLevels([{ price: 11701, quantity: 1 }]), 4);
  assert.strictEqual(partial.remainingGrams, 3);
  assert.strictEqual(partial.exhausted, true);
});

test('expectancy считается по закрытым сделкам, R — только по сделкам с риском', () => {
  const state = freshState({
    trades: [
      { realizedPnlRub: 200, feeRub: 5, slippageRub: 1, riskRub: 100 },
      { realizedPnlRub: -50, feeRub: 5, slippageRub: 2, riskRub: 100 },
      { realizedPnlRub: 100, feeRub: 5, slippageRub: 0, riskRub: 50 },
    ],
  });  const metrics = trading.performanceMetrics(state);
  assert.strictEqual(metrics.trades, 3);
  assert.strictEqual(metrics.wins, 2);
  assert.strictEqual(metrics.losses, 1);
  assert.strictEqual(metrics.expectancyRub, 83.33);
  assert.strictEqual(metrics.expectancyR, 1.17, '(2 - 0.5 + 2) / 3');
  assert.strictEqual(metrics.tradesInR, 3);
  assert.ok(metrics.profitFactor > 5);
});

test('просадка считается по кривой капитала, максимальная и текущая', () => {
  const state = freshState({
    equityCurve: [
      { time: '2026-01-03', equityRub: 100000 },
      { time: '2026-01-02', equityRub: 95000 },
      { time: '2026-01-01', equityRub: 105000 },
      { time: '2025-12-31', equityRub: 100000 },
    ],
  });
  const metrics = trading.performanceMetrics(state);
  assert.strictEqual(metrics.maxDrawdownRub, 10000);
  assert.strictEqual(metrics.maxDrawdownPct, 9.52, 'от пика 105 000 ₽');
  assert.strictEqual(metrics.peakEquityRub, 105000);
  assert.strictEqual(metrics.currentDrawdownRub, 5000, 'последняя точка на 5000 ниже пика');
  assert.strictEqual(metrics.currentDrawdownPct, 4.76);
});

test('без закрытых сделок expectancy не выдумывается', () => {
  const metrics = trading.performanceMetrics(freshState());
  assert.strictEqual(metrics.trades, 0);
  assert.strictEqual(metrics.expectancyRub, null);
  assert.strictEqual(metrics.expectancyR, null);
});

// ---------- новостная модель ----------

const impact = (bias, votes, headlines = 8) => ({
  enabled: true, enough: true, bias, impact: 0.6, headlines,
  scoredSources: votes.length, sources: votes.map((_, i) => `И${i}`),
  sourceVotes: votes, top: [], note: 'тест',
});

test('новостная модель не выдаёт сигнал без релевантного фона', () => {
  const scenario = newsForecast({ enabled: false }, 11700);
  assert.strictEqual(scenario.action, 'wait');
  assert.strictEqual(scenario.available, false);
  assert.ok(scenario.rationale.length > 0);
});

test('разнонаправленные источники дают ожидание, а не сделку', () => {
  const scenario = newsForecast(impact(0.2, [0.9, -0.8]), 11700);
  assert.strictEqual(scenario.action, 'wait');
});

test('согласие источников считается долей решительных голосов', () => {
  assert.strictEqual(agreement([0.8, 0.6, -0.9]), 0.67);
  assert.strictEqual(agreement([]), 0);
});

test('уверенность новостной модели ниже технической и ограничена сверху', () => {
  const strong = newsForecast(impact(0.95, [0.9, 0.9, 0.9]), 11700);
  assert.ok(strong.confidence > 40, `уверенность ${strong.confidence}`);
  assert.ok(strong.confidence <= 78, 'уверенность новостной модели не должна превышать 78%');
  assert.strictEqual(strong.action, 'long');
  assert.ok(strong.target1 > strong.entry, 'цель выше входа для лонга');
  assert.ok(strong.stop < strong.entry, 'стоп ниже входа для лонга');
});

test('новостная модель шортит при негативном фоне', () => {
  const scenario = newsForecast(impact(-0.8, [-0.9, -0.7]), 11700);
  assert.strictEqual(scenario.action, 'short');
  assert.ok(scenario.stop > scenario.entry);
  assert.ok(scenario.target1 < scenario.entry);
});

test('сверка новостной модели ждёт горизонт и не сверяется задним числом', () => {
  const now = Date.parse('2026-01-02T00:00:00Z');
  const pending = [{ id: 'a', action: 'long', createdAt: '2026-01-01T00:00:00Z', referenceTime: '2026-01-01T00:00:00Z', referencePrice: 100, expiresAt: '2026-01-03T00:00:00Z', durationMs: 172800000, verification: 'pending' }];
  const before = [{ time: '2026-01-01T06:00:00Z', close: 200 }];
  const result = evaluateNewsForecasts(pending, before, now);
  assert.strictEqual(result.changed, false, 'до истечения горизонта сценарий ждёт');
});

test('журнал новостной модели даёт точность и expectancy отдельно от ценовой', () => {
  const history = [
    { verification: 'correct' }, { verification: 'correct' }, { verification: 'incorrect' }, { verification: 'pending' },
  ];
  const score = newsScorecard(history);
  assert.strictEqual(score.total, 4);
  assert.strictEqual(score.evaluated, 3);
  assert.strictEqual(score.pending, 1);
  assert.strictEqual(score.accuracy, 67);
  assert.strictEqual(score.expectancyPct, 33.33);
});
