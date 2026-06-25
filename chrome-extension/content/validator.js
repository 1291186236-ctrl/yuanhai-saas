// content/validator.js
// 元素校验与上传三重验证辅助器

'use strict';

(function () {
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function countBySelectors(selectors, root = document) {
    let max = 0;
    (selectors || []).filter(Boolean).forEach(sel => {
      try {
        const n = root.querySelectorAll(sel).length;
        if (n > max) max = n;
      } catch {}
    });
    return max;
  }

  function validateSelector(selector) {
    if (!selector || !String(selector).trim()) {
      return { ok: false, found: 0, message: '选择器为空' };
    }
    try {
      const list = document.querySelectorAll(selector);
      const first = list[0] || null;
      return {
        ok: list.length > 0,
        found: list.length,
        tag: first?.tagName?.toLowerCase() || '',
        text: (first?.innerText || first?.textContent || '').trim().slice(0, 80)
      };
    } catch (err) {
      return { ok: false, found: 0, message: err.message };
    }
  }

  function getUploadValidationStatus(options) {
    const cfg = options || {};
    const previewCount = countBySelectors([
      cfg.uploadPreviewSelector,
      cfg.uploadCompleteSelector,
      '[class*="upload"][class*="preview"] img',
      '[class*="uploaded"] img',
      '[class*="attachment"] img'
    ]);

    const progressCount = countBySelectors([
      cfg.uploadProgressSelector,
      '[role="progressbar"]',
      '[class*="progress"]',
      '[class*="loading"]'
    ]);

    let naturalOkCount = 0;
    let totalImageCount = 0;
    const imageSel = cfg.uploadPreviewSelector || cfg.uploadCompleteSelector || 'img';
    try {
      const imgs = Array.from(document.querySelectorAll(imageSel));
      totalImageCount = imgs.length;
      naturalOkCount = imgs.filter(img => img.naturalWidth > 0).length;
    } catch {}

    return {
      previewCount,
      progressCount,
      naturalOkCount,
      totalImageCount,
      allNaturalOk: totalImageCount > 0 && naturalOkCount === totalImageCount,
      loading: progressCount > 0
    };
  }

  function highlightSelector(selector, ms = 1800) {
    try {
      const targets = document.querySelectorAll(selector);
      targets.forEach(el => {
        el.dataset.__autoPrevOutline = el.style.outline || '';
        el.style.outline = '2px solid #22c55e';
      });
      setTimeout(() => {
        targets.forEach(el => {
          el.style.outline = el.dataset.__autoPrevOutline || '';
          delete el.dataset.__autoPrevOutline;
        });
      }, ms);
      return { ok: targets.length > 0, found: targets.length };
    } catch (err) {
      return { ok: false, found: 0, message: err.message };
    }
  }

  window.AutoValidator = {
    isVisible,
    validateSelector,
    getUploadValidationStatus,
    highlightSelector
  };
  window.__ValidatorReady = true;
})();
