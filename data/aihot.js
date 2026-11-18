(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.__AIHOT__ = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // AIHOT（https://aihot.news）返回的是整理好的中文 Markdown，这里解析成结构化条目。
  const ITEM_START = /^\s*(?:第\s*(\d+)\s*名\s*[:：]|(\d+)\.)\s*\[(.+?)\]\((https?:\/\/[^\s)]+)\)\s*$/;
  const LATEST_META = /^\s*(.+?)\s*·\s*发布于\s*(\d{1,2}-\d{1,2}\s+\d{2}:\d{2})\s*·\s*(.+?)\s*$/;
  const HOT_META = /^\s*信源[:：]\s*(.+?)\s*·\s*最新进展\s*(\d{1,2}-\d{1,2}\s+\d{2}:\d{2})\s*$/;
  const STORY_LINE = /^\s*来龙去脉[:：]\s*(https?:\/\/\S+)\s*$/;

  function clean(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function splitSources(raw) {
    return String(raw || "")
      .replace(/\s*(?:等\s*)?[（(]\s*\d+\s*个\s*[)）]\s*$/, "")
      .split(/[、,，；;]/)
      .map((item) => clean(item))
      .filter(Boolean);
  }

  function parseHot(markdown) {
    const lines = String(markdown || "").split(/\r?\n/);
    const items = [];
    let current = null;
    lines.forEach((line) => {
      const start = line.match(ITEM_START);
      if (start) {
        current = {
          rank: Number(start[1] || start[2]) || items.length + 1,
          title: clean(start[3]),
          url: start[4],
          sources: [],
          sourceCount: 0,
          latestAt: "",
          storyUrl: "",
        };
        items.push(current);
        return;
      }
      if (!current) return;
      const meta = line.match(HOT_META);
      if (meta) {
        current.sources = splitSources(meta[1]);
        const countMatch = meta[1].match(/[（(]\s*(\d+)\s*个\s*[)）]/);
        current.sourceCount = countMatch ? Number(countMatch[1]) : current.sources.length;
        current.latestAt = meta[2];
        return;
      }
      const story = line.match(STORY_LINE);
      if (story) current.storyUrl = story[1];
    });
    return items;
  }

  function parseLatest(markdown) {
    const lines = String(markdown || "").split(/\r?\n/);
    const items = [];
    let current = null;
    lines.forEach((line) => {
      const start = line.match(ITEM_START);
      if (start) {
        current = {
          rank: Number(start[1] || start[2]) || items.length + 1,
          title: clean(start[3]),
          url: start[4],
          source: "",
          publishedAt: "",
          category: "",
          summary: "",
          reason: "",
          originalUrl: "",
        };
        items.push(current);
        return;
      }
      if (!current) return;
      const meta = line.match(LATEST_META);
      if (meta) {
        current.source = clean(meta[1]);
        current.publishedAt = meta[2];
        current.category = clean(meta[3]);
        return;
      }
      const summary = line.match(/^\s*摘要[:：]\s*(.+)$/);
      if (summary) { current.summary = clean(summary[1]); return; }
      const reason = line.match(/^\s*推荐理由[:：]\s*(.+)$/);
      if (reason) { current.reason = clean(reason[1]); return; }
      const original = line.match(/^\s*原文[:：]\s*(https?:\/\/\S+)\s*$/);
      if (original) current.originalUrl = original[1];
    });
    return items;
  }

  function parse(bundle) {
    const hot = parseHot(bundle && bundle.hot);
    const latest = parseLatest(bundle && bundle.latest);
    return { hot, latest };
  }

  return { parse, parseHot, parseLatest };
});
