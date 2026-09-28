'use strict';

// Демо-счёт и автоторговля. Всё локально, в data/trading.json.
// Валюта баланса — рубли. Инструмент — золото GLDRUB_TOM (граммы).

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TRADING_PATH = path.join(DATA_DIR, 'trading.json');

const START_RUB = 100000;
const DEFAULT_FEE_RATE = 0.0005; // комиссия 0.05%
const FALLBACK_LOT_GR = 1; // минимальный лот, г
const FALLBACK_STEP_GR = 0.01;

// Лот и шаг цены приходят из спецификации инструмента в T-Invest API. Значения ниже —
// запасной вариант на случай, пока API недоступен; он не должен маскировать проблему.
function specOf(state) {
  const spec = state.spec || {};
  const lot = Number(spec.lot) > 0 ? Number(spec.lot) : FALLBACK_LOT_GR;
  const minPriceIncrement = Number(spec.minPriceIncrement) > 0 ? Number(spec.minPriceIncrement) : FALLBACK_STEP_GR;
  return {
    ticker: spec.ticker || 'GLDRUB_TOM',
    lot,
    minPriceIncrement,
    shortCapable: spec.shortCapable === true,
    fromBroker: Boolean(spec.ticker),
  };
}

function feeRateOf(state) {
  const rate = Number(state.autoTrading?.feeRate ?? state.feeRate);
  return Number.isFinite(rate) && rate >= 0 ? rate : DEFAULT_FEE_RATE;
}

// Округление объёма вниз до кратного лота: частичный лот заявка не примет.
function normalizeGrams(grams, spec) {
  const step = spec.lot;
  const raw = Number(grams);
  if (!Number.isFinite(raw) || step <= 0) return 0;
  return round2(Math.floor(raw / step + 1e-9) * step);
}

let timer = null;

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(TRADING_PATH, 'utf8'));
    if (raw && typeof raw === 'object' && Array.isArray(raw.orders)) return raw;
  } catch { /* нет файла — инициализируем */ }
  return {
    createdAt: new Date().toISOString(),
    cashRub: START_RUB,
    startCapitalRub: START_RUB,
    positionGrams: 0,
    avgPriceRubPerG: 0,
    realizedPnlRub: 0,
    feesRub: 0,
    orders: [],
    trades: [],
    equityCurve: [],
    autoTrading: { enabled: false, intervalMin: 10, maxOrderRub: 20000, riskNote: null },
  };
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TRADING_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
}

