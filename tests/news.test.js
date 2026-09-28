// Тональная оценка новостей: правила направления, агрегация по источникам,
// ограничение влияния на сценарий.
const test = require('node:test');
const assert = require('node:assert');
const { scoreHeadline, buildNewsImpact, parseRss } = require('../src/news');
const { analyzeMarket } = require('../src/analysis');

test('ослабление рубля читается как поддержка золота, а не как негатив', () => {
  const verdict = scoreHeadline('Рубль на Московской бирже подешевел к юаню');
  assert.ok(verdict, 'заголовок не распознан');
  assert.strictEqual(verdict.tone, 'positive');
});

test('укрепление рубля давит на золото в рублях', () => {
  const verdict = scoreHeadline('Рубль укрепился после решения регулятора');
  assert.strictEqual(verdict.tone, 'negative');
});

test('ставка и цена золота читаются прямо', () => {
  assert.strictEqual(scoreHeadline('ЦБ РФ повысил ключевую ставку').tone, 'negative');
  assert.strictEqual(scoreHeadline('Банк России снизил ключевую ставку').tone, 'positive');
  assert.strictEqual(scoreHeadline('Золото подорожало на фоне ослабления доллара').tone, 'positive');
  assert.strictEqual(scoreHeadline('Золото обвалилось, зафиксирована распродажа золота').tone, 'negative');
});

test('бытовые и политические новости без финансовой привязки отбрасываются', () => {
  assert.strictEqual(scoreHeadline('Компания представила новые стиральные машины'), null);
  assert.strictEqual(scoreHeadline('Путин встретился с лидерами партий Госдумы'), null);
});

test('RSS разбирается без внешних зависимостей', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[Золото дорожает]]></title><link>https://example.com/1</link><pubDate>Mon, 28 Sep 2026 10:00:00 +0300</pubDate><description>Рост &amp; падение</description></item>
    <item><title>Без ссылки</title></item>
  </channel></rss>`;
  const items = parseRss(xml);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, 'Золото дорожает');
  assert.strictEqual(items[0].summary, 'Рост & падение');
});

test('перевес считается по источникам: один источник не перевешивает три независимых', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    title: 'Золото обвалилось, идёт распродажа золота', source: 'А', sourceWeight: 1, publishedAt: null, summary: '', url: `a${i}`,
  }));
  const against = [
    { title: 'Золото подорожало, вырос спрос на золото', source: 'Б', sourceWeight: 1, publishedAt: null, summary: '', url: 'b1' },
    { title: 'Золото подорожало, вырос спрос на золото', source: 'В', sourceWeight: 1, publishedAt: null, summary: '', url: 'v1' },
    { title: 'Золото подорожало, вырос спрос на золото', source: 'Г', sourceWeight: 1, publishedAt: null, summary: '', url: 'g1' },
  ];
  const impact = buildNewsImpact([...many, ...against]);
  assert.ok(impact.sources.length >= 4);
  assert.ok(impact.bias > 0, `перевес должен быть в пользу роста, получили ${impact.bias}`);
});

test('разрозненные заголовки не влияют на сценарий', () => {
  const impact = buildNewsImpact([
    { title: 'Золото обвалилось', source: 'А', sourceWeight: 1, publishedAt: null, summary: '', url: 'a' },
  ]);
  assert.strictEqual(impact.enough, false);
  assert.strictEqual(impact.impact, 0);
});

test('анализ без новостей остаётся чисто техническим', () => {
  const series = Array.from({ length: 120 }, (_, i) => ({ time: new Date(Date.UTC(2026, 8, 28, 8, i)).toISOString(), open: 100, high: 101, low: 99, close: 100 + i * 0.05, volume: 10 }));
  const analysis = analyzeMarket(series, { provider: 'test' });
  assert.strictEqual(analysis.news.enabled, false);
  assert.strictEqual(analysis.trendScore, analysis.technicalTrendScore);
  assert.ok(analysis.factors.some((f) => f.label === 'Российские новости' && f.sentiment === 'missing'));
});

test('новостной фон сдвигает импульс, но не более чем на 15 баллов', () => {
  const series = Array.from({ length: 120 }, (_, i) => ({ time: new Date(Date.UTC(2026, 8, 28, 8, i)).toISOString(), open: 100, high: 101, low: 99, close: 100 + i * 0.05, volume: 10 }));
  const base = analyzeMarket(series, { provider: 'test' });
  const shift = (percent) => {
    const sources = ['А', 'Б', 'В'].map((source, i) => ({
      title: 'Золото дорожает, растёт спрос на золото', source, sourceWeight: 1, publishedAt: null, summary: '', url: `${source}${i}`,
    }));
    const impact = buildNewsImpact([...sources, ...Array.from({ length: percent }, (_, i) => ({ title: 'Золото дорожает, растёт спрос на золото', source: `А${i}`, sourceWeight: 1, publishedAt: null, summary: '', url: `x${i}` }))]);
    return analyzeMarket(series, { provider: 'test', news: impact });
  };
  const withNews = shift(20);
  assert.ok(Math.abs(withNews.trendScore - base.trendScore) <= 15, `сдвиг ${withNews.trendScore - base.trendScore} слишком велик`);
  assert.ok(withNews.news.shift > 0, 'ожидался положительный сдвиг');
  assert.ok(withNews.commentary.includes('Новостной фон'));
});
