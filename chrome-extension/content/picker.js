// content/picker.js
// 可视化元素选择器
// 依赖：utils.js（需先加载）

'use strict';

(function () {

  // ═══════════════════════════════════════════
  // 状态
  // ═══════════════════════════════════════════

  let isPickingMode  = false;
  let currentPickKey = null;   // 当前选择回调标识
  let lastHighlighted = null;  // 上次高亮的元素

  // ═══════════════════════════════════════════
  // UI 元素
  // ═══════════════════════════════════════════

  // 高亮覆盖层
  const overlay = document.createElement('div');
  overlay.id = '__auto_picker_overlay__';
  overlay.style.cssText = `
    position: fixed;
    border: 2px solid #00ff88;
    background: rgba(0,255,136,0.08);
    pointer-events: none;
    z-index: 2147483647;
    display: none;
    border-radius: 3px;
    box-shadow: 0 0 0 1px rgba(0,255,136,0.3);
    transition: all 0.08s ease;
  `;

  // 选择模式引导提示
  const guide = document.createElement('div');
  guide.id = '__auto_picker_guide__';
  guide.style.cssText = `
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(20,20,20,0.92);
    color: #fff;
    padding: 10px 24px;
    border-radius: 24px;
    font-size: 14px;
    font-family: -apple-system, sans-serif;
    z-index: 2147483647;
    pointer-events: none;
    display: none;
    white-space: nowrap;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    letter-spacing: 0.3px;
  `;

  // 元素信息提示
  const tooltip = document.createElement('div');
  tooltip.id = '__auto_picker_tooltip__';
  tooltip.style.cssText = `
    position: fixed;
    background: rgba(20,20,20,0.9);
    color: #00ff88;
    padding: 5px 10px;
    border-radius: 6px;
    font-size: 11px;
    font-family: monospace;
    z-index: 2147483647;
    pointer-events: none;
    display: none;
    max-width: 320px;
    word-break: break-all;
    line-height: 1.5;
  `;

  // DOM插入（在页面加载完成后）
  function ensureUIInserted() {
    if (!document.body) return;
    if (!document.getElementById('__auto_picker_overlay__')) {
      document.body.appendChild(overlay);
    }
    if (!document.getElementById('__auto_picker_guide__')) {
      document.body.appendChild(guide);
    }
    if (!document.getElementById('__auto_picker_tooltip__')) {
      document.body.appendChild(tooltip);
    }
  }

  // ═══════════════════════════════════════════
  // 元素特征提取
  // ═══════════════════════════════════════════

  /**
   * 提取元素的可识别特征
   * @param {Element} el
   * @returns {ElementFeatures}
   */
  function getElementFeatures(el) {
    if (!el) return null;

    const attrs = {
      id:          el.id             || null,
      dataTestId:  el.getAttribute('data-testid')  || null,
      ariaLabel:   el.getAttribute('aria-label')   || null,
      placeholder: el.getAttribute('placeholder')  || null,
      name:        el.getAttribute('name')         || null,
      type:        el.getAttribute('type')         || null,
      role:        el.getAttribute('role')         || null,
      className:   el.className && typeof el.className === 'string'
                     ? el.className.trim().slice(0, 100)
                     : null
    };

    const text = (el.innerText || el.textContent || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 60);

    const rect = el.getBoundingClientRect();

    // 生成父元素信息（用于后备查找）
    const parentEl = el.parentElement;
    const parentAttrs = parentEl ? {
      id:         parentEl.id || null,
      dataTestId: parentEl.getAttribute('data-testid') || null,
      ariaLabel:  parentEl.getAttribute('aria-label')  || null
    } : {};

    return {
      tag:      el.tagName.toLowerCase(),
      text,
      attrs,
      selector: buildBestSelector(el, attrs),
      candidateSelectors: buildCandidateSelectors(el, attrs),
      nthOfType: getNthOfType(el),
      semantics: getElementSemantics(el),
      parent: {
        tag:      parentEl?.tagName?.toLowerCase() || '',
        attrs:    parentAttrs,
        selector: parentEl ? buildBestSelector(parentEl, parentAttrs) : ''
      },
      rect: {
        width:  Math.round(rect.width),
        height: Math.round(rect.height),
        top:    Math.round(rect.top),
        left:   Math.round(rect.left)
      }
    };
  }

  /**
   * 生成最优CSS选择器
   * 优先级：id > data-testid > aria-label > placeholder > name > tag+class
   */
  function buildBestSelector(el, attrs) {
    if (!el) return '';

    // 1. id（全局唯一）
    if (attrs.id && /^[a-zA-Z]/.test(attrs.id)) {
      return `#${CSS.escape(attrs.id)}`;
    }

    // 2. data-testid（专为测试设计，稳定）
    if (attrs.dataTestId) {
      return `[data-testid="${attrs.dataTestId}"]`;
    }

    // 3. aria-label（语义化，较稳定）
    if (attrs.ariaLabel) {
      return `[aria-label="${attrs.ariaLabel}"]`;
    }

    // 4. placeholder（输入框特有）
    if (attrs.placeholder) {
      return `[placeholder="${attrs.placeholder}"]`;
    }

    // 5. name属性
    if (attrs.name) {
      return `[name="${attrs.name}"]`;
    }

    // 6. 标签名 + 有意义的class
    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList || [])
      .filter(c =>
        c.length > 2 &&
        c.length < 50 &&
        !c.includes('[') &&
        !c.includes(':') &&
        !c.includes('(') &&
        !/^\d/.test(c)
      );

    if (classes.length > 0) {
      // 取前两个class组合，提高特异性
      const classStr = classes.slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
      return `${tag}${classStr}`;
    }

    // 7. 仅标签名（最后手段）
    return tag;
  }

  /**
   * 生成多个候选选择器（按稳定性排序）
   */
  function buildCandidateSelectors(el, attrs) {
    if (!el) return [];
    const out = [];
    const tag = el.tagName.toLowerCase();

    const push = (sel) => {
      if (!sel || out.includes(sel)) return;
      out.push(sel);
    };

    // 强稳定标识
    if (attrs.id && /^[a-zA-Z]/.test(attrs.id)) push(`#${CSS.escape(attrs.id)}`);
    if (attrs.dataTestId) push(`[data-testid="${attrs.dataTestId}"]`);
    if (attrs.ariaLabel) push(`[aria-label="${attrs.ariaLabel}"]`);
    if (attrs.name) push(`[name="${attrs.name}"]`);
    if (attrs.placeholder) push(`[placeholder="${attrs.placeholder}"]`);

    // 标签 + 属性组合
    if (attrs.type) push(`${tag}[type="${attrs.type}"]`);
    if (attrs.role) push(`${tag}[role="${attrs.role}"]`);
    if (attrs.ariaLabel) push(`${tag}[aria-label="${attrs.ariaLabel}"]`);
    if (attrs.placeholder) push(`${tag}[placeholder="${attrs.placeholder}"]`);

    // class 组合
    const classes = Array.from(el.classList || [])
      .filter(c => c.length > 2 && c.length < 50 && !/^\d/.test(c))
      .slice(0, 3)
      .map(c => `.${CSS.escape(c)}`);
    if (classes.length) push(`${tag}${classes.join('')}`);
    if (classes.length >= 2) push(`${tag}${classes.slice(0, 2).join('')}`);

    // 父子关系（提升稳定性）
    if (el.parentElement) {
      const pSel = buildBestSelector(el.parentElement, {
        id: el.parentElement.id || null,
        dataTestId: el.parentElement.getAttribute('data-testid') || null,
        ariaLabel: el.parentElement.getAttribute('aria-label') || null,
        placeholder: null,
        name: null,
        type: null,
        role: el.parentElement.getAttribute('role') || null
      });
      if (pSel) push(`${pSel} > ${tag}`);
    }

    // 最后保底
    push(tag);
    return out.slice(0, 12);
  }

  /**
   * 提取交互语义特征，供后续评分
   */
  function getElementSemantics(el) {
    const textRaw = (el.innerText || el.textContent || '').trim();
    const aria = el.getAttribute('aria-label') || '';
    const placeholder = el.getAttribute('placeholder') || '';
    const type = (el.getAttribute('type') || '').toLowerCase();

    const keyText = `${textRaw} ${aria} ${placeholder}`.toLowerCase();
    const classStr = (typeof el.className === 'string' ? el.className : '').toLowerCase();

    return {
      visible: (() => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })(),
      clickable: typeof el.click === 'function' && !el.disabled,
      editable: el.tagName === 'TEXTAREA' ||
                (el.tagName === 'INPUT' && type !== 'file' && type !== 'button' && type !== 'submit') ||
                el.hasAttribute('contenteditable'),
      fileLike: type === 'file' ||
                keyText.includes('上传') ||
                keyText.includes('upload') ||
                classStr.includes('upload'),
      sendLike: keyText.includes('发送') ||
                keyText.includes('send') ||
                keyText.includes('submit') ||
                classStr.includes('send')
    };
  }

  /**
   * 获取元素在同类兄弟中的序号（用于nth-of-type）
   */
  function getNthOfType(el) {
    if (!el.parentElement) return 1;
    const siblings = Array.from(el.parentElement.children)
      .filter(c => c.tagName === el.tagName);
    return siblings.indexOf(el) + 1;
  }

  // ═══════════════════════════════════════════
  // 元素查找（供player.js / background.js使用）
  // ═══════════════════════════════════════════

  /**
   * 根据特征查找元素
   * 按优先级依次尝试多种策略
   * @param {ElementFeatures} features
   * @returns {Element|null}
   */
  function findElement(features) {
    if (!features) return null;
    const selectors = [
      features.selector,
      ...(features.candidateSelectors || [])
    ].filter(Boolean);

    const pool = new Set();
    selectors.forEach(sel => {
      try {
        document.querySelectorAll(sel).forEach(el => pool.add(el));
      } catch {}
    });

    if (pool.size === 0 && features.tag) {
      try { document.querySelectorAll(features.tag).forEach(el => pool.add(el)); } catch {}
    }
    if (pool.size === 0) {
      document.querySelectorAll('textarea,input,button,[role="button"],[contenteditable="true"]').forEach(el => pool.add(el));
    }

    let best = null;
    let bestScore = -1;
    for (const el of pool) {
      if (!document.contains(el)) continue;
      const score = scoreCandidate(el, features, selectors);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }

    return bestScore >= 30 ? best : null;
  }

  function scoreCandidate(el, features, selectors) {
    let score = 0;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) score += 10;

    // selector 命中加分
    selectors.forEach((sel, idx) => {
      try {
        if (sel && el.matches(sel)) score += (idx === 0 ? 40 : 20 - Math.min(idx, 8));
      } catch {}
    });

    const attrs = features.attrs || {};
    if (attrs.id && el.id === attrs.id) score += 30;
    if (attrs.dataTestId && el.getAttribute('data-testid') === attrs.dataTestId) score += 26;
    if (attrs.ariaLabel && el.getAttribute('aria-label') === attrs.ariaLabel) score += 22;
    if (attrs.placeholder && el.getAttribute('placeholder') === attrs.placeholder) score += 20;
    if (attrs.name && el.getAttribute('name') === attrs.name) score += 14;
    if (features.tag && el.tagName.toLowerCase() === features.tag) score += 10;
    if (attrs.type && (el.getAttribute('type') || '').toLowerCase() === String(attrs.type).toLowerCase()) score += 10;

    const txt = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    if (features.text && txt) {
      if (txt === features.text) score += 18;
      else if (txt.includes(features.text.slice(0, 16))) score += 12;
    }

    // 语义约束
    const sem = features.semantics || {};
    const type = (el.getAttribute('type') || '').toLowerCase();
    const selfText = `${txt} ${(el.getAttribute('aria-label') || '')} ${(el.getAttribute('placeholder') || '')}`.toLowerCase();
    if (sem.editable) {
      if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && type !== 'file') || el.hasAttribute('contenteditable')) score += 10;
      else score -= 8;
    }
    if (sem.fileLike) {
      if (type === 'file' || selfText.includes('上传') || selfText.includes('upload')) score += 10;
    }
    if (sem.sendLike) {
      if (selfText.includes('发送') || selfText.includes('send') || selfText.includes('submit')) score += 10;
    }

    return score;
  }

  /**
   * 检查元素是否存在且可见
   */
  function isElementAvailable(features) {
    const el = findElement(features);
    if (!el) return false;
    if (!document.contains(el)) return false;
    // 检查可见性
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ═══════════════════════════════════════════
  // 选择模式（交互）
  // ═══════════════════════════════════════════

  function startPicking(pickKey, label = '') {
    ensureUIInserted();
    isPickingMode  = true;
    currentPickKey = pickKey;

    guide.textContent = `🖱️ 请点击"${label || '目标元素'}"   按 Esc 取消`;
    guide.style.display = 'block';
    document.body.style.cursor = 'crosshair';

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click',     onClick,     true);
    document.addEventListener('keydown',   onKeyDown,   true);
  }

  function stopPicking() {
    isPickingMode  = false;
    currentPickKey = null;

    guide.style.display   = 'none';
    overlay.style.display = 'none';
    tooltip.style.display = 'none';
    document.body.style.cursor = '';
    lastHighlighted = null;

    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click',     onClick,     true);
    document.removeEventListener('keydown',   onKeyDown,   true);
  }

  function onMouseMove(e) {
    if (!isPickingMode) return;

    const el = e.target;
    if (el === overlay || el === guide || el === tooltip) return;

    lastHighlighted = el;

    // 更新高亮框
    const rect = el.getBoundingClientRect();
    overlay.style.left   = rect.left   + 'px';
    overlay.style.top    = rect.top    + 'px';
    overlay.style.width  = rect.width  + 'px';
    overlay.style.height = rect.height + 'px';
    overlay.style.display = 'block';

    // 更新tooltip
    const features = getElementFeatures(el);
    const selectorText = features?.selector || el.tagName.toLowerCase();
    const attrInfo = [
      features?.attrs?.id         ? `id="${features.attrs.id}"` : '',
      features?.attrs?.ariaLabel  ? `aria-label="${features.attrs.ariaLabel}"` : '',
      features?.attrs?.placeholder? `placeholder="${features.attrs.placeholder}"` : ''
    ].filter(Boolean).join(' ');

    tooltip.textContent = `${selectorText}${attrInfo ? '\n' + attrInfo : ''}`;

    // tooltip位置（跟随鼠标，避免超出屏幕）
    const tipX = Math.min(e.clientX + 12, window.innerWidth  - 340);
    const tipY = Math.min(e.clientY + 16, window.innerHeight - 80);
    tooltip.style.left    = tipX + 'px';
    tooltip.style.top     = tipY + 'px';
    tooltip.style.display = 'block';
  }

  function onClick(e) {
    if (!isPickingMode) return;
    if (e.target === overlay || e.target === guide) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const el = e.target;
    const features = getElementFeatures(el);
    const pickKey   = currentPickKey;

    stopPicking();

    // 发送结果给background.js
    chrome.runtime.sendMessage({
      type: 'ELEMENT_PICKED',
      data: { callbackKey: pickKey, features }
    }).catch(err => {
      console.warn('[Picker] 发送ELEMENT_PICKED失败:', err);
    });
  }

  function onKeyDown(e) {
    if (!isPickingMode) return;
    if (e.key === 'Escape') {
      const pickKey = currentPickKey;
      stopPicking();
      chrome.runtime.sendMessage({
        type: 'PICKING_CANCELLED',
        data: { callbackKey: pickKey }
      }).catch(() => {});
    }
  }

  // ═══════════════════════════════════════════
  // 消息监听
  // ═══════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg?.type) return false;

    switch (msg.type) {

      case 'START_PICKING': {
        // 先停止已有的选择模式
        if (isPickingMode) stopPicking();
        ensureUIInserted();
        startPicking(msg.data?.callbackKey, msg.data?.label);
        sendResponse({ ok: true });
        break;
      }

      case 'STOP_PICKING': {
        stopPicking();
        sendResponse({ ok: true });
        break;
      }

      case 'FIND_ELEMENT': {
        // 验证元素是否存在
        try {
          const available = isElementAvailable(msg.data?.features);
          const el = available ? findElement(msg.data.features) : null;
          sendResponse({
            found:    available,
            selector: el ? (msg.data.features?.selector || '') : null
          });
        } catch {
          sendResponse({ found: false });
        }
        break;
      }

      case 'HIGHLIGHT_ELEMENT': {
        // 短暂高亮一个元素（配置验证时使用）
        try {
          ensureUIInserted();
          const el = findElement(msg.data?.features);
          if (el) {
            const rect = el.getBoundingClientRect();
            overlay.style.left   = rect.left   + 'px';
            overlay.style.top    = rect.top    + 'px';
            overlay.style.width  = rect.width  + 'px';
            overlay.style.height = rect.height + 'px';
            overlay.style.display = 'block';
            setTimeout(() => { overlay.style.display = 'none'; }, 2000);
          }
          sendResponse({ found: !!el });
        } catch {
          sendResponse({ found: false });
        }
        break;
      }
    }

    return true;  // 保持异步响应通道
  });

  // ═══════════════════════════════════════════
  // 全局暴露（供player.js使用）
  // ═══════════════════════════════════════════

  window.ElementPicker = {
    findElement,
    isElementAvailable,
    getElementFeatures,
    buildBestSelector
  };

  window.__PickerReady = true;

})();