const round2 = (value) => Math.round(value * 100) / 100;
const fmt = (value) => Number(value || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function markToMarket(state, priceRubPerG) {
  const price = Number(priceRubPerG);
  if (!Number.isFinite(price) || price <= 0) return null;
  // Лонг: стоимость актива. Шорт: минус стоимость выкупа (выручка уже в кэше).
  return round2(state.positionGrams * price);
}

function totalEquityRub(state, priceRubPerG) {
  const pos = markToMarket(state, priceRubPerG);
  return pos === null ? null : round2(state.cashRub + pos);
}

function orderBook(state) {
  return state.orders.filter((order) => order.status === 'open');
}

function applyFill(state, order, priceRubPerG, now, fill = null, gramsOverride = null) {
  const price = round2(Number(priceRubPerG));
  const grams = gramsOverride == null ? order.grams : gramsOverride;
  const gross = round2(grams * price);
  const fee = round2(gross * feeRateOf(state));
  let pnl = null;
  const prevQty = state.positionGrams || 0;
  // Стандартная модель брокерского счёта:
  //   продажа -> кэш +gross − fee;  покупка -> кэш −gross − fee.
  // Позиция знаковая: + = лонг, − = шорт. avgPrice — средняя цена открытия текущего направления.
  if (order.side === 'buy') {
    const cost = round2(gross + fee);
    let cashOut = cost;
    if (prevQty < 0) {
      // Закрытие шорта: покупаем обратно по рыночной цене, обеспечение (выручка открытия) освобождается.
      const closingGrams = Math.min(grams, -prevQty);
      pnl = round2((state.avgPriceRubPerG - price) * closingGrams - fee);
      state.realizedPnlRub = round2(state.realizedPnlRub + pnl);
      state.shortCollateral = round2(Math.max(0, (state.shortCollateral || 0) - round2(closingGrams * state.avgPriceRubPerG)));
      // Платим только выкуп: выручка уже лежит в кэше с момента открытия.
      cashOut = gross > 0 ? round2(gross + fee) : 0;
      const excess = round2((state.cashRub || 0));
      void excess;
    }
    if (prevQty < 0) {
      state.cashRub = round2(state.cashRub - cashOut);
    } else {
      if (cost > state.cashRub + 0.01) throw Object.assign(new Error(`Недостаточно средств: нужно ${cost.toFixed(2)} ₽, доступно ${state.cashRub.toFixed(2)} ₽`), { statusCode: 400 });
      state.cashRub = round2(state.cashRub - cost);
    }
    const newQty = round2(prevQty + grams);
    if (prevQty < 0 && newQty >= 0) {
      // Шорт закрыт; остаток покупки открывает лонг по новой цене (уже оплачен выше).
      state.positionGrams = newQty;
      state.avgPriceRubPerG = newQty > 0 ? price : 0;
    } else if (prevQty < 0) {
      state.positionGrams = newQty;
    } else {
      // Наращивание лонга: средняя цена.
      const totalCost = state.avgPriceRubPerG * prevQty + gross;
      state.positionGrams = newQty;
      state.avgPriceRubPerG = newQty > 0 ? round2(totalCost / newQty) : 0;
      if (prevQty === 0) state.realizedPnlRub = round2(state.realizedPnlRub - fee);
    }
  } else {
    if (prevQty > 0) {
      // Закрытие лонга: кэш получает выручку, P&L фиксируется по закрытой части.
      pnl = round2((price - state.avgPriceRubPerG) * Math.min(grams, prevQty) - fee);
      state.realizedPnlRub = round2(state.realizedPnlRub + pnl);
      state.cashRub = round2(state.cashRub + gross - fee);
      const newQty = round2(prevQty - grams);
      state.positionGrams = newQty;
      if (newQty <= 0) {
        // Лонг закрыт; остаток продажи открывает шорт по новой цене.
        state.avgPriceRubPerG = newQty < 0 ? price : 0;
      }
    } else {
      // Открытие/наращивание шорта: выручка поступает в кэш и блокируется как обеспечение.
      const equity = totalEquityRub(state, price);
      if (equity !== null && gross > equity * 0.5) throw Object.assign(new Error(`Шорт слишком велик: ${gross.toFixed(2)} ₽ > 50% капитала (${round2(equity * 0.5).toFixed(2)} ₽)`), { statusCode: 400 });
      const totalCost = state.avgPriceRubPerG * Math.abs(prevQty) + gross;
      state.positionGrams = round2(prevQty - grams);
      state.avgPriceRubPerG = state.positionGrams < 0 ? round2(totalCost / Math.abs(state.positionGrams)) : 0;
      state.realizedPnlRub = round2(state.realizedPnlRub - fee);
      state.shortCollateral = round2((state.shortCollateral || 0) + gross);
      state.cashRub = round2(state.cashRub + gross - fee);
    }
    if (prevQty <= 0) {
      const newQty = round2(prevQty - grams);
      state.positionGrams = newQty;
    } else if (false) {
    } else {
      // Закрытие лонга продажей (частичное или полное с переворотом).
      const newQty = round2(prevQty - grams);
      state.positionGrams = newQty;
      if (newQty < 0) {
        // Переворот в шорт: новая средняя по цене сделки.
        state.avgPriceRubPerG = price;
        state.shortCollateral = round2((state.shortCollateral || 0) + Math.abs(newQty) * price);
      } else if (newQty === 0) {
        state.avgPriceRubPerG = 0;
      }
    }
  }
  state.feesRub = round2(state.feesRub + fee);
  order.status = 'filled';
  order.filledAt = now;
  order.fillPrice = price;
  order.feeRub = fee;
  const trade = {
    id: order.id,
    time: now,
    side: order.side,
    grams,
    priceRubPerG: price,
    feeRub: fee,
    reason: order.reason || null,
    source: order.source || 'manual',
    realizedPnlRub: pnl,
    metaStop: order.metaStop ?? null,
    metaTarget: order.metaTarget ?? null,
    // Данные о реальном исполнении: без них проскальзывание не посчитать.
    riskRub: order.riskRub ?? null,
    slippageRub: fill ? round2(fill.slippageRub || 0) : null,
    levelsUsed: fill ? fill.levelsUsed : null,
    execution: fill ? (fill.bookless ? 'по последней котировке, стакан недоступен' : `по стакану, уровней: ${fill.levelsUsed}`) : null,
  };
  state.trades.unshift(trade);
  state.trades = state.trades.slice(0, 500);
  return trade;
}

// Исполнение лимитной заявки по стакану: забираем уровни, пока цена позволяет.
// Если стакана нет, откатываемся на последнюю котировку и честно помечаем это.
function processOpenOrders(state, priceRubPerG, now, book = null) {
  const price = Number(priceRubPerG);
  const fills = [];
  for (const order of orderBook(state)) {
    if (!Number.isFinite(price) || price <= 0) break;
    const limit = Number(order.limitPrice);
    if (!Number.isFinite(limit)) continue;
    const eligible = filterEligibleLevels(book, order.side, limit);
    if (!eligible.length) continue;
    const remaining = Number(order.grams) - Number(order.filledGrams || 0);
    if (remaining <= 0) {
      order.status = 'filled';
      order.filledAt = now;
      continue;
    }
    try {
      const fill = fillFromLevels(eligible, remaining);
      if (!fill || fill.filledGrams <= 0) continue;
      // applyFill мутирует саму заявку: статус и счётчик исполненного должны обновиться
      // в исходном объекте, иначе частичное исполнение теряется.
      const trade = applyFill(state, order, fill.avgPrice, now, fill, fill.filledGrams);
      fills.push(trade);
      if (fill.remainingGrams > 0) {
        // Книга кончилась раньше заявки — остаток остаётся висеть.
        order.status = 'open';
        order.remainingGrams = fill.remainingGrams;
        order.partialFills = [...(order.partialFills || []), { at: now, grams: fill.filledGrams, price: fill.avgPrice }];
      }
    } catch (error) {
      order.status = 'rejected';
      order.cancelledAt = now;
      order.reason = `Отклонена: ${error.message}`;
    }
  }
  return fills;
}

// Уровни книги, доступные для лимита: покупка — аски не выше лимита, продажа — биды не ниже.
function filterEligibleLevels(book, side, limitPrice) {
  if (!book) return [];
  const rows = side === 'buy' ? book.asks : book.bids;
  return (rows || []).filter((row) => Number(row.price) > 0 && (side === 'buy' ? Number(row.price) <= limitPrice : Number(row.price) >= limitPrice));
}

// Проход по уровням до полного или частичного исполнения.
function fillFromLevels(levels, grams) {
  let remaining = Math.abs(Number(grams));
  let cost = 0;
  let filled = 0;
  const consumed = [];
  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(level.quantity));
    if (take <= 0) continue;
    cost += take * Number(level.price);
    filled += take;
    remaining -= take;
    consumed.push({ price: round2(Number(level.price)), grams: round2(take) });
  }
  if (filled <= 0) return null;
  const best = consumed[0].price;
  const worst = consumed[consumed.length - 1].price;
  return {
    filledGrams: round2(filled),
    remainingGrams: round2(Math.max(0, remaining)),
    avgPrice: round2(cost / filled),
    bestPrice: best,
    worstPrice: worst,
    levelsUsed: consumed.length,
    levels: consumed,
    slippageRub: round2((worst - best) * filled),
    exhausted: remaining > 0.0001,
  };
}

