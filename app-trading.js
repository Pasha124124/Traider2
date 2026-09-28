// Обвязка новых блоков: переключатель инструмента, комиссия, новостная модель.
// Отдельный файл, потому что app.js уже большой; пользуется общим глобальным
// лексическим окружением классических скриптов ($ , api, state, refreshTrading…).

(() => {
  const on = (selector, event, handler) => document.querySelector(selector)?.addEventListener(event, handler);

  on('#instrument-reload', 'click', () => loadInstruments());

  on('#instrument-select', 'change', (event) => {
    const spec = (state.instruments || []).find((item) => item.ticker === event.target.value);
    if (spec) renderInstrumentSpec(spec);
  });

  on('#instrument-apply', 'click', async (event) => {
    const ticker = document.querySelector('#instrument-select')?.value;
    if (!ticker) return notify('Выберите инструмент.', 'error');
    setLoading(event.currentTarget, true, 'Переключаем…');
    try {
      const data = await api('/api/config/instrument', { method: 'POST', body: JSON.stringify({ ticker }) });
      notify(`Инструмент ${ticker}: лот ${data.spec.lot} г, шорт ${data.spec.shortCapable ? 'возможен' : 'недоступен'}.`);
      await loadMarket();
      await refreshTrading();
      loadInstruments();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setLoading(event.currentTarget, false);
    }
  });

  on('#fee-save', 'click', async (event) => {
    const feeRate = Number(document.querySelector('#fee-rate').value) / 100;
    if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > 0.05) return notify('Комиссия должна быть от 0 до 5%.', 'error');
    setLoading(event.currentTarget, true, 'Сохраняем…');
    try {
      await saveConfig({ feeRate }, 'Комиссия сохранена.');
      await refreshTrading();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setLoading(event.currentTarget, false);
    }
  });

  // Список инструментов и новостная модель подтягиваются при открытии своих разделов.
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('.nav-item[data-view], [data-view-link]');
    const view = trigger?.dataset.view || trigger?.dataset.viewLink;
    if (view === 'connections') loadInstruments();
    if (view === 'trading') loadNewsModel();
  });

  // Первичная загрузка: спецификация, стакан с метриками и новостной сценарий.
  Promise.allSettled([
    loadNewsModel(),
    refreshTrading(),
    api('/api/config').then((config) => {
      const field = document.querySelector('#fee-rate');
      if (field && config?.feeRate != null) field.value = String(config.feeRate * 100);
    }),
  ]);
})();
