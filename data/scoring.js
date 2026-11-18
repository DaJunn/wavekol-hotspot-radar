(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.__HOT_SCORING__ = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DECAY = 0.85;
  const SCORE_CAP = 400;
  const PLATFORM_BONUS_CAP = 5;
  const PLATFORM_BONUS = 20;

  function round(num) {
    return Number(Number(num || 0).toFixed(1));
  }

  function beijingDate(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date).reduce((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function dateOffset(dateText, deltaDays) {
    const date = new Date(`${dateText}T00:00:00+08:00`);
    date.setUTCDate(date.getUTCDate() + deltaDays);
    return beijingDate(date);
  }

  function ageInDays(today, dateText) {
    return Math.max(0, Math.round((new Date(`${today}T00:00:00+08:00`) - new Date(`${dateText}T00:00:00+08:00`)) / 86400000));
  }

  function parseHeat(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const raw = String(value ?? "").replace(/,/g, "").trim();
    const match = raw.match(/([\d.]+)\s*([万亿kKmM]?)/);
    if (!match) return null;
    const num = Number(match[1]);
    if (!Number.isFinite(num)) return null;
    const unit = match[2].toLowerCase();
    if (unit === "亿") return num * 100000000;
    if (unit === "万") return num * 10000;
    if (unit === "m") return num * 1000000;
    if (unit === "k") return num * 1000;
    return num;
  }

  function normalizeTitle(title) {
    return String(title || "")
      .normalize("NFKC")
      .replace(/#[^#]{1,80}#/g, (match) => match.slice(1, -1))
      .replace(/[【】「」『』（）()［\][\]{}<>《》“”"']/g, "")
      .replace(/微博|热搜|置顶|爆|新|荐|沸|热|精|话题/g, "")
      .replace(/[^\p{Script=Han}\p{Letter}\p{Number}]+/gu, "")
      .toLowerCase()
      .trim();
  }

  function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
  }

  function normalizeItems(platform, payload) {
    return (payload.data || []).map((item, index) => {
      const title = String(firstDefined(item.title, item.name, item.desc, item.word) || "").trim();
      if (!title) return null;
      const rank = Number(firstDefined(item.index, item.rank, item.order, index + 1)) || index + 1;
      const heatRaw = firstDefined(item.hot, item.heat, item.value, item.desc, item.views, item.score);
      return {
        id: `${platform.id}-${index + 1}-${normalizeTitle(title)}`,
        platform: platform.id,
        platformName: platform.name,
        title,
        normalizedTitle: normalizeTitle(title),
        rank,
        hot: heatRaw == null ? "" : String(heatRaw),
        hotNumber: parseHeat(heatRaw),
        url: firstDefined(item.url, item.link, payload.link, ""),
        mobileUrl: firstDefined(item.mobileUrl, item.url, item.link, payload.link, ""),
      };
    }).filter(Boolean);
  }

  function withScores(items) {
    const byPlatform = new Map();
    items.forEach((item) => {
      if (!byPlatform.has(item.platform)) byPlatform.set(item.platform, []);
      byPlatform.get(item.platform).push(item);
    });

    const scored = [];
    byPlatform.forEach((platformItems) => {
      const maxRank = Math.max(...platformItems.map((item) => item.rank), platformItems.length, 1);
      const numericHeats = platformItems
        .map((item) => item.hotNumber)
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.log10(value + 1))
        .sort((a, b) => a - b);

      platformItems.forEach((item) => {
        const rankScore = Math.max(0, ((maxRank - item.rank + 1) / maxRank) * 100);
        const logHeat = Number.isFinite(item.hotNumber) && item.hotNumber > 0 ? Math.log10(item.hotNumber + 1) : null;
        let heatScore = null;
        if (logHeat !== null && numericHeats.length) {
          const lower = numericHeats.filter((value) => value < logHeat).length;
          const equal = numericHeats.filter((value) => value === logHeat).length;
          heatScore = numericHeats.length === 1 ? 100 : round((lower + equal / 2) / (numericHeats.length - 1) * 100);
        }
        const score = heatScore === null ? round(rankScore) : round(rankScore * 0.7 + heatScore * 0.3);
        scored.push({
          ...item,
          rankScore: round(rankScore),
          heatScore,
          heatMissing: heatScore === null,
          score,
        });
      });
    });
    return scored;
  }

  function bigrams(text) {
    const chars = [...String(text || "")];
    if (chars.length <= 1) return new Set(chars);
    const out = new Set();
    for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i] + chars[i + 1]);
    return out;
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let n = 0;
    a.forEach((value) => { if (b.has(value)) n += 1; });
    return n / (a.size + b.size - n);
  }

  function sameTopic(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const min = a.length <= b.length ? a : b;
    const max = a.length > b.length ? a : b;
    if (min.length >= 4 && max.includes(min) && min.length / max.length >= 0.5) return true;
    return min.length >= 5 && jaccard(bigrams(a), bigrams(b)) >= 0.72;
  }

  function level(score, count) {
    if (count >= 5 || score >= 360) return "S";
    if (count >= 3 || score >= 220) return "A";
    if (count >= 2 || score >= 120) return "B";
    return "C";
  }

  function withDate(items, date) {
    return items.map((item) => ({ ...item, date }));
  }

  function buildTopics(items, todayDate, mode) {
    const topics = [];
    items.forEach((item) => {
      let topic = topics.find((t) => sameTopic(t.key, item.normalizedTitle));
      if (!topic) {
        topic = {
          key: item.normalizedTitle,
          title: item.title,
          platforms: new Set(),
          dates: new Set(),
          dailyScores: {},
          bestRank: 999,
          bestUrl: "",
          todayRaw: 0,
          previousRaw: 0,
          weekRaw: 0,
          items: [],
        };
        topics.push(topic);
      }
      const age = ageInDays(todayDate, item.date);
      const contribution = Math.min(item.score || 0, 100);
      const decayed = contribution * Math.pow(DECAY, age);
      topic.platforms.add(item.platform);
      topic.dates.add(item.date);
      topic.bestRank = Math.min(topic.bestRank, item.rank);
      if (!topic.bestUrl && (item.mobileUrl || item.url)) topic.bestUrl = item.mobileUrl || item.url;
      if (item.date === todayDate) topic.todayRaw += contribution;
      else topic.previousRaw += decayed;
      topic.weekRaw += mode === "today" ? contribution : decayed;
      topic.dailyScores[item.date] = round((topic.dailyScores[item.date] || 0) + contribution);
      topic.items.push(item);
      if (item.score > (topic.topItem?.score || 0)) {
        topic.topItem = item;
        topic.title = item.title;
      }
    });

    return topics.map((topic) => {
      const count = topic.platforms.size;
      const bonus = Math.min(count, PLATFORM_BONUS_CAP) * PLATFORM_BONUS;
      const todayScore = round(Math.min(topic.todayRaw, SCORE_CAP) + (topic.todayRaw > 0 ? bonus : 0));
      const weekScore = round(Math.min(topic.weekRaw, SCORE_CAP) + (topic.weekRaw > 0 ? bonus : 0));
      const finalScore = todayScore || weekScore;
      return {
        key: topic.key,
        title: topic.title,
        level: level(finalScore, count),
        platformCount: count,
        platforms: [...topic.platforms],
        bestRank: topic.bestRank === 999 ? null : topic.bestRank,
        daysCount: topic.dates.size,
        dates: [...topic.dates].sort(),
        dailyScores: topic.dailyScores,
        todayScore,
        weekScore,
        risingScore: round(todayScore - topic.previousRaw / Math.max(1, topic.dates.size - 1)),
        bestUrl: topic.bestUrl,
        topPlatform: topic.topItem?.platformName || "",
        topHot: topic.topItem?.hot || "",
        heatMissingCount: topic.items.filter((item) => item.heatMissing).length,
        items: topic.items.sort((a, b) => b.score - a.score).slice(0, 8),
      };
    });
  }

  function buildReport(days, todayDate, platformConfig) {
    const dates = Object.keys(days || {}).sort();
    const weekStart = dateOffset(todayDate, -6);
    const twoWeekStart = dateOffset(todayDate, -13);
    const todayItems = withDate(days[todayDate]?.items || [], todayDate);
    const weekItems = dates
      .filter((date) => date >= weekStart && date <= todayDate)
      .flatMap((date) => withDate(days[date]?.items || [], date));
    const twoWeekItems = dates
      .filter((date) => date >= twoWeekStart && date <= todayDate)
      .flatMap((date) => withDate(days[date]?.items || [], date));

    const todayTopics = buildTopics(todayItems, todayDate, "today")
      .sort((a, b) => b.todayScore - a.todayScore || b.platformCount - a.platformCount)
      .slice(0, 30);
    const weekTopics = buildTopics(weekItems, todayDate, "week")
      .sort((a, b) => b.weekScore - a.weekScore || b.platformCount - a.platformCount)
      .slice(0, 40);
    const risingTopics = buildTopics(weekItems, todayDate, "week")
      .filter((topic) => topic.todayScore > 0)
      .sort((a, b) => b.risingScore - a.risingScore || b.todayScore - a.todayScore)
      .slice(0, 30);
    const sustained3to7Topics = buildTopics(weekItems, todayDate, "week")
      .filter((topic) => topic.daysCount >= 3)
      .sort((a, b) => b.weekScore - a.weekScore || b.platformCount - a.platformCount)
      .slice(0, 10);
    const sustained7to14Topics = buildTopics(twoWeekItems, todayDate, "week")
      .filter((topic) => topic.daysCount >= 7)
      .sort((a, b) => b.weekScore - a.weekScore || b.platformCount - a.platformCount)
      .slice(0, 10);
    const sustainedTopics = buildTopics(twoWeekItems, todayDate, "week")
      .filter((topic) => topic.todayScore > 0 && (topic.daysCount >= 2 || topic.platformCount >= 2))
      .map((topic) => ({
        ...topic,
        sustainScore: round(topic.weekScore * (1 + 0.2 * (topic.daysCount - 1)) + (topic.platformCount - 1) * 10),
      }))
      .sort((a, b) => b.sustainScore - a.sustainScore || b.daysCount - a.daysCount || b.platformCount - a.platformCount)
      .slice(0, 10);

    const platformDistribution = (platformConfig || []).map((platform) => {
      const items = todayItems.filter((item) => item.platform === platform.id);
      const topics = buildTopics(items, todayDate, "today");
      return {
        id: platform.id,
        name: platform.name,
        itemCount: items.length,
        topicCount: topics.length,
        topTitle: topics.sort((a, b) => b.todayScore - a.todayScore)[0]?.title || "",
      };
    });

    const rawItems = todayItems
      .slice()
      .sort((a, b) => a.platformName.localeCompare(b.platformName, "zh-CN") || a.rank - b.rank);

    return {
      todayDate,
      weekStart,
      twoWeekStart,
      availableDays: dates.filter((date) => date >= twoWeekStart && date <= todayDate).length,
      heatMissingCount: todayItems.filter((item) => item.heatMissing).length,
      todayTopics,
      weekTopics,
      risingTopics,
      sustained3to7Topics,
      sustained7to14Topics,
      sustainedTopics,
      platformDistribution,
      rawItems,
    };
  }

  return {
    DECAY,
    beijingDate,
    dateOffset,
    ageInDays,
    parseHeat,
    normalizeTitle,
    normalizeItems,
    withScores,
    sameTopic,
    level,
    withDate,
    buildTopics,
    buildReport,
  };
});