function cancelOrder(state, id, now) {
  const order = state.orders.find((item) => item.id === id && item.status === 'open');
  if (!order) throw Object.assign(new Error('Активная заявка не найдена'), { statusCode: 404 });
  order.status = 'cancelled';
  order.cancelledAt = now;
  return order;
}

function placeOrder(state, { side, grams, limitPrice, reason, source, marketPrice, book, riskRub }) {
  const spec = specOf(state);
  const quantity = normalizeGrams(grams, spec);
  if (!Number.isFinite(quantity) || quantity < spec.lot - 1e-9) {
    throw Object.assign(new Error(`Минимальный лот по спецификации ${spec.ticker}: ${spec.lot} г${spec.fromBroker ? '' : ' (запасное значение, спецификация брокера не получена)'}`), { statusCode: 400 });
  }
  if (!['buy', 'sell'].includes(side)) throw Object.assign(new Error('side должен быть buy|sell'), { statusCode: 400 });
  if (side === 'sell' && Number(state.positionGrams || 0) >= 0 && !spec.shortCapable) {
    throw Object.assign(new Error(`${spec.ticker}: спот, короткая продажа недоступна. Переключите инструмент на производный или закройте лонг.`), { statusCode: 400 });
  }
  const price = Number(marketPrice);
  if (!Number.isFinite(price) || price <= 0) throw Object.assign(new Error('Нет котировки для заявки'), { statusCode: 502 });
  const order = {
    id: `ord_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    side,
    grams: quantity,
    type: limitPrice != null ? 'limit' : 'market',
    limitPrice: limitPrice != null ? round2(Number(limitPrice)) : null,
    status: 'open',
    filledGrams: 0,
    createdAt: new Date().toISOString(),
    reason: reason || null,
    source: source || 'manual',
    riskRub: Number.isFinite(Number(riskRub)) ? round2(Number(riskRub)) : null,
  };
  state.orders.unshift(order);
  state.orders = state.orders.slice(0, 300);
  if (order.type === 'market') {
    // Рыночная заявка исполняется по стакану: реальная средняя цена вместо последнего тика.
    const levels = filterEligibleLevels(book, side, side === 'buy' ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER);
    const fill = levels.length ? fillFromLevels(levels, quantity) : null;
    if (fill) {
      const trade = applyFill(state, order, fill.avgPrice, new Date().toISOString(), fill, fill.filledGrams);
      if (fill.remainingGrams > 0) {
        order.status = 'open';
        order.remainingGrams = fill.remainingGrams;
        order.partialFills = [{ at: new Date().toISOString(), grams: fill.filledGrams, price: fill.avgPrice }];
        trade.partial = true;
      }
    } else {
      applyFill(state, order, price, new Date().toISOString(), { bookless: true, slippageRub: 0 });
    }
  }
  return order;
}

function snapshot(state, priceRubPerG) {
  const price = Number(priceRubPerG);
  return {
    cashRub: state.cashRub,
    positionGrams: state.positionGrams,
    avgPriceRubPerG: state.avgPriceRubPerG,
    realizedPnlRub: state.realizedPnlRub,
    feesRub: state.feesRub,
    positionValueRub: markToMarket(state, price),
    totalEquityRub: totalEquityRub(state, price),
    openOrders: orderBook(state).length,
    autoTrading: state.autoTrading,
  };
}

function recordEquity(state, priceRubPerG) {
  const equity = totalEquityRub(state, priceRubPerG);
  if (equity === null) return;
  const now = new Date().toISOString();
  const last = state.equityCurve[0];
  if (last && new Date(now) - new Date(last.time) < 60_000) {
    last.equityRub = equity;
    last.priceRubPerG = round2(Number(priceRubPerG));
    return;
  }
  state.equityCurve.unshift({ time: now, equityRub: equity, priceRubPerG: round2(Number(priceRubPerG)) });
  state.equityCurve = state.equityCurve.slice(0, 2000);
}

// ---------- Автотрейдер ----------

function decideFromForecasts(forecasts, price) {
  // Приоритет: свежий сценарий с наибольшей уверенностью среди не-wait.
  const actionable = forecasts
    .filter((f) => f.action === 'long' || f.action === 'short')
    .filter((f) => new Date(f.expiresAt || Date.now() + 1) > new Date())
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const best = actionable[0];
  if (!best) return { doTrade: false, why: 'Нет активных направленных сценариев' };
  const entryLow = Number(best.entryLow);
  const entryHigh = Number(best.entryHigh);
  const inZone = Number.isFinite(entryLow) && Number.isFinite(entryHigh) && price >= Math.min(entryLow, entryHigh) && price <= Math.max(entryLow, entryHigh);
  if (!inZone) {
    return { doTrade: false, why: `Цена ${price.toFixed(2)} вне зоны входа ${entryLow.toFixed(2)}–${entryHigh.toFixed(2)} (${best.horizonLabel})` };
  }
  return {
    doTrade: true,
    side: best.action === 'long' ? 'buy' : 'sell',
    horizon: best.horizonLabel,
    confidence: best.confidence,
    target: best.target1,
    stop: best.stop,
    why: `${best.action === 'long' ? 'Лонг' : 'Шорт'} по сценарию ${best.horizonLabel}: цена в зоне входа, уверенность ${best.confidence}%, цель ${Number(best.target1).toFixed(2)}, стоп ${Number(best.stop).toFixed(2)}. ${best.rationale || ''}`,
  };
}

// Expectancy и просадка. Expectancy — средний результат закрытой сделки; в единицах R
// она показывает, перевешивает ли средняя прибыль средний убыток вместе с издержками.
function performanceMetrics(state) {
  const closed = (state.trades || []).filter((trade) => trade.realizedPnlRub != null);
  const wins = closed.filter((trade) => trade.realizedPnlRub > 0);
  const losses = closed.filter((trade) => trade.realizedPnlRub < 0);
  const sum = (rows) => rows.reduce((acc, row) => acc + row.realizedPnlRub, 0);
  const totalWins = sum(wins);
  const totalLosses = Math.abs(sum(losses));

  const curve = (state.equityCurve || []).slice().reverse();
  let peak = null;
  let maxDrawdownRub = 0;
  let maxDrawdownPct = 0;
  let currentDrawdownRub = 0;
  let currentDrawdownPct = 0;
  for (const point of curve) {
    const equity = Number(point.equityRub);
    if (!Number.isFinite(equity)) continue;
    if (peak === null || equity > peak) peak = equity;
    const dd = peak - equity;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDrawdownRub) { maxDrawdownRub = dd; maxDrawdownPct = ddPct; }
    currentDrawdownRub = dd;
    currentDrawdownPct = ddPct;
  }

  // R считаем по зафиксированному риску сделки; если он неизвестен, сделка в R не идёт.
  const inR = closed.filter((trade) => Number(trade.riskRub) > 0);
  const rSum = inR.reduce((acc, trade) => acc + trade.realizedPnlRub / trade.riskRub, 0);

  return {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? round2((wins.length / closed.length) * 100) : null,
    grossProfitRub: round2(totalWins),
    grossLossRub: round2(totalLosses),
    netPnlRub: round2(totalWins - totalLosses),
    // Expectancy в рублях и в долях риска — это разные вопросы об одном и том же.
    expectancyRub: closed.length ? round2((totalWins - totalLosses) / closed.length) : null,
    expectancyR: inR.length ? round2(rSum / inR.length) : null,
    tradesInR: inR.length,
    avgWinRub: wins.length ? round2(totalWins / wins.length) : null,
    avgLossRub: losses.length ? round2(totalLosses / losses.length) : null,
    profitFactor: totalLosses > 0 ? round2(totalWins / totalLosses) : (totalWins > 0 ? null : null),
    payoffRatio: losses.length && wins.length ? round2((totalWins / wins.length) / (totalLosses / losses.length)) : null,
    maxDrawdownRub: round2(maxDrawdownRub),
    maxDrawdownPct: round2(maxDrawdownPct),
    currentDrawdownRub: round2(currentDrawdownRub),
    currentDrawdownPct: round2(currentDrawdownPct),
    peakEquityRub: peak == null ? null : round2(peak),
    feesRub: round2((state.trades || []).reduce((acc, trade) => acc + Number(trade.feeRub || 0), 0)),
    slippageRub: round2((state.trades || []).reduce((acc, trade) => acc + Number(trade.slippageRub || 0), 0)),
    points: curve.length,
    note: inR.length < closed.length
      ? `В единицах R учтено ${inR.length} из ${closed.length} сделок: риск фиксируется только для сделок, открытых со стопом.`
      : null,
  };
}

function autoTradeTick({ market, forecasts, book = null }) {
  const state = readState();
  const price = Number(market?.candles?.at(-1)?.close || market?.quote?.last);
  if (!Number.isFinite(price) || price <= 0) return { state, snapshot: snapshot(state, NaN), events: [{ type: 'skip', why: 'Нет котировки' }] };
  const now = new Date().toISOString();
  const events = [];
  const fills = processOpenOrders(state, price, now, book);
  fills.forEach((trade) => events.push({ type: 'fill', trade }));

  if (!state.autoTrading.enabled) {
    writeState(state);
    return { state, snapshot: snapshot(state, price), events };
  }

  // Управление открытой позицией (лонг или шорт): стоп/тейк из уровней сценария, разворот по сигналам
  if (state.positionGrams !== 0) {
    const isLong = state.positionGrams > 0;
    const entry = state.avgPriceRubPerG;
    const movePct = entry > 0 ? (isLong ? (price - entry) / entry : (entry - price) / entry) : 0;
    const closeReason = (why) => applyFill(state, {
      id: `ord_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      side: isLong ? 'sell' : 'buy',
      grams: Math.abs(state.positionGrams),
      type: 'market',
      limitPrice: null,
      status: 'open',
      createdAt: now,
      reason: why,
      source: 'auto',
    }, price, now);
    const decision = decideFromForecasts(forecasts || [], price);
    const signalAgainst = decision.doTrade && ((isLong && decision.side === 'sell') || (!isLong && decision.side === 'buy'));
    // Уровни из сценария, по которому открыта позиция; фолбэк — фиксированные 0,4%/0,8%.
    const levelStop = state.openPosition?.stop != null && Number.isFinite(Number(state.openPosition.stop)) ? Number(state.openPosition.stop) : null;
    const levelTarget = state.openPosition?.target != null && Number.isFinite(Number(state.openPosition.target)) ? Number(state.openPosition.target) : null;
    const stopHit = levelStop !== null ? (isLong ? price <= levelStop : price >= levelStop) : movePct <= -0.004;
    const targetHit = levelTarget !== null ? (isLong ? price >= levelTarget : price <= levelTarget) : movePct >= 0.008;
    const stopLabel = levelStop !== null ? `Стоп-лосс по уровню ${fmt(levelStop)} (${(movePct * 100).toFixed(2)}%)` : `Стоп-лосс ${(movePct * 100).toFixed(2)}%`;
    const targetLabel = levelTarget !== null ? `Тейк-профит по уровню ${fmt(levelTarget)} (+${(movePct * 100).toFixed(2)}%)` : `Тейк-профит +${(movePct * 100).toFixed(2)}%`;
    if (stopHit) {
      events.push({ type: 'fill', trade: closeReason(stopLabel) });
    } else if (targetHit) {
      events.push({ type: 'fill', trade: closeReason(targetLabel) });
    } else if (signalAgainst) {
      events.push({ type: 'fill', trade: closeReason(`Сигнал против позиции (${decision.horizon})`) });
    }
  }

  if (state.positionGrams === 0) {
    const decision = decideFromForecasts(forecasts || [], price);
    if (decision.doTrade) {
      const budget = Math.min(Number(state.autoTrading.maxOrderRub) || 20000, state.cashRub);
      const spec = specOf(state);
      const grams = normalizeGrams(budget / price, spec);
      if (grams >= spec.lot - 1e-9) {
        const entryRef = decision.entry || (Number(decision.entryLow) + Number(decision.entryHigh)) / 2 || price;
        const riskRub = round2(grams * Math.abs(entryRef - Number(decision.stop || price)));
        const order = placeOrder(state, { side: decision.side, grams, marketPrice: price, reason: decision.why, source: 'auto', book, riskRub });
        // Запоминаем уровни сценария для ведения позиции.
        state.openPosition = {
          stop: Number.isFinite(Number(decision.stop)) ? Number(decision.stop) : null,
          target: Number.isFinite(Number(decision.target)) ? Number(decision.target) : null,
          horizon: decision.horizon || null,
          openedAt: now,
        };
        events.push({ type: 'order', order });
      }
    } else {
      events.push({ type: 'skip', why: decision.why });
    }
  } else if (state.positionGrams !== 0 && !state.openPosition) {
    // Позиция есть, а уровней нет (например, после перезапуска) — восстановим из последней авто-сделки.
    const lastAuto = (state.trades || []).find((t) => t.source === 'auto' && t.metaStop != null);
    state.openPosition = {
      stop: lastAuto?.metaStop != null && Number.isFinite(Number(lastAuto.metaStop)) ? Number(lastAuto.metaStop) : null,
      target: lastAuto?.metaTarget != null && Number.isFinite(Number(lastAuto.metaTarget)) ? Number(lastAuto.metaTarget) : null,
      horizon: null,
      openedAt: now,
    };
  }

  recordEquity(state, price);
  writeState(state);
  return { state, snapshot: snapshot(state, price), events };
}

