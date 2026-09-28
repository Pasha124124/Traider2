// Рендер графика: свечи, уровни сценария, торговый билет и чипы выбора.
// Тест работает на поддельном DOM и проверяет только строковую разметку SVG.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const candles = Array.from({ length: 120 }, (_, i) => {
  const base = 11500 + Math.sin(i / 7) * 120 + i * 1.4;
  return {
    time: new Date(Date.UTC(2026, 8, 28, 8, i)).toISOString(),
    open: base, high: base + 45, low: base - 40, close: base + 12, volume: 0,
  };
});
const longForecast = {
  horizon: '1h', horizonLabel: '1ч', action: 'long', confidence: 71,
  entryLow: 11540, entryHigh: 11575, entry: 11557, stop: 11480,
  target1: 11700, target2: 11800, expectedLow: 11545, expectedHigh: 11620,
  rationale: 'Импульс положительный.', invalidation: 'Отмена при закреплении ниже стопа.',
  sampleSize: 'ok', plan: [],
};
const shortForecast = { ...longForecast, horizon: '4h', horizonLabel: '4ч', action: 'short', confidence: 40, stop: 11900, target1: 11300, target2: 11150 };

function makeNode() {
  return {
    style: {}, dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    innerHTML: '', textContent: '', append() {}, addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 460 }),
    setAttribute() {}, querySelector: () => null, querySelectorAll: () => [],
  };
}

function loadApp() {
  const nodes = new Map();
  global.document = {
    createElement: makeNode,
    querySelector: (sel) => { if (!nodes.has(sel)) nodes.set(sel, makeNode()); return nodes.get(sel); },
    querySelectorAll: () => [],
    addEventListener() {},
  };
  global.window = { scrollTo() {}, addEventListener() {} };
  global.setInterval = () => 0;
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8')
    .replace(/^initialize\(\);?$/m, '')
    .replace(/^bindEvents\(\);?$/m, '')
    .replace(/^updateClock\(\);?$/m, '');
  const app = new Function('api', 'notify', `${source}\nreturn { drawChart, patch: (value) => Object.assign(state, value) };`);
  return { app: app(() => new Promise(() => {}), () => {}), nodes };
}

const draw = (app, chartHorizon) => {
  app.patch({
    market: { candles },
    forecasts: [longForecast, shortForecast],
    analysis: { news: { enabled: true, tone: 'positive', bias: 0.4, conflict: false } },
    tradingSnapshot: { cashRub: 100000 },
    range: '1H',
    chartHorizon,
  });
  app.drawChart(candles, '1H');
};

test('рисует все свечи выбранного диапазона', () => {
  const { app, nodes } = loadApp();
  draw(app, null);
  const svg = nodes.get('#price-chart').innerHTML;
  assert.strictEqual((svg.match(/class="candle-body/g) || []).length, 60);
  assert.ok(!/NaN|undefined/.test(svg));
});

test('тело свечи не тоньше 3.4px даже при плотном ряде', () => {
  const { app, nodes } = loadApp();
  draw(app, null);
  const svg = nodes.get('#price-chart').innerHTML;
  const widths = [...svg.matchAll(/class="candle-body[^"]*"[^/]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(widths.length > 0);
  assert.ok(Math.min(...widths) >= 3.4, `минимальная ширина ${Math.min(...widths)}`);
});

test('не рисует объём: MOEX ISS отдаёт нули', () => {
  const { app, nodes } = loadApp();
  draw(app, null);
  assert.ok(!nodes.get('#price-chart').innerHTML.includes('volume-bar'));
});

test('без выбранного сценария уровней на графике нет', () => {
  const { app, nodes } = loadApp();
  draw(app, null);
  assert.ok(!nodes.get('#price-chart').innerHTML.includes('level-line'));
});

test('выбранный сценарий рисует стоп, вход и обе цели как кликабельные уровни', () => {
  const { app, nodes } = loadApp();
  draw(app, '1h');
  const svg = nodes.get('#price-chart').innerHTML;
  for (const cls of ['level-line stop', 'level-line entry', 'level-line target', 'level-line target soft']) {
    assert.ok(svg.includes(cls), `нет уровня ${cls}`);
  }
  assert.strictEqual((svg.match(/class="level-hit"/g) || []).length, 4);
  assert.ok(svg.includes('level-entry-zone'));
});

test('торговый билет объясняет сделку: действие, объём, риск и прибыль', () => {
  const { app, nodes } = loadApp();
  draw(app, '1h');
  const ticket = nodes.get('#chart-ticket').innerHTML;
  assert.ok(ticket.includes('ПОКУПАТЬ'));
  assert.ok(/[\d,]+ г/.test(ticket), 'нет объёма в граммах');
  assert.ok(ticket.includes('1 : '), 'нет соотношения риск/прибыль');
  assert.ok(ticket.includes('Демо-расчёт'), 'нет предупреждения о демо-режиме');
});

test('чипы выбора сценария строятся над графиком вместе с кнопкой сброса', () => {
  const { app, nodes } = loadApp();
  draw(app, '1h');
  const chips = nodes.get('#chart-horizons').innerHTML;
  assert.strictEqual((chips.match(/class="chart-chip[ "]/g) || []).length, 3);
  assert.ok(chips.includes('chart-chip clear'));
});

test('без выбора билет скрыт', () => {
  const { app, nodes } = loadApp();
  draw(app, null);
  assert.strictEqual(nodes.get('#chart-ticket').innerHTML, '');
});
