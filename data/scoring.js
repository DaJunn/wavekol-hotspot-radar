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
      // 只去标题尾部/头部的榜单标记，历史上按单字全局删除会把「新加坡」削成「加坡」
      .replace(/^(?:【|\[)?(?:微博|热搜|置顶|话题|爆|沸|新|热|荐|精)+/g, "")
      .replace(/(?:微博|热搜|置顶|话题|爆|沸|新|热|荐|精)+$/g, "")
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

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // 中文关键词直接包含匹配；纯英文/数字关键词补词边界，避免 AI 命中 AIR、GPT 命中 GPTX
  function keywordMatcher(keywords) {
    const list = [...new Set((keywords || []).filter(Boolean).map(String))];
    if (!list.length) return () => false;
    const latin = [];
    const plain = [];
    list.forEach((keyword) => {
      if (/^[\x00-\x7F]+$/.test(keyword)) latin.push(escapeRegExp(keyword));
      else plain.push(escapeRegExp(keyword));
    });
    const latinRe = latin.length ? new RegExp(`(^|[^A-Za-z0-9])(${latin.join("|")})(?![A-Za-z0-9])`, "i") : null;
    const plainRe = plain.length ? new RegExp(plain.join("|"), "i") : null;
    return (text) => (latinRe ? latinRe.test(text) : false) || (plainRe ? plainRe.test(text) : false);
  }

  function entityLevel(score, platformCount) {
    if (platformCount >= 6 || score >= 520) return "S";
    if (platformCount >= 4 || score >= 320) return "A";
    if (platformCount >= 2 || score >= 160) return "B";
    return "C";
  }

  // 实体雷达：把「同一家公司/同一个人」被打散在十几个标题里的条目归并成一条关注线
  function buildEntities(items, todayDate, watchlist) {
    return (watchlist || [])
      .filter((entity) => entity && entity.name)
      .map((entity) => {
        const matcher = keywordMatcher([entity.name, ...(entity.aliases || [])]);
        const hits = items
          .filter((item) => matcher(item.title))
          .sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.rank - b.rank);
        if (!hits.length) return null;
        const todayHits = hits.filter((item) => item.date === todayDate);
        const platforms = new Map();
        hits.forEach((item) => platforms.set(item.platform, item.platformName));
        const dates = [...new Set(hits.map((item) => item.date))].sort();
        const dailyCounts = {};
        const dailyScores = {};
        hits.forEach((item) => {
          dailyCounts[item.date] = (dailyCounts[item.date] || 0) + 1;
          dailyScores[item.date] = round((dailyScores[item.date] || 0) + Math.min(item.score || 0, 100));
        });
        const todayRaw = todayHits.reduce((sum, item) => sum + Math.min(item.score || 0, 100), 0);
        const platformCount = platforms.size;
        const score = round(Math.min(todayRaw, 600) + Math.min(platformCount, 6) * 25);
        const stories = buildTopics(todayHits, todayDate, "today")
          .sort((a, b) => b.todayScore - a.todayScore)
          .slice(0, 3)
          .map((topic) => ({
            title: topic.title,
            itemCount: topic.items.length,
            platforms: topic.platforms,
            url: topic.bestUrl,
            score: topic.todayScore,
          }));
        return {
          id: entity.id || entity.name,
          name: entity.name,
          group: entity.group || "关注",
          aliases: entity.aliases || [],
          level: entityLevel(score, platformCount),
          score,
          itemCount: todayHits.length,
          totalItemCount: hits.length,
          platformCount,
          platformIds: [...platforms.keys()],
          platforms: [...platforms.values()],
          bestRank: todayHits.length ? Math.min(...todayHits.map((item) => item.rank)) : null,
          daysCount: dates.length,
          dates,
          dailyCounts,
          dailyScores,
          stories,
          items: todayHits.slice(0, 8),
          latest: hits.slice(0, 4),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || b.platformCount - a.platformCount || b.itemCount - a.itemCount);
  }

  // 垂直赛道：AI/科技、出海/商业等，按关键词把热榜条目标出来单独成栏
  function buildVerticals(items, todayDate, verticals) {
    return (verticals || [])
      .map((vertical) => {
        const matcher = keywordMatcher(vertical.keywords || []);
        const hits = items.filter((item) => matcher(item.title));
        if (!hits.length) return null;
        const todayHits = hits.filter((item) => item.date === todayDate);
        const topics = buildTopics(todayHits, todayDate, "today")
          .sort((a, b) => b.todayScore - a.todayScore)
          .slice(0, 8);
        return {
          id: vertical.id,
          name: vertical.name,
          description: vertical.description || "",
          itemCount: todayHits.length,
          platformCount: new Set(todayHits.map((item) => item.platform)).size,
          topics,
        };
      })
      .filter(Boolean);
  }

  function buildReport(days, todayDate, platformConfig, options) {
    const opts = options || {};
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
      entities: buildEntities(twoWeekItems, todayDate, opts.watchlist),
      verticals: buildVerticals(twoWeekItems, todayDate, opts.verticals),
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
    keywordMatcher,
    buildTopics,
    buildEntities,
    buildVerticals,
    buildReport,
  };
});
