// content/doubao-interceptor.js
// 运行在 MAIN world，与豆包页面共享 JS 上下文
// 通过 hook JSON.parse 拦截 API 响应，提取无水印原图 URL (image_ori_raw)

(function () {
  'use strict';

  if (window.__dd_hookInstalled) return;
  window.__dd_hookInstalled = true;

  // 存储拦截到的原图URL（有序，按 API 返回顺序）
  window.__dd_originalUrls = [];
  // 缩略图/预览图 → 原图 的映射
  window.__dd_urlMap = new Map();

  const _originalParse = JSON.parse;

  function findAllCreations(obj) {
    const results = [];
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (!Array.isArray(node) && Array.isArray(node.creations)) {
        results.push(node.creations);
      }
      const children = Array.isArray(node) ? node : Object.values(node);
      for (const child of children) walk(child);
    }
    walk(obj);
    return results;
  }

  JSON.parse = function (data, reviver) {
    const result = _originalParse.call(this, data, reviver);

    try {
      if (typeof data === 'string' && data.includes('creations')) {
        const allCreations = findAllCreations(result);

        allCreations.forEach(creations => {
          if (!Array.isArray(creations)) return;

          creations.forEach(item => {
            const rawUrl = item?.image?.image_ori_raw?.url;
            if (!rawUrl) return;

            if (!window.__dd_originalUrls.includes(rawUrl)) {
              window.__dd_originalUrls.push(rawUrl);
            }

            const variants = [
              item?.image?.image_ori?.url,
              item?.image?.image_preview?.url,
              item?.image?.image_thumb?.url,
            ].filter(Boolean);

            variants.forEach(v => window.__dd_urlMap.set(v, rawUrl));
            window.__dd_urlMap.set(rawUrl, rawUrl);

            // 将页面内存中的缩略图/预览图替换为原图，使页面直接展示无水印版
            if (item.image.image_ori) item.image.image_ori.url = rawUrl;
            if (item.image.image_preview) item.image.image_preview.url = rawUrl;
            if (item.image.image_thumb) item.image.image_thumb.url = rawUrl;
          });
        });
      }
    } catch (_) { /* 不影响页面正常功能 */ }

    return result;
  };
})();
