'use strict';

// Российские новостные источники и их влияние на сценарий.
//
// Основной режим — RSS без API-ключей: Банк России, Интерфакс, ТАСС и ещё несколько
// лент. Дополнительно, если в окружении задан WEBZ_API_TOKEN, подключается Webz.io:
// у него шире покрытие русскоязычных финансовых публикаций и есть поиск по смыслу.
//
// Оценка влияния намеренно консервативна: заголовки могут лишь слегка сдвинуть
// сводный импульс и никогда не создают сигнал сами по себе. Без свечей по цене
// анализ не выполняется вовсе, новости его не заменяют.

const DEFAULT_FEEDS = [
  { id: 'cbr', name: 'Банк России', url: 'https://www.cbr.ru/rss/RssNews', lang: 'ru', weight: 1.35, required: true },
  { id: 'cbr-events', name: 'Банк России · события', url: 'https://www.cbr.ru/rss/eventrss', lang: 'ru', weight: 1.1 },
  { id: 'interfax', name: 'Интерфакс', url: 'https://www.interfax.ru/rss', lang: 'ru', weight: 1 },
  { id: 'tass', name: 'ТАСС', url: 'https://tass.ru/rss/v2.xml', lang: 'ru', weight: 1 },
  { id: 'banki', name: 'Банки.ру', url: 'https://www.banki.ru/xml/news.xml', lang: 'ru', weight: 0.9 },
  { id: 'ixbt', name: 'iXBT', url: 'https://www.ixbt.com/export/news.rss', lang: 'ru', weight: 0.7 },
  { id: 'moex', name: 'MOEX ISS · новости', url: null, lang: 'ru', weight: 1 },
];

// Темы, ради которых заголовок вообще попадает в расчёт: золото, рубль, ставка, ДКР.
const TOPIC_TERMS = [
  { re: /золот(о|а|ом|ые|ых|ам|ами|ах)?/i, weight: 1.6, label: 'золото' },
  { re: /обезличенн(ый|ое|ого|ым)|Au\s*999|GDRUB|GLDRUB/i, weight: 1.5, label: 'металл' },
  { re: /доллар(а|ов|у|е|ы)?|USD|RUB|рубл(ь|я|ю|е|ём)|курс/i, weight: 1.05, label: 'курс' },
  { re: /ключевая ставка|ставк(а|и|у|е|ой)|ДКР|ЦБ|Банк России|регулятор/i, weight: 1.25, label: 'ставка ЦБ' },
  { re: /инфляци|дефляци/i, weight: 1, label: 'инфляция' },
  { re: /Минфин|бюджет|дефицит|санкц(и|ий|иям)|эмбарго|пошлин/i, weight: 0.9, label: 'госполитика' },
  { re: /нефт(ь|и|ю|ью)| Brent| Brent|WTI|сырь/i, weight: 0.8, label: 'сырьё' },
  { re: /ФРС|сокращ(а|ение) ставки|повышен(ие|ия) ставки/i, weight: 1.15, label: 'ДКР' },
  { re: /геополит|санкц|войн|конфликт|обстрел|атаки/i, weight: 0.85, label: 'геополитика' },
];

// Направление в заголовке определяем явными правилами, а не общим словарём.
// Ключевой случай: для золота в рублях ослабление рубля — позитив, а не негатив,
// поэтому общие слова вроде «подешевел» без привязки к инструменту не применяются.
const DIRECTION_RULES = [
  { id: 'rub-weak', re: /рубл[ьияюе]{1,3}(\s+\S+){0,3}\s+(подешевел[аи]?|ослаб[аи]?|упал[аи]?|снизил[аи]?|слабе[еа]?|дешеве)/i, re2: /(дешеве(ет|ют)|слабе(ет|ют))\s+(\S+\s+){0,2}рубл/i, sign: 1, weight: 1.2, note: 'ослабление рубля поддерживает золото в рублях' },
  { id: 'rub-strong', re: /рубл[ьияюе]{1,3}(\s+\S+){0,3}\s+(окреп[аио]?|укрепил[аио]?|подорожал[аио]?|прос[её]л[аио]?|крепок)/i, re2: /(окреп(ляет|ился)?|крепок)\s+(\S+\s+){0,2}рубл/i, sign: -1, weight: 1.2, note: 'укрепление рубля давит на золото в рублях' },
  { id: 'gold-up', re: /золот[оуа](\s+\S+){0,2}\s+(подорож[аа]?|вырос|раст[её]т|прибав[аи]?|превыс[аи]?[лт]|обнов[аи]л[аи]? максимум)/i, re2: /(спрос|интерес)[а-я ]{0,20}золот/i, sign: 1, weight: 1.3, note: 'золото укрепляется' },
  { id: 'gold-down', re: /золот[оуа](\s+\S+){0,2}\s+(подешеве[лт]|упал[аио]?|обвалил|снизил[аио]?|коррекци)/i, re2: /(распродаж[ауы]|отток)[а-я ]{0,20}золот/i, sign: -1, weight: 1.3, note: 'золото слабеет' },
  { id: 'rate-hike', re: /(повысил|повышение|поднял[аи]?|ужесточен)\w*\s+(ключевую\s+)?ставк/i, re2: /(жёстк|жестк)[а-я ]{0,15}политик/i, sign: -1, weight: 0.9, note: 'жёсткая ДКР' },
  { id: 'rate-cut', re: /(снизил|снижение|смягчил[аио]?|понизил[аио]?)\w*\s+(ключевую\s+)?ставк/i, re2: /(мягк|мягче)[а-я ]{0,15}политик|стимулир/i, sign: 1, weight: 0.9, note: 'смягчение ДКР' },
  { id: 'sanctions', re: /(санкц[а-я]{0,8}|ограничен[а-я]{0,8}\s+(на\s+)?вывоз|эмбарго)/i, re2: null, sign: 1, weight: 0.7, note: 'ограничения как фактор спроса на золото' },
  { id: 'risk-off', re: /(эскалаци[а-я]*|обстрел[а-я]*|конфликт[а-я]*|военн[а-я]{0,10}(действ|операц))/i, re2: null, sign: 1, weight: 0.6, note: 'геополитический риск' },
];

