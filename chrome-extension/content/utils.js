// content/utils.js
// 工具函数库 - 全部挂载到 window.AutoUtils
// 注意：此文件最先加载，其他content script依赖它

'use strict';

(function () {

  // ═══════════════════════════════════════════
  // 基础工具
  // ═══════════════════════════════════════════

  /**
   * 延迟指定毫秒
   */
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 等待DOM元素出现
   * @param {string} selector CSS选择器
   * @param {number} timeout  超时毫秒
   * @param {Element} root    搜索根节点
   */
  function waitForElement(selector, timeout = 10000, root = document) {
    return new Promise((resolve, reject) => {
      // 已存在则直接返回
      const existing = root.querySelector(selector);
      if (existing) { resolve(existing); return; }

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`等待元素超时（${timeout}ms）：${selector}`));
      }, timeout);

      const observer = new MutationObserver(() => {
        const el = root.querySelector(selector);
        if (el) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(root, { childList: true, subtree: true });
    });
  }

  /**
   * 带重试的等待元素
   */
  async function waitForElementWithRetry(selector, timeout = 10000, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        return await waitForElement(selector, timeout);
      } catch (err) {
        if (i === retries - 1) throw err;
        await sleep(1000);
      }
    }
  }

  // ═══════════════════════════════════════════
  // React/Vue 兼容输入
  // ═══════════════════════════════════════════

  // 提前获取原生setter，避免被框架覆盖
  const _nativeTextareaSetter = (() => {
    try {
      return Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;
    } catch { return null; }
  })();

  const _nativeInputSetter = (() => {
    try {
      return Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
    } catch { return null; }
  })();

  /**
   * 兼容React/Vue的输入填充
   * @param {HTMLElement} el   目标元素
   * @param {string}      value 要填入的内容
   */
  function setNativeValue(el, value) {
    if (!el) throw new Error('setNativeValue: 元素不存在');

    const tag = el.tagName?.toUpperCase();

    if (tag === 'TEXTAREA' && _nativeTextareaSetter) {
      _nativeTextareaSetter.call(el, value);
    } else if (tag === 'INPUT' && _nativeInputSetter) {
      _nativeInputSetter.call(el, value);
    } else {
      // contenteditable 或其他
      el.textContent = value;
      el.innerHTML = value;
    }

    // 触发所有可能需要的事件
    const events = [
      new Event('input',  { bubbles: true, cancelable: true }),
      new Event('change', { bubbles: true, cancelable: true }),
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: value
      }),
      new KeyboardEvent('keydown',  { bubbles: true, key: 'a' }),
      new KeyboardEvent('keypress', { bubbles: true, key: 'a' }),
      new KeyboardEvent('keyup',    { bubbles: true, key: 'a' })
    ];

    events.forEach(ev => {
      try { el.dispatchEvent(ev); } catch {}
    });
  }

  // ═══════════════════════════════════════════
  // Claude 回复获取（Arena.ai 实测验证方案）
  // ═══════════════════════════════════════════

  /**
   * 获取最后一条Claude回复（不是用户消息）
   * 实测：ol > div 选择器可获取44000+字符的完整回复
   */
  function getLastClaudeReply() {
    const messages = Array.from(document.querySelectorAll('ol > div'));

    for (let i = messages.length - 1; i >= 0; i--) {
      const el = messages[i];
      const text = (el.innerText || el.textContent || '').trim();
      const isUserMsg = el.className?.includes('justify-end');

      if (!isUserMsg && text.length > 100) {
        return text;
      }
    }

    return null;
  }

  /**
   * 等待Claude回复出现（文字长度稳定）
   */
  async function waitForClaudeReplyStable(minLength = 500, timeout = 180000) {
    const startTime = Date.now();
    let lastLength = 0;
    let stableCount = 0;

    while (Date.now() - startTime < timeout) {
      await sleep(1000);
      const text = getLastClaudeReply();
      const len = text?.length || 0;

      if (len >= minLength) {
        if (len === lastLength) {
          stableCount++;
          if (stableCount >= 3) return text;
        } else {
          stableCount = 0;
          lastLength = len;
        }
      }
    }

    throw new Error('等待Claude回复超时');
  }

  // ═══════════════════════════════════════════
  // 提示词提取（自定义标记）
  // ═══════════════════════════════════════════

  /**
   * 从Claude回复中提取生图提示词
   * @param {string} fullText       Claude完整回复
   * @param {object} extractConfig  提取配置
   * @returns {{ promptText, prompts, startPosition, extractedLength, count }}
   */
  function extractPromptsFromReply(fullText, extractConfig) {
    if (!fullText || !fullText.trim()) {
      throw new Error('回复文本为空，无法提取提示词');
    }

    // ── 模式1：提取全部内容 ──
    if (!extractConfig || extractConfig.mode === 'full') {
      const prompts = parseNumberedPrompts(fullText, extractConfig);
      return {
        promptText: fullText,
        prompts,
        startPosition: 0,
        extractedLength: fullText.length,
        count: prompts.length
      };
    }

    // ── 模式2：按标记提取 ──
    const rawStart = extractConfig.startMarker;
    const startMarker = (rawStart && rawStart !== 'undefined' ? rawStart : '').trim();
    const rawEnd = extractConfig.endMarker;
    const endMarker = (rawEnd && rawEnd !== 'undefined' ? rawEnd : '').trim();

    if (!startMarker) {
      const prompts = parseNumberedPrompts(fullText, extractConfig);
      return {
        promptText: fullText,
        prompts,
        startPosition: 0,
        extractedLength: fullText.length,
        count: prompts.length
      };
    }

    // 查找开始标记位置（区分大小写）
    const startIndex = fullText.indexOf(startMarker);
    if (startIndex === -1) {
      const fallbackPrompts = parseNumberedPrompts(fullText, extractConfig);
      if (fallbackPrompts.length > 0) {
        return {
          promptText: fullText,
          prompts: fallbackPrompts,
          startPosition: 0,
          extractedLength: fullText.length,
          count: fallbackPrompts.length
        };
      }
      throw new Error(
        `在回复中未找到开始标记：\n"${startMarker}"\n\n` +
        `请检查：\n` +
        `1. 标记文字是否与实际输出完全一致（区分大小写）\n` +
        `2. 是否有多余空格或换行\n` +
        `3. 可在设置页面的"提取测试"功能中粘贴回复验证`
      );
    }

    // 确定提取起点
    let extractStart;
    if (extractConfig.includeMarker !== false) {
      // 包含标记行本身
      extractStart = startIndex;
    } else {
      // 从标记后的第一个换行开始
      const afterMarker = startIndex + startMarker.length;
      const nextNewline = fullText.indexOf('\n', afterMarker);
      extractStart = nextNewline !== -1 ? nextNewline + 1 : afterMarker;
    }

    // 确定提取终点
    let extractEnd = fullText.length;
    if (endMarker) {
      const endIndex = fullText.indexOf(endMarker, extractStart);
      if (endIndex !== -1) {
        extractEnd = endIndex;
      }
      // 找不到结束标记时提取到结尾，不报错
    }

    // 截取内容
    const promptText = fullText.slice(extractStart, extractEnd).trim();
    if (!promptText) {
      throw new Error(
        '提取到的内容为空\n' +
        '请检查开始标记和结束标记的位置是否正确'
      );
    }

    const prompts = parseNumberedPrompts(promptText, extractConfig);

    return {
      promptText,
      prompts,
      startPosition: startIndex,
      extractedLength: promptText.length,
      count: prompts.length
    };
  }

  // 英文常见的分条开头词（Claude 输出格式不固定时使用）
  const ENGLISH_PROMPT_KEYWORDS = 'Shot|Prompt|Image|Scene|Frame|Pic|Picture|Photo|Camera|Cut|Angle|View';

  function _buildPromptHeaderRegex(flags) {
    return new RegExp(
      '^\\s*(?:' +
        '(?:' + ENGLISH_PROMPT_KEYWORDS + ')\\s*\\d+\\s*[\\-\\.、\\)\\:：]?\\s*' +
        '|' +
        '\\d+\\s*[\\.、\\)\\:：]\\s*' +
        '|' +
        '[一二三四五六七八九十百千]+\\s*[、\\.]\\s*' +
      ')',
      flags || ''
    );
  }

  function parseNumberedPromptsByLines(text) {
    if (!text) return [];
    const numberPattern = _buildPromptHeaderRegex('i');
    const lines = text.split('\n');
    const prompts = [];
    let currentPrompt = '';

    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;

      if (numberPattern.test(trimmed)) {
        if (currentPrompt.trim()) prompts.push(currentPrompt.trim());
        currentPrompt = trimmed.replace(numberPattern, '').trim();
      } else if (currentPrompt) {
        currentPrompt += '\n' + trimmed;
      }
    });

    if (currentPrompt.trim()) prompts.push(currentPrompt.trim());
    return prompts.filter(p => p.length > 5);
  }

  function parseNumberedPromptsInlineDigits(text) {
    if (!text) return [];
    const hasDigit = /\d+[\.、\)]\s/.test(text);
    const kwRe = new RegExp('(?:' + ENGLISH_PROMPT_KEYWORDS + ')\\s*\\d+', 'i');
    const hasKw = kwRe.test(text);
    if (!hasDigit && !hasKw) return [];

    if (hasKw) {
      const kwSplit = new RegExp(
        '(?<=[^\\w])(?=(?:' + ENGLISH_PROMPT_KEYWORDS + ')\\s*\\d+)',
        'i'
      );
      const parts = text.split(kwSplit);
      if (parts.length > 1) {
        const stripRe = new RegExp(
          '^\\s*(?:' + ENGLISH_PROMPT_KEYWORDS + ')\\s*\\d+\\s*[\\-\\.、\\)\\:：]?\\s*',
          'i'
        );
        return parts.map(s => s.replace(stripRe, '').trim()).filter(p => p.length > 5);
      }
    }

    const parts = text.split(/(?<=[^\d.])(?=\d{1,3}[\.、\)]\s+)/);
    if (parts.length <= 1) return [];
    return parts.map(p => p.replace(/^\s*\d+[\.、\)]\s+/, '').trim()).filter(p => p.length > 5);
  }

  function parsePromptsByCustomPattern(text, patternStr) {
    if (!text || !patternStr) return [];
    try {
      const parts = patternStr.split('\n').map(l => l.trim()).filter(Boolean);
      if (!parts.length) return [];
      const combined = parts.map(p => '(?:' + p + ')').join('|');
      const re = new RegExp('^\\s*(?:' + combined + ')\\s*$', 'im');
      const lines = text.split('\n');
      const prompts = [];
      let cur = '';

      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        if (re.test(line)) {
          if (cur.trim()) prompts.push(cur.trim());
          cur = '';
        } else {
          cur += (cur ? '\n' : '') + t;
        }
      }
      if (cur.trim()) prompts.push(cur.trim());
      return prompts.filter(p => p.length > 5);
    } catch {
      return [];
    }
  }

  /**
   * 按数字序号解析提示词列表
   * 支持：行首 1. / 1、/ 1) / 一、；以及同一行内「… 2. …」分段
   * 支持自定义分隔标记（通过 extractConfig.promptSplitPattern）
   */
  function parseNumberedPrompts(text, extractConfig) {
    if (!text) return [];

    if (extractConfig?.promptSplitMode === 'custom' && extractConfig.promptSplitPattern) {
      const custom = parsePromptsByCustomPattern(text, extractConfig.promptSplitPattern);
      if (custom.length > 0) return custom;
    }

    const byLines = parseNumberedPromptsByLines(text);
    if (byLines.length > 1) return byLines;
    const blob = (byLines.length === 1 ? byLines[0] : text).trim();
    const inline = parseNumberedPromptsInlineDigits(blob);
    if (inline.length > 1) return inline;
    if (byLines.length === 1) return byLines;
    const fromRaw = parseNumberedPromptsInlineDigits(text.trim());
    return fromRaw.length ? fromRaw : [];
  }

  /**
   * 验证Claude回复完整性
   * @returns {{ isValid, checks, warnings }}
   */
  function validateReply(text, extractConfig) {
    const checks = {};
    const warnings = [];

    checks.hasContent = !!(text && text.trim().length > 0);
    checks.isLongEnough = !!(text && text.length > 500);

    if (!checks.hasContent) {
      warnings.push('回复内容为空');
      return { isValid: false, checks, warnings };
    }

    if (!checks.isLongEnough) {
      warnings.push(`回复内容过短（${text.length}字符），可能不完整`);
    }

    // 检查标记
    if (extractConfig?.mode === 'marker' && extractConfig?.startMarker) {
      checks.hasMarker = text.includes(extractConfig.startMarker);
      if (!checks.hasMarker) {
        warnings.push(`回复中未找到提取标记："${extractConfig.startMarker}"`);
      }
    } else {
      checks.hasMarker = true;
    }

    // 尝试提取并检查数量
    try {
      const result = extractPromptsFromReply(text, extractConfig);
      checks.promptCount = result.count;
      checks.hasSufficientPrompts = result.count >= 5;
      if (result.count < 5) {
        warnings.push(`提取到的提示词数量较少（${result.count}条）`);
      }
    } catch (err) {
      checks.hasSufficientPrompts = false;
      checks.promptCount = 0;
      warnings.push('提示词提取失败：' + err.message);
    }

    const isValid = checks.hasContent &&
                    checks.isLongEnough &&
                    checks.hasMarker &&
                    checks.hasSufficientPrompts;

    return { isValid, checks, warnings };
  }

  // ═══════════════════════════════════════════
  // 分批逻辑
  // ═══════════════════════════════════════════

  /**
   * 将提示词数组分批
   * @param {string[]} prompts   提示词数组
   * @param {number}   batchSize 每批数量
   * @returns {Batch[]}
   */
  function splitIntoBatches(prompts, batchSize) {
    if (!prompts || prompts.length === 0) return [];
    if (batchSize <= 0) batchSize = 10;

    const batches = [];
    const total = Math.ceil(prompts.length / batchSize);

    for (let i = 0; i < prompts.length; i += batchSize) {
      const batchPrompts = prompts.slice(i, i + batchSize);
      batches.push({
        index:          Math.floor(i / batchSize) + 1,
        total,
        prompts:        batchPrompts,
        startNum:       i + 1,
        endNum:         Math.min(i + batchSize, prompts.length),
        status:         'pending',   // pending|processing|done|failed
        downloadedCount: 0,
        retryCount:     0
      });
    }

    return batches;
  }

  /**
   * 构建发送给豆包的批次消息
   */
  function buildBatchMessage(batch, productName, igCfg) {
    const promptLines = batch.prompts
      .map((p, i) => `${batch.startNum + i}. ${p}`)
      .join('\n\n');

    const vars = {
      productName,
      promptCount: String(batch.prompts.length),
      batchIndex:  String(batch.index),
      batchTotal:  String(batch.total)
    };
    const expand = (tpl) => {
      if (!tpl) return '';
      return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
    };

    let prefix;
    if (batch.index === 1) {
      const tpl = igCfg?.batchPrefixFirst ??
        '这是商品"{productName}"的生图任务\n请按以下{promptCount}条提示词依次生成图片，每条1张：';
      prefix = expand(tpl);
    } else {
      const tpl = igCfg?.batchPrefixContinue ??
        '继续第{batchIndex}批（共{batchTotal}批）：';
      prefix = expand(tpl);
    }

    if (prefix) {
      return [prefix, '', promptLines].join('\n');
    }
    return promptLines;
  }

  // ═══════════════════════════════════════════
  // 错误日志
  // ═══════════════════════════════════════════

  /**
   * 写入错误日志（存到chrome.storage.local）
   */
  async function writeErrorLog(logEntry) {
    try {
      const result = await chrome.storage.local.get('errorLogs');
      const logs = result.errorLogs || [];
      logs.push({
        timestamp: new Date().toLocaleString('zh-CN'),
        ...logEntry
      });
      // 最多保留100条
      const trimmed = logs.slice(-100);
      await chrome.storage.local.set({ errorLogs: trimmed });
    } catch {
      // 日志写入失败不影响主流程
    }
  }

  // ═══════════════════════════════════════════
  // 挂载到全局
  // ═══════════════════════════════════════════

  window.AutoUtils = {
    sleep,
    waitForElement,
    waitForElementWithRetry,
    setNativeValue,
    getLastClaudeReply,
    waitForClaudeReplyStable,
    extractPromptsFromReply,
    parseNumberedPrompts,
    validateReply,
    splitIntoBatches,
    buildBatchMessage,
    writeErrorLog
  };

  // 标记加载完成（供其他脚本检测）
  window.__AutoUtilsReady = true;

})();