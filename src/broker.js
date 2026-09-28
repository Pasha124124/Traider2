'use strict';

// Слой брокера: какие золотые инструменты доступны, их спецификация и стакан.
//
// Спецификация (лот, шаг цены) берётся из T-Invest API, а не из констант: лот и шаг
// у биржевых инструментов разные, и неверный лот приводит к отказу заявки.
// Стакан нужен для честного исполнения — без него проскальзывание считается нулём.

const TINVEST_BASE = 'https://invest-public-api.tbank.ru/rest/tinkoff.public.invest.api.contract.v1';

// Типы, по которым инструмент считается производным: на них у брокера возможен шорт.
const DERIVATIVE_KINDS = new Set([
  'INSTRUMENT_TYPE_FUTURES',
  'INSTRUMENT_TYPE_CFD',
  'INSTRUMENT_TYPE_CFD_ETF',
  'INSTRUMENT_TYPE_COMMODITY',
  'INSTRUMENT_TYPE_FUTURES_OPTION',
]);

const SPOT_KINDS = new Set([
  'INSTRUMENT_TYPE_SHARE',
  'INSTRUMENT_TYPE_BOND',
  'INSTRUMENT_TYPE_ETF',
  'INSTRUMENT_TYPE_CURRENCY',
  'INSTRUMENT_TYPE_SP',
]);

const round2 = (value) => Math.round(Number(value) * 100) / 100;

