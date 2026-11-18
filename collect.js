"use strict";

const fs = require("node:fs");
const path = require("node:path");
const scoring = require("./data/scoring.js");
const aihot = require("./data/aihot.js");

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, "config.json");
const LEGACY_PATH = path.join(ROOT, "data", "legacy-hot-trends.js");
const OUTPUT_PATH = path.join(ROOT, "data", "hot-trends.json");
const TIMEOUT_MS = 12000;
const AIHOT_UA = "Mozilla/5.0 (compatible; WaveKolHotRadar/3.1; +https://aihot.news)";
const AIHOT_ENDPOINTS = {
  latest: "https://aihot.news/api/v1/agent/latest?limit=30",
  hot: "https://aihot.news/api/v1/agent/hot",
};
const HISTORY_DAYS = 30;

function loadLegacy() {
  if (!fs.existsSync(LEGACY_PATH)) return null;
  const code = fs.readFileSync(LEGACY_PATH, "utf8")
    .replace(/^window\.__HOT_TRENDS__\s*=\s*/, "")
    .replace(/;\s*$/, "");
  const sandbox = { __HOT_TRENDS__: null };
  new Function("window", `return (${code})`)(sandbox);
  return sandbox.__HOT_TRENDS__;
}

function loadPrevious() {
  if (fs.existsSync(OUTPUT_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
    } catch (error) {
      console.warn(`[warn] 无法读取已有数据，回退历史快照：${error.message}`);
    }
  }
  return loadLegacy();
}

function beijingStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json,text/plain,*/*",
        "user-agent": "Mozilla/5.0 (compatible; WaveKolHotRadar/2.0)",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trim().startsWith("{")) throw new Error("返回内容不是 JSON");
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, userAgent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/plain,*/*",
        "user-agent": userAgent || "Mozilla/5.0 (compatible; WaveKolHotRadar/3.1)",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

// AIHOT：160+ 信源的 AI 精选/热点，作为热榜之外的「高价值信源」层
async function fetchAiHot(todayTopics, entities) {
  const [latestText, hotText] = await Promise.all([
    fetchText(AIHOT_ENDPOINTS.latest, AIHOT_UA),
    fetchText(AIHOT_ENDPOINTS.hot, AIHOT_UA),
  ]);
  const parsed = aihot.parse({ latest: latestText, hot: hotText });
  const norm = scoring.normalizeTitle;
  const enrich = (item) => {
    const key = norm(item.title);
    const topic = (todayTopics || [])
      .filter((candidate) => scoring.sameTopic(key, norm(candidate.title)))
      .sort((a, b) => b.platformCount - a.platformCount || b.todayScore - a.todayScore)[0] || null;
    item.hotTopic = topic
      ? { title: topic.title, platforms: topic.platforms, bestRank: topic.bestRank, score: topic.todayScore, url: topic.bestUrl }
      : null;
    item.entities = (entities || [])
      .filter((entity) => scoring.keywordMatcher([entity.name, ...(entity.aliases || [])])(`${item.title} ${item.summary || ""}`))
      .slice(0, 4)
      .map((entity) => ({ id: entity.id, name: entity.name, itemCount: entity.itemCount, platformCount: entity.platformCount }));
    return item;
  };
  return {
    fetchedAt: new Date().toISOString(),
    fetchedAtBeijing: beijingStamp(),
    source: "AIHOT（https://aihot.news）",
    license: "仅内部参考；对外商业使用需取得 AIHOT 授权",
    hot: parsed.hot.map(enrich),
    latest: parsed.latest.map(enrich),
  };
}

async function fetchPlatform(platform, apiSources) {
  for (const source of apiSources) {
    for (const alias of platform.aliases || [platform.id]) {
      const url = `${source.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(alias)}`;
      try {
        const payload = await fetchJson(url);
        if (Number(payload.code) === 200 && Array.isArray(payload.data)) {
          return {
            ok: true,
            platform,
            source,
            alias,
            payload,
            items: scoring.normalizeItems(platform, payload),
          };
        }
      } catch (error) {
        // 尝试下一个镜像
      }
    }
  }
  return { ok: false, platform, items: [] };
}

function trimDays(days, today) {
  const cutoff = scoring.dateOffset(today, -(HISTORY_DAYS - 1));
  return Object.keys(days)
    .filter((date) => date >= cutoff && date <= today)
    .sort()
    .reduce((acc, date) => {
      acc[date] = days[date];
      return acc;
    }, {});
}

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const previous = loadPrevious() || {};
  const today = scoring.beijingDate();
  const results = await Promise.all(
    (config.platformConfig || []).map((platform) => fetchPlatform(platform, config.apiSources || []))
  );
  const ok = results.filter((result) => result.ok);
  if (!ok.length) throw new Error("全部热榜数据源采集失败，保留上一版数据");

  const days = { ...(previous.days || {}) };
  days[today] = {
    date: today,
    fetchedAt: new Date().toISOString(),
    fetchedAtBeijing: beijingStamp(),
    items: scoring.withScores(ok.flatMap((result) => result.items)),
  };
  const trimmed = trimDays(days, today);
  const report = scoring.buildReport(trimmed, today, config.platformConfig, {
    watchlist: config.watchlist || [],
    verticals: config.verticals || [],
  });

  const data = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    generatedAtBeijing: beijingStamp(),
    timezone: "Asia/Shanghai",
    sourceType: "DailyHotApi public mirrors",
    note: config.note || "公开热榜采样，不代表微信指数或全网真实提及量。",
    refreshPolicy: "每日 09:20（北京时间）自动采集并持久化；页面上的实时快照为临时预览。",
    apiSources: config.apiSources,
    platformConfig: config.platformConfig,
    status: {
      total: results.length,
      success: ok.length,
      failed: results.length - ok.length,
      platforms: results.map((result) => ({
        id: result.platform.id,
        name: result.platform.name,
        ok: result.ok,
        itemCount: result.items.length,
        source: result.source?.label || "",
        alias: result.alias || "",
        error: result.ok ? "" : "全部镜像尝试失败",
      })),
    },
    days: trimmed,
    report,
    watchlist: config.watchlist || [],
    verticals: config.verticals || [],
  };

  const allTodayTopics = scoring.buildTopics(scoring.withDate(days[today].items, today), today, "today");
  try {
    data.aihot = await fetchAiHot(allTodayTopics, report.entities);
    console.log(`[ok] AIHOT：${data.aihot.hot.length} 个热点、${data.aihot.latest.length} 条精选`);
  } catch (error) {
    console.warn(`[warn] AIHOT 抓取失败，保留热榜数据：${error.message}`);
    data.aihot = { error: error.message, fetchedAt: new Date().toISOString() };
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data));
  const entityCount = data.report.entities.filter((entity) => entity.itemCount > 0).length;
  console.log(`[ok] ${today} 采集完成：${ok.length}/${results.length} 个平台，${days[today].items.length} 条榜单，${entityCount} 个关注实体有动静`);
  console.log(`[ok] 输出 ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(`[error] ${error.message}`);
  process.exit(1);
});