const stripCdata = (value) => String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const decodeEntities = (value) => stripCdata(value)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const pickTag = (block, tag) => {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeEntities(match[1]) : '';
};

// Минимальный разбор RSS 2.0 без внешних зависимостей.
function parseRss(xml) {
  const items = [];
  const blocks = String(xml || '').match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const title = pickTag(block, 'title');
    const link = pickTag(block, 'link');
    if (!title || !link) continue;
    items.push({
      title,
      url: link,
      publishedAt: pickTag(block, 'pubDate') || null,
      category: pickTag(block, 'category') || null,
      summary: pickTag(block, 'description').slice(0, 280) || null,
    });
  }
  return items;
}

async function fetchText(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AuDesk/1.0; local research tool)' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWebz(query, token) {
  const url = new URL('https://api.webz.io/search');
  url.searchParams.set('q', query);
  url.searchParams.set('language', 'ru');
  url.searchParams.set('country', 'RU');
  url.searchParams.set('sentiment', 'true');
  url.searchParams.set('size', '15');
  const response = await fetch(url, {
    headers: { 'X-Token': token, accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Webz.io вернул HTTP ${response.status}`);
  const data = await response.json();
  return (data.results || data.hits?.hits || []).map((item) => {
    const hit = item._source || item;
    return {
      title: hit.title || 'Без заголовка',
      url: hit.url || hit.link || '#',
      publishedAt: hit.published || hit.published_at || null,
      summary: (hit.summary || hit.description || '').slice(0, 280) || null,
      providerSentiment: typeof hit.sentiment === 'number' ? hit.sentiment : null,
    };
  });
}

// Оценка тона: сначала отсекаем нерелевантные заголовки, затем считаем перевес.
function scoreHeadline(text) {
  const hits = TOPIC_TERMS.filter((term) => term.re.test(text));
  if (!hits.length) return null;
  let topicWeight = 0;
  const topics = [];
  for (const hit of hits) {
    topicWeight += hit.weight;
    if (!topics.includes(hit.label)) topics.push(hit.label);
  }
  let direction = 0;
  const notes = [];
  for (const rule of DIRECTION_RULES) {
    const hit = rule.re.test(text) || (rule.re2 && rule.re2.test(text));
    if (!hit) continue;
    direction += rule.sign * rule.weight;
    notes.push(rule.note);
  }
  // Одна релевантная тема без явного правила направления — это фон, а не сигнал.
  if (!notes.length && topicWeight < 1.2) return null;
  const strength = Math.min(1, Math.abs(direction) / 1.6);
  return {
    topics,
    topicWeight,
    direction,
    tone: direction > 0.15 ? 'positive' : direction < -0.15 ? 'negative' : 'neutral',
    strength: Number(strength.toFixed(3)),
    why: notes,
  };
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// Итог по ленте. Возвращает и сам блок для интерфейса, и числовые поправки.
function buildNewsImpact(items) {
  const scored = [];
  for (const item of items) {
    const verdict = scoreHeadline(`${item.title} ${item.summary || ''}`);
    if (!verdict) continue;
    scored.push({ ...item, ...verdict });
  }
  const sources = new Set(scored.map((item) => item.source).filter(Boolean));
  const toned = scored.filter((item) => item.strength > 0);
  const scoredSources = new Set(toned.map((item) => item.source));
  // Перевес считаем по источникам, а не по заголовкам: иначе один агрегатор
  // с двадцатью похожими заметками перевесит три независимых издания.
  const perSource = new Map();
  for (const item of toned) {
    const key = item.source;
    const entry = perSource.get(key) || { sum: 0, weight: 0 };
    entry.sum += item.direction * item.strength * (item.sourceWeight || 1);
    entry.weight += item.strength * (item.sourceWeight || 1);
    perSource.set(key, entry);
  }
  const sourceVotes = [...perSource.values()].map((entry) => clamp(entry.sum / Math.max(entry.weight, 0.001), -1, 1));
  const bias = sourceVotes.length ? clamp(sourceVotes.reduce((sum, vote) => sum + vote, 0) / sourceVotes.length, -1, 1) : 0;

  // Уверенно влиять на модель можно только при нескольких релевантных заголовках
  // из нескольких независимых источников — иначе это шум, а не фон.
  const enough = toned.length >= 3 && scoredSources.size >= 2;
  const reach = enough ? clamp((scoredSources.size - 1) / 3, 0, 1) * clamp(toned.length / 8, 0.3, 1) : 0;
  const impact = Number((Math.abs(bias) * reach).toFixed(3));

  return {
    enabled: Boolean(scored.length),
    headlines: toned.length,
    sources: [...sources],
    scoredSources: scoredSources.size,
    bias: Number(bias.toFixed(3)),
    impact,
    sourceVotes: sourceVotes.map((vote) => Number(vote.toFixed(2))),
    tone: bias > 0.12 ? 'positive' : bias < -0.12 ? 'negative' : 'neutral',
    enough,
    top: scored
      .slice()
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 6)
      .map((item) => ({ title: item.title, source: item.source, url: item.url, tone: item.tone, topics: item.topics, publishedAt: item.publishedAt })),
    note: enough
      ? `Новостной фон: ${toned.length} заголовков с выраженным тоном из ${scoredSources.size} источников, перевес ${bias > 0 ? 'в пользу роста' : bias < 0 ? 'в пользу снижения' : 'нейтральный'}.`
      : toned.length
        ? `Новостной фон есть, но он разрозненный (${toned.length} заголовков) — на сценарий не влияет.`
        : 'Релевантных российских заголовков с выраженным тоном нет — сценарий построен только по цене.',
  };
}

async function collectNews({ token, limit = 40 } = {}) {
  const collected = [];
  const feedStatus = [];

  const jobs = DEFAULT_FEEDS.filter((feed) => feed.url).map(async (feed) => {
    try {
      const xml = await fetchText(feed.url);
      const items = parseRss(xml).map((item) => ({ ...item, source: feed.name, sourceId: feed.id, sourceWeight: feed.weight, lang: feed.lang }));
      collected.push(...items);
      feedStatus.push({ id: feed.id, name: feed.name, ok: true, items: items.length });
    } catch (error) {
      feedStatus.push({ id: feed.id, name: feed.name, ok: false, error: error.message });
    }
  });

  if (token) {
    jobs.push((async () => {
      try {
        const items = await fetchWebz('золото OR рубль OR MOEX OR "Банк России" OR инфляция', token);
        collected.push(...items.map((item) => ({ ...item, source: 'Webz.io', sourceId: 'webz', sourceWeight: 1.2, lang: 'ru' })));
        feedStatus.push({ id: 'webz', name: 'Webz.io', ok: true, items: items.length });
      } catch (error) {
        feedStatus.push({ id: 'webz', name: 'Webz.io', ok: false, error: error.message });
      }
    })());
  }

  await Promise.all(jobs);

  // Дедупликация и сортировка: релевантные заголовки идут первыми, иначе свежие
  // общие новости о политике вытесняют всё, что касается золота и рубля.
  const seen = new Set();
  const unique = collected.filter((item) => {
    const key = item.url || item.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const now = Date.now();
  const recency = (item) => {
    const time = new Date(item.publishedAt || 0).getTime();
    return Number.isFinite(time) ? Math.max(0, 1 - (now - time) / (36 * 3600_000)) : 0.1;
  };
  const withScore = unique.map((item) => {
    const verdict = scoreHeadline(`${item.title} ${item.summary || ''}`);
    return { item, relevant: Boolean(verdict), rank: (verdict ? verdict.strength * verdict.topicWeight : 0) * 0.5 + recency(item) };
  });
  const ordered = withScore
    .sort((a, b) => (b.relevant - a.relevant) || (b.rank - a.rank) || (new Date(b.item.publishedAt || 0) - new Date(a.item.publishedAt || 0)))
    .slice(0, limit)
    .map((entry) => entry.item);

  const impact = buildNewsImpact(ordered);
  return { items: ordered, impact, feeds: feedStatus, fetchedAt: new Date().toISOString(), webzEnabled: Boolean(token) };
}

module.exports = { collectNews, buildNewsImpact, parseRss, scoreHeadline, DEFAULT_FEEDS };