async function tInvestPost(token, serviceMethod, payload, fetchJson, timeoutMs = 12000) {
  return fetchJson(`${TINVEST_BASE}.${serviceMethod}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
    timeoutMs,
  });
}

function classify(instrument) {
  const kind = String(instrument.instrumentType || instrument.kind || '').toUpperCase();
  const ticker = String(instrument.ticker || '').toUpperCase();
  const derivative = DERIVATIVE_KINDS.has(kind) || (!SPOT_KINDS.has(kind) && /FUT|CFD|GLD.*F\d/i.test(ticker));
  return {
    shortCapable: derivative,
    kindLabel: derivative ? 'производный инструмент' : kind ? kind.replace('INSTRUMENT_TYPE_', '').toLowerCase() : 'спот',
  };
}

function toSpec(instrument) {
  const lot = Number(instrument.lot);
  const tick = Number(instrument.minPriceIncrement ?? instrument.minPriceIncrementValue);
  const classified = classify(instrument);
  return {
    ticker: instrument.ticker,
    figi: instrument.figi || instrument.uid || null,
    uid: instrument.uid || null,
    name: instrument.name || instrument.ticker,
    exchange: instrument.exchange || null,
    currency: instrument.currency || null,
    kind: instrument.instrumentType || instrument.kind || null,
    kindLabel: classified.kindLabel,
    // Лот приходит в единицах инструмента; для золота это граммы.
    lot: Number.isFinite(lot) && lot > 0 ? lot : 1,
    minPriceIncrement: Number.isFinite(tick) && tick > 0 ? tick : 0.01,
    tradable: instrument.apiTradeAvailableFlag !== false,
    shortCapable: classified.shortCapable,
    shortNote: classified.shortCapable
      ? 'Производный инструмент: короткая позиция возможна, но требует маржи и договора с брокером.'
      : 'Спот: короткая продажа недоступна без отдельного соглашения с брокером.',
  };
}

// Ищет доступные золотые инструменты: сначала по тикеру, затем по названию.
async function discoverGoldInstruments(token, fetchJson) {
  const queries = ['GLDRUB', 'GLD', 'Золото'];
  const found = new Map();
  for (const query of queries) {
    let response;
    try {
      response = await tInvestPost(token, 'InstrumentsService/FindInstrument', { query }, fetchJson, 9000);
    } catch {
      continue;
    }
    for (const instrument of response.instruments || []) {
      const ticker = String(instrument.ticker || '');
      const text = `${ticker} ${instrument.name || ''}`.toUpperCase();
      const isGold = /GLDRUB|GLD|ЗОЛОТ|GOLD|XAU/.test(text) && instrument.currency === 'rub';
      if (!isGold || found.has(ticker)) continue;
      found.set(ticker, toSpec(instrument));
    }
  }
  const list = [...found.values()].sort((a, b) => {
    if (a.shortCapable !== b.shortCapable) return a.shortCapable ? -1 : 1;
    return a.ticker.localeCompare(b.ticker);
  });
  if (!list.length) throw new Error('T-Invest API не вернул золотых инструментов в рублях для этого счёта.');
  return list;
}

// Полная спецификация по тикеру: сначала кэш поиска, затем прямой запрос.
async function resolveInstrument(token, ticker, fetchJson) {
  const response = await tInvestPost(token, 'InstrumentsService/FindInstrument', { query: ticker }, fetchJson, 9000);
  const instruments = response.instruments || [];
  const exact = instruments.find((item) => item.ticker === ticker) ||
    instruments.find((item) => String(item.ticker || '').includes(ticker));
  if (!exact) throw new Error(`T-Invest API не вернул инструмент ${ticker}.`);
  return toSpec(exact);
}

// Стакан: bids/asks по убыванию/возрастанию цены, нормализованные к числам.
function normalizeLevels(rows) {
  return (rows || [])
    .map((row) => ({
      price: Number(row.price ?? row.Price ?? row[0]),
      quantity: Number(row.quantity ?? row.Quantity ?? row[1]),
    }))
    .filter((row) => Number.isFinite(row.price) && row.price > 0 && Number.isFinite(row.quantity) && row.quantity > 0)
    .sort((a, b) => a.price - b.price);
}

async function tInvestOrderBook(token, figi, fetchJson) {
  const response = await tInvestPost(token, 'MarketdataService/GetOrderBook', { figi, depth: 50 }, fetchJson, 9000);
  const book = response.limitOrders || response.orderBook || {};
  const bids = normalizeLevels(book.bids).sort((a, b) => b.price - a.price);
  const asks = normalizeLevels(book.asks);
  if (!bids.length && !asks.length) throw new Error('Биржа вернула пустой стакан.');
  return { source: 't-invest', bids, asks, fetchedAt: new Date().toISOString() };
}

// Резервный стакан с публичного MOEX ISS, если T-Invest недоступен.
// GLDRUB_TOM торгуется на доске CETS (движок currency, рынок selt), поэтому путь
// доски задан явно: общий /markets/index для этого инструмента отдаёт пустую книгу.
async function moexOrderBook(ticker, fetchJson, board = 'CETS') {
  const base = 'https://iss.moex.com/iss/engines/currency/markets/selt/boards';
  const sec = encodeURIComponent(ticker);
  const attempts = [
    `${base}/${board}/securities/${sec}/orderbook.json?depth=30&iss.meta=off&iss.only=orderbook`,
    `${base}/${board}/securities/${sec}/orderbook.json?depth=30&iss.meta=off`,
    `https://iss.moex.com/iss/securities/${sec}/orderbook.json?depth=30&iss.meta=off&iss.only=orderbook`,
  ];
  let lastError = null;
  for (const url of attempts) {
    try {
      const data = await fetchJson(url, { timeoutMs: 9000, asText: true });
      if (typeof data === 'string') { lastError = new Error('MOEX ISS вернул не JSON (возможно, доска недоступна вне сессии).'); continue; }
      const blocks = [].concat(data.orderboard || data.orderbook || []);
      const block = blocks[0];
      if (!block) { lastError = new Error('MOEX ISS вернул пустой стакан.'); continue; }
      const column = (name) => block[`${name.toUpperCase()}_PRICE`] || null;
      const bids = (Array.isArray(block.bids) ? block.bids : []).map((row) => ({ price: Number(row[0]), quantity: Number(row[2]) }));
      const asks = (Array.isArray(block.asks) ? block.asks : []).map((row) => ({ price: Number(row[0]), quantity: Number(row[2]) }));
      const cleanBids = bids.filter((row) => row.price > 0 && row.quantity > 0).sort((a, b) => b.price - a.price);
      const cleanAsks = asks.filter((row) => row.price > 0 && row.quantity > 0).sort((a, b) => a.price - b.price);
      if (!cleanBids.length && !cleanAsks.length) { lastError = new Error('MOEX ISS вернул стакан без заявок.'); continue; }
      return { source: 'moex-iss', bids: cleanBids, asks: cleanAsks, fetchedAt: new Date().toISOString(), columns: Boolean(column) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('MOEX ISS недоступен.');
}

// Лучшие цены и глубина, на которых реально исполнится заявка указанного объёма.
function simulateFill(book, side, grams) {
  const levels = side === 'buy' ? book.asks : book.bids;
  const opposite = side === 'buy' ? book.bids : book.asks;
  if (!levels?.length) return null;
  let remaining = Math.abs(Number(grams));
  let cost = 0;
  let filled = 0;
  const consumed = [];
  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.quantity);
    cost += take * level.price;
    filled += take;
    remaining -= take;
    consumed.push({ price: round2(level.price), grams: round2(take) });
  }
  if (filled <= 0) return null;
  const worst = consumed[consumed.length - 1].price;
  const best = consumed[0].price;
  return {
    filledGrams: round2(filled),
    remainingGrams: round2(Math.max(0, remaining)),
    avgPrice: round2(cost / filled),
    bestPrice: round2(best),
    worstPrice: round2(worst),
    slippageRub: round2((worst - best) * filled),
    levelsUsed: consumed.length,
    levels: consumed,
    exhausted: remaining > 0.0001,
    // Верхняя граница цены: для покупки — лучший аск, для продажи — лучший бид.
    touchPrice: round2(levels[0].price),
    oppositeTouch: opposite?.length ? round2(opposite[0].price) : null,
    spread: opposite?.length ? round2(Math.abs(levels[0].price - opposite[0].price)) : null,
  };
}

function orderBookStats(book, price) {
  const bid = book.bids?.[0]?.price ?? null;
  const ask = book.asks?.[0]?.price ?? null;
  const mid = bid && ask ? (bid + ask) / 2 : null;
  const sum = (rows) => (rows || []).reduce((acc, row) => acc + row.price * row.quantity, 0);
  const qty = (rows) => (rows || []).reduce((acc, row) => acc + row.quantity, 0);
  return {
    bestBid: bid,
    bestAsk: ask,
    mid,
    spread: bid && ask ? round2(ask - bid) : null,
    spreadPct: bid && ask ? round2(((ask - bid) / mid) * 100) : null,
    bidVolume: round2(qty(book.bids)),
    askVolume: round2(qty(book.asks)),
    imbalance: qty(book.bids) + qty(book.asks) > 0
      ? round2((qty(book.bids) - qty(book.asks)) / (qty(book.bids) + qty(book.asks)) * 100)
      : null,
    notionalBid: round2(sum(book.bids)),
    notionalAsk: round2(sum(book.asks)),
    distanceToMid: mid && price ? round2(price - mid) : null,
  };
}

module.exports = { discoverGoldInstruments, resolveInstrument, tInvestOrderBook, moexOrderBook, simulateFill, orderBookStats, normalizeLevels, classify };