function startAutoTrading(intervalMin, tickFn) {
  stopAutoTrading();
  if (typeof tickFn !== 'function') throw new Error('startAutoTrading: нужна функция тика');
  const minutes = Math.max(5, Math.min(60, Number(intervalMin) || 10));
  const jitterMs = Math.floor(Math.random() * 5 * 60_000);
  const periodMs = minutes * 60_000 + jitterMs;
  timer = setInterval(async () => {
    try {
      const result = await tickFn();
      (result?.events || []).forEach((event) => {
        if (event.type === 'fill') console.log(`[autotrade] исполнено: ${event.trade.side} ${event.trade.grams}г @ ${event.trade.priceRubPerG}₽ — ${event.trade.reason || ''}`);
        if (event.type === 'skip') console.log(`[autotrade] пропуск: ${event.why}`);
        if (event.type === 'order') console.log(`[autotrade] заявка: ${event.order.side} ${event.order.grams}г`);
      });
    } catch (error) {
      console.error('[autotrade] ошибка тика:', error.message);
    }
  }, periodMs);
  return { intervalMin: minutes, periodMs };
}

function stopAutoTrading() {
  if (timer) { clearInterval(timer); timer = null; }
}

function autoTradingStatus() {
  return { running: Boolean(timer) };
}

module.exports = {
  readState,
  writeState,
  placeOrder,
  cancelOrder,
  processOpenOrders,
  snapshot,
  recordEquity,
  autoTradeTick,
  decideFromForecasts,
  startAutoTrading,
  stopAutoTrading,
  autoTradingStatus,
  DEFAULT_FEE_RATE,
  START_RUB,
  FALLBACK_LOT_GR,
  specOf,
  normalizeGrams,
  feeRateOf,
  fillFromLevels,
  filterEligibleLevels,
  performanceMetrics,
};
