// content/generic-interceptor.js
//
// 通用版 JSON.parse 拦截器，按「站点配置驱动」提取原图 URL 与缩略图→原图映射。
// 与老版 content/doubao-interceptor.js 并行运行（双轨），二者互不依赖、互不破坏。
//
// 每次 JSON.parse 被调用时：
//   1. 遍历所有配置；若响应串包含该站点的 matchKey，则按 JSON 路径提取数据
//   2. 结果写入 window.__gi_buckets[siteId] = { urls:[], map: Map(thumb→original) }
//
// Phase 1 中本脚本默认处于「观察模式」（hookInPlaceReplace=false），不改页面上的预览 URL，
// 留给老版脚本去做，避免重复改写冲突。
//
// MAIN world, document_start

(function () {
  'use strict';

  if (window.__gi_hookInstalled) return;
  window.__gi_hookInstalled = true;

  // 站点桶：每个站点独立存 urls（有序去重）和 map（缩略图 → 原图）
  window.__gi_buckets = window.__gi_buckets || {};

  // 允许外部在运行时动态注入/覆盖站点配置
  //   window.__gi_config = { sites: { 'my-site-id': { matchKey, originalPath, thumbUrlPaths, ... } } }
  window.__gi_config = window.__gi_config || { sites: {} };

  // 内置预设（与 content/doubao-interceptor.js 语义等价，但不做 in-place 替换）
  const PRESETS = {
    doubao: {
      matchKey: 'creations',
      originalPath: 'creations[*].image.image_ori_raw.url',
      thumbUrlPaths: [
        'creations[*].image.image_ori.url',
        'creations[*].image.image_preview.url',
        'creations[*].image.image_thumb.url'
      ],
      hookInPlaceReplace: false
    }
  };

  function getAllConfigs() {
    const userSites = (window.__gi_config && window.__gi_config.sites) || {};
    // 用户配置可以覆盖内置预设（同 siteId 时）
    return { ...PRESETS, ...userSites };
  }

  function getBucket(siteId) {
    let b = window.__gi_buckets[siteId];
    if (!b) {
      b = { urls: [], map: new Map() };
      window.__gi_buckets[siteId] = b;
    }
    return b;
  }

  // ─── 极简 JSON-Path 解析：支持 a.b.c[*].d 语法 ─────────────────────────
  function parsePath(path) {
    return String(path).replace(/\[\*\]/g, '.*').split('.').filter(Boolean);
  }

  // 返回形如 [{ parent, key, value }, ...] 的命中节点列表
  function walkPath(root, pathParts) {
    if (!root || typeof root !== 'object') return [];
    let cursors = [{ parent: null, key: null, value: root }];
    for (const part of pathParts) {
      const next = [];
      for (const cur of cursors) {
        const v = cur.value;
        if (!v || typeof v !== 'object') continue;
        if (part === '*') {
          if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) {
              next.push({ parent: v, key: i, value: v[i] });
            }
          }
        } else {
          if (part in v) {
            next.push({ parent: v, key: part, value: v[part] });
          }
        }
      }
      cursors = next;
      if (cursors.length === 0) break;
    }
    return cursors;
  }

  function extractStringValues(root, path) {
    return walkPath(root, parsePath(path))
      .map(n => n.value)
      .filter(v => typeof v === 'string' && v.length > 0);
  }

  // 按 JSON 路径命中的顺序，对每个叶子位置做替换；replaceFn(oldVal, index) => newVal
  function replaceByPath(root, path, replaceFn) {
    const parts = parsePath(path);
    if (parts.length === 0) return;
    const parents = walkPath(root, parts.slice(0, -1));
    const lastKey = parts[parts.length - 1];
    parents.forEach((node, idx) => {
      const obj = node.value;
      if (obj && typeof obj === 'object' && lastKey in obj) {
        const newVal = replaceFn(obj[lastKey], idx);
        if (newVal !== undefined && newVal !== null) obj[lastKey] = newVal;
      }
    });
  }

  function processConfig(parsed, siteId, cfg) {
    if (!cfg || !cfg.originalPath) return;

    const bucket = getBucket(siteId);

    // 1. 提取原图 URL（顺序有意义，用于和 thumb 按 index 配对）
    const originals = extractStringValues(parsed, cfg.originalPath);
    if (originals.length === 0) return;

    originals.forEach(url => {
      if (!bucket.urls.includes(url)) bucket.urls.push(url);
      bucket.map.set(url, url); // 原图指向自己
    });

    // 2. 建立 thumb → original 映射（按 index 对齐同一个 creation item）
    (cfg.thumbUrlPaths || []).forEach(thumbPath => {
      const thumbs = extractStringValues(parsed, thumbPath);
      thumbs.forEach((thumb, i) => {
        const pair = originals[i];
        if (pair && typeof thumb === 'string') bucket.map.set(thumb, pair);
      });
    });

    // 3. 可选：把响应里的预览/缩略 URL 原地替换为原图，让页面直接展示无水印版
    if (cfg.hookInPlaceReplace) {
      const paths = cfg.replacePaths || cfg.thumbUrlPaths || [];
      paths.forEach(p => {
        replaceByPath(parsed, p, (_old, i) => originals[i]);
      });
    }
  }

  // ─── Hook JSON.parse ─────────────────────────────────────────────
  // 与 doubao-interceptor.js 形成链式：
  //   manifest 中 doubao-interceptor.js 先加载 → 它保存的是真实 JSON.parse
  //   generic-interceptor.js 后加载 → 它保存的是已被 doubao 包装过的 JSON.parse
  //   实际调用顺序：generic(外层) → doubao(内层) → 真实 parse → doubao 处理 → generic 处理
  // 两套逻辑互不干扰，都能拿到同一个 parsed 对象（同一引用）。
  const _origParse = JSON.parse;

  JSON.parse = function (data, reviver) {
    const result = _origParse.call(this, data, reviver);

    try {
      if (typeof data === 'string' && data.length > 0) {
        const configs = getAllConfigs();
        for (const siteId in configs) {
          const cfg = configs[siteId];
          if (cfg && cfg.matchKey && data.indexOf(cfg.matchKey) !== -1) {
            processConfig(result, siteId, cfg);
          }
        }
      }
    } catch (_) { /* 永远不打断页面 */ }

    return result;
  };

  // 小工具：清空某个站点桶（供 background 重置用）
  window.__gi_reset = function (siteId) {
    if (siteId) {
      const b = window.__gi_buckets[siteId];
      if (b) { b.urls.length = 0; b.map.clear(); }
    } else {
      for (const k in window.__gi_buckets) {
        window.__gi_buckets[k].urls.length = 0;
        window.__gi_buckets[k].map.clear();
      }
    }
  };
})();
