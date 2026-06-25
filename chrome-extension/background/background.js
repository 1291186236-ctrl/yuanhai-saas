// background/background.js
// 任务调度中心 - Service Worker
// 注意：Service Worker 不能访问 DOM，通过 scripting.executeScript 操作页面

'use strict';

// ═══════════════════════════════════════════
// 全局状态
// ═══════════════════════════════════════════

const State = {
  // 标签页
  arenaTabId:   null,
  doubaoTabId:  null,

  // 任务
  products:     [],
  config:       null,
  taskRunning:  false,
  taskPaused:   false,

  // 流水线A
  analysisIndex: 0,
  _skipCurrent:  false,

  // 流水线B
  doubaoQueue:   [],
  doubaoRunning: false,

  // 控制信号
  _stopSignal: false,

  // 全局去重（模式B: 同一页面连续处理）
  globalDownloadedUrls: new Set(),
  globalReplyFingerprints: new Set(),

  // 失败重试计数（模式B）
  _currentProductRetries: 0,

  // 本次任务的目录标签（同一次"开始"生成的所有图片统一归档），格式 YYYYMMDD_HHmmss
  taskFolderTag: null,

  // URL → 目标相对路径 映射，供 chrome.downloads.onDeterminingFilename 强制落盘用
  // 解决 Chrome 在 Windows 中文路径下静默忽略 downloads.download({filename}) 的问题
  pendingDownloadPaths: new Map()
};

// ═══════════════════════════════════════════
// 下载文件名权威钩子
// Chrome 在某些环境（Windows 中文系统 / MV3 / 文件名含中文）下会默默忽略
// chrome.downloads.download({filename}) 里的路径参数，把文件直接扔进"下载"根目录。
// 通过 onDeterminingFilename 事件可以在 Chrome 真正落盘前接管，强制指定路径。
// ═══════════════════════════════════════════
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const expected = State.pendingDownloadPaths.get(item.url)
                || State.pendingDownloadPaths.get(item.finalUrl);
  if (expected) {
    State.pendingDownloadPaths.delete(item.url);
    State.pendingDownloadPaths.delete(item.finalUrl);
    suggest({ filename: expected, conflictAction: 'uniquify' });
  } else {
    suggest();
  }
});

/** 用户点击停止或 taskRunning 被置为 false 时，长轮询应立刻结束 */
function assertTaskRunning() {
  if (State._stopSignal || !State.taskRunning) {
    const e = new Error('TASK_STOPPED');
    e.code = 'TASK_STOPPED';
    throw e;
  }
}

// 超时配置（毫秒）
const TIMEOUTS = {
  claudeReply:  300000,   // 5分钟
  imageBatch:   300000,   // 5分钟
  upload:       120000,   // 2分钟
  pageLoad:      30000,   // 30秒
  buttonReady:   10000,   // 10秒
  retryDelay:    5000,    // 5秒
  maxRetries:    3
};

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn('[background] sidePanel 行为设置失败:', err);
  }
});

// ═══════════════════════════════════════════
// 消息路由
// ═══════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return false;

  // PING 立即同步响应，不走异步
  if (msg.type === 'PING') {
    sendResponse({ ok: true, ts: Date.now() });
    return false;
  }

  // ── 商业版：认证相关消息 ──
  if (msg.type === 'AUTH_SUCCESS') {
    console.log('[Auth] User logged in:', msg.user?.email);
    chrome.runtime.sendMessage({ type: 'AUTH_STATE_CHANGED', user: msg.user }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'AUTH_LOGOUT') {
    console.log('[Auth] User logged out');
    chrome.runtime.sendMessage({ type: 'AUTH_STATE_CHANGED', user: null }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'AUTH_EXPIRED') {
    console.warn('[Auth] Token expired');
    chrome.runtime.sendMessage({ type: 'AUTH_STATE_CHANGED', user: null }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  (async () => {
    try {
      switch (msg.type) {

        case 'START': {
          const result = await handleStart(msg.data);
          if (result?.error) {
            sendResponse({ ok: false, error: result.error });
          } else {
            sendResponse({ ok: true });
          }
          break;
        }

        case 'PAUSE':
          State.taskPaused = true;
          sendResponse({ ok: true });
          break;

        case 'RESUME':
          State.taskPaused = false;
          sendResponse({ ok: true });
          break;

        case 'SKIP':
          State._skipCurrent = true;
          sendResponse({ ok: true });
          break;

        case 'STOP':
          State._stopSignal = true;
          State.taskRunning = false;
          State.taskPaused  = false;
          State.doubaoQueue   = [];
          await saveProgress();
          broadcastToPopup({ type: 'TASK_STOPPED' });
          sendResponse({ ok: true });
          break;

        // picker.js → background → settings.js 中转
        case 'ELEMENT_PICKED':
        case 'PICKING_CANCELLED':
          broadcastToExtensionPages(msg);
          sendResponse({ ok: true });
          break;

        // content script 上报的进度
        case 'UPLOAD_PROGRESS':
        case 'IMAGE_GEN_PROGRESS':
          broadcastToPopup(msg);
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: true });
      }
    } catch (err) {
      console.error('[background] 消息处理错误:', err);
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;  // 异步响应
});

// ═══════════════════════════════════════════
// 标签页事件监听
// ═══════════════════════════════════════════

// 扩展自身主动关闭 tab 的豁免集合（reopenSiteTab 切商品时使用）
// 避免下方 onRemoved 监听器把"我们自己关的 tab"误判为"用户关了 tab"而暂停任务
const _selfClosedTabIds = new Set();

chrome.tabs.onRemoved.addListener((tabId) => {
  // 如果是我们自己关的 tab，只清理标记，不做任何中断行为
  if (_selfClosedTabIds.has(tabId)) {
    _selfClosedTabIds.delete(tabId);
    return;
  }

  if (tabId === State.arenaTabId) {
    State.arenaTabId = null;
    if (State.taskRunning) {
      State.taskPaused = true;
      broadcastToPopup({
        type: 'NEED_ACTION',
        data: {
          message: 'Arena.ai 标签页已关闭，任务已暂停\n请重新打开 Arena.ai 并点击"继续"',
          actionType: 'REOPEN_TAB',
          site: 'arena'
        }
      });
    }
  }

  if (tabId === State.doubaoTabId) {
    State.doubaoTabId = null;
    if (State.taskRunning) {
      State.taskPaused = true;
      broadcastToPopup({
        type: 'NEED_ACTION',
        data: {
          message: '豆包标签页已关闭，任务已暂停\n请重新打开豆包并点击"继续"',
          actionType: 'REOPEN_TAB',
          site: 'doubao'
        }
      });
    }
  }
});

// ═══════════════════════════════════════════
// 任务启动
// ═══════════════════════════════════════════

async function handleStart(data) {
  log('收到START', `商品${data?.products?.length || 0}个，config keys: ${Object.keys(data?.config || {}).join(',')}`);

  // 重置状态
  State.products      = data.products || [];
  State.config        = data.config   || {};
  State.taskRunning   = true;
  State.taskPaused    = false;
  State._stopSignal   = false;
  State._skipCurrent  = false;
  State.analysisIndex = 0;
  State.doubaoQueue   = [];
  State.doubaoRunning = false;
  State.globalDownloadedUrls.clear();
  State.globalReplyFingerprints.clear();
  State._currentProductRetries = 0;
  State.pendingDownloadPaths.clear();

  // 为本次任务生成唯一目录标签: YYYYMMDD_HHmmss
  // 同一天多次启动任务时，用时分秒区分，避免同商品覆盖混淆
  {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    State.taskFolderTag = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
      + `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    log('任务目录', `本次任务根目录: 生图结果_${State.taskFolderTag}`);
  }

  // 清除待处理商品的旧批次续传状态，确保重新开始
  for (const p of State.products) {
    if (['待处理', '分析中', '分析完成'].includes(p.status)) {
      delete p.currentBatchIndex;
      delete p._referenceImagesUploaded;
      delete p._promptSentBatches;
      delete p._waitBaselineByBatch;
      delete p._batchCompleted;
      delete p.batches;
      p.totalSavedCount = 0;
      p.savedImages     = [];
    }
  }

  // Migrate site features for safety
  migrateSiteFeatures(State.config);

  // 应用高级配置中的超时设置
  const adv = State.config.advancedConfig || {};
  if (adv.claudeReplyTimeout) TIMEOUTS.claudeReply = adv.claudeReplyTimeout;
  if (adv.pageLoadTimeout)    TIMEOUTS.pageLoad    = adv.pageLoadTimeout;

  try {
    const pipelineMode = State.config.pipelineMode || 'both';
    const needAnalysis = pipelineMode === 'both' || pipelineMode === 'analysis_only';
    const needImagegen = pipelineMode === 'both' || pipelineMode === 'imagegen_only';

    log('流水线模式', `mode=${pipelineMode}, 分析=${needAnalysis}, 生图=${needImagegen}`);

    if (needAnalysis) {
      const analysisSite = pickSiteByRole(State.config, 'analysis');
      log('网站角色查找', `分析站: ${analysisSite?.name || '未找到'} (${analysisSite?.url || '-'})`);
      const analysisUrl = analysisSite?.url || State.config.arenaConfig?.siteUrl || 'https://arena.ai';
      log('准备打开网站', `分析: ${analysisUrl}`);
      State.arenaTabId = await ensureTab('分析网站', analysisUrl);
    }

    if (needImagegen) {
      const imagegenSite = pickSiteByRole(State.config, 'imagegen');
      log('网站角色查找', `生图站: ${imagegenSite?.name || '未找到'} (${imagegenSite?.url || '-'})`);
      const imagegenUrl = imagegenSite?.url || State.config.doubaoConfig?.siteUrl || 'https://www.doubao.com';
      log('准备打开网站', `生图: ${imagegenUrl}`);
      State.doubaoTabId = await ensureTab('生图网站', imagegenUrl);
    }

    log('任务启动', `mode=${pipelineMode}, 分析TabId=${State.arenaTabId || '(跳过)'}, 生图TabId=${State.doubaoTabId || '(跳过)'}`);

    if (needAnalysis) {
      runPipelineA().catch(err => {
        console.error('[Pipeline A] 致命错误:', err);
        broadcastToPopup({
          type: 'ERROR',
          pipeline: 'analysis',
          data: { errorType: 'FATAL', message: '流水线A崩溃: ' + err.message }
        });
      });
    } else if (needImagegen) {
      // imagegen_only: extract prompts from analysisResult then queue into Pipeline B
      for (const p of State.products) {
        if (['待处理', '分析完成'].includes(p.status)) {
          if (p.imagePrompts?.length) {
            log('仅生图', `商品"${p.name}"：Excel中已有 ${p.imagePrompts.length} 条提示词`);
          } else if (p.analysisResult) {
            try {
              const extractResult = extractPrompts(p.analysisResult, State.config.extractConfig);
              p.promptText   = extractResult.promptText;
              p.imagePrompts = extractResult.prompts;
              log('仅生图', `商品"${p.name}"：从分析结果提取到 ${extractResult.count} 条提示词`);
            } catch (exErr) {
              log('仅生图', `商品"${p.name}"：提示词提取失败 - ${exErr.message}`, 'warn');
            }
          }
          if (!p.imagePrompts?.length) {
            log('仅生图', `商品"${p.name}"：无可用提示词，跳过`, 'warn');
            p.status = '失败';
            p.errorMessage = '没有可用的生图提示词。请在Excel"分析结果"列填入提示词，或先运行"分析+生图"完整流程';
            broadcastToPopup({
              type: 'PRODUCT_STATUS_CHANGED',
              data: { index: p.index, status: '失败', errorMessage: p.errorMessage }
            });
            continue;
          }
          p.status = '分析完成';
          State.doubaoQueue.push({ ...p });
        }
      }
      await saveProgress();
      runPipelineB().catch(err => {
        console.error('[Pipeline B] 致命错误:', err);
        broadcastToPopup({
          type: 'ERROR',
          pipeline: 'imagegen',
          data: { errorType: 'FATAL', message: '流水线B崩溃: ' + err.message }
        });
      });
    }

    return { ok: true };

  } catch (err) {
    State.taskRunning = false;
    const errMsg = '任务初始化失败: ' + err.message +
      '\n请检查：1) 网站URL是否正确  2) 网络是否通畅  3) 网站是否可正常访问';
    log('初始化失败', err.message, 'error');
    broadcastToPopup({
      type: 'ERROR',
      pipeline: 'system',
      data: { errorType: 'INIT_FAILED', message: errMsg }
    });
    return { error: errMsg };
  }
}

function pickSiteByRole(config, role) {
  const sites = Array.isArray(config?.sites) ? [...config.sites] : [];
  sites.sort((a, b) => (a.order || 999) - (b.order || 999));
  // 优先使用用户的活动选择；若无效则回落到首个 enabled 同角色站点
  const chosenId = config?.activeSiteSelection?.[role];
  if (chosenId) {
    const chosen = sites.find(s => s.enabled !== false && s.role === role && s.id === chosenId);
    if (chosen) return chosen;
  }
  return sites.find(s => s.enabled !== false && s.role === role) || null;
}

function resolveFailActionByRole(role) {
  const site = pickSiteByRole(State.config, role);
  if (site?.failAction) return site.failAction;
  // Legacy fallback
  const adv = State.config?.advancedConfig || {};
  const map = adv.failActionBySite || {};
  if (site && map[site.id]) return map[site.id];
  if (role === 'analysis') return adv.analysisFailAction || 'skip';
  if (role === 'imagegen') return adv.imagegenFailAction || 'skip';
  return 'skip';
}

function migrateSiteFeatures(cfg) {
  if (!cfg || !Array.isArray(cfg.sites)) return;
  const featureKeys = ['inputFeatures', 'uploadFeatures', 'sendFeatures',
    'uploadLoadingFeatures', 'uploadPreviewFeatures', 'uploadDeleteFeatures',
    'imageAreaFeatures', 'loadingFeatures'];

  cfg.sites.forEach(site => {
    const legacy = site.role === 'analysis' ? cfg.arenaConfig
                 : site.role === 'imagegen' ? cfg.doubaoConfig : null;
    if (!legacy) return;
    featureKeys.forEach(k => { if (!site[k] && legacy[k]) site[k] = legacy[k]; });
    ['verifyMode', 'uploadTimeout', 'maxRetries'].forEach(k => {
      if (site[k] === undefined && legacy[k] !== undefined) site[k] = legacy[k];
    });
    if (!site.url && legacy.siteUrl) site.url = legacy.siteUrl;
  });

  // Also sync from sites back to legacy for any code still using arenaConfig/doubaoConfig
  const analysisSite = pickSiteByRole(cfg, 'analysis');
  const imagegenSite = pickSiteByRole(cfg, 'imagegen');
  if (analysisSite && cfg.arenaConfig) {
    featureKeys.forEach(k => { if (analysisSite[k] && !cfg.arenaConfig[k]) cfg.arenaConfig[k] = analysisSite[k]; });
    if (analysisSite.verifyMode) cfg.arenaConfig.verifyMode = analysisSite.verifyMode;
    if (analysisSite.uploadTimeout) cfg.arenaConfig.uploadTimeout = analysisSite.uploadTimeout;
    if (analysisSite.maxRetries) cfg.arenaConfig.maxRetries = analysisSite.maxRetries;
  }
  if (imagegenSite && cfg.doubaoConfig) {
    featureKeys.forEach(k => { if (imagegenSite[k] && !cfg.doubaoConfig[k]) cfg.doubaoConfig[k] = imagegenSite[k]; });
    if (imagegenSite.verifyMode) cfg.doubaoConfig.verifyMode = imagegenSite.verifyMode;
  }

  // Migrate failAction, imageGenConfig, interceptorConfig into site objects
  const _failMap = cfg.advancedConfig?.failActionBySite || {};
  cfg.sites.forEach(site => {
    if (!site.failAction) {
      site.failAction = _failMap[site.id]
        || (site.role === 'analysis' ? (cfg.advancedConfig?.analysisFailAction || 'skip')
            : site.role === 'imagegen' ? (cfg.advancedConfig?.imagegenFailAction || 'skip')
            : 'skip');
    }
    if (site.role === 'imagegen') {
      if (!site.imageGenConfig) {
        site.imageGenConfig = { ...(cfg.imageGenConfig || {}) };
      }
      if (!site.interceptorConfig) {
        const isDoubao = site.id === 'site_doubao' || (site.url || '').includes('doubao');
        if (isDoubao) {
          site.interceptorConfig = {
            matchKey: 'imageMeta',
            originalPath: 'original_urls[0]',
            thumbUrlPaths: ['thumb_urls[0]'],
            hookInPlaceReplace: false
          };
        }
      }
    }
  });

  // 将每个 site.operationSteps 拷贝到对应的 legacy config（arenaConfig/doubaoConfig）
  // 并在缺失时根据旧 features 合成默认步骤，以支持从旧配置升级
  [analysisSite, imagegenSite].forEach(site => {
    if (!site) return;
    const legacy = site.role === 'analysis' ? cfg.arenaConfig : cfg.doubaoConfig;
    if (!legacy) return;
    if (Array.isArray(site.operationSteps) && site.operationSteps.length > 0) {
      legacy.operationSteps = site.operationSteps;
      return;
    }
    // 旧配置兜底：按 upload → input → send 合成
    const fallback = [];
    if (legacy.uploadFeatures) fallback.push({ type: 'upload', features: legacy.uploadFeatures });
    if (legacy.inputFeatures)  fallback.push({ type: 'input',  features: legacy.inputFeatures  });
    if (legacy.sendFeatures)   fallback.push({ type: 'send',   features: legacy.sendFeatures   });
    legacy.operationSteps = fallback;
    site.operationSteps  = fallback;
  });
}

// ═══════════════════════════════════════════
// 标签页管理
// ═══════════════════════════════════════════

async function ensureTab(type, url) {
  // 验证 URL 有效性
  let targetHost = '';
  try {
    const parsed = new URL(url);
    targetHost = parsed.hostname.toLowerCase();
  } catch {
    log(type, `URL无效: "${url}"，尝试补全协议`);
    try {
      const parsed = new URL('https://' + url);
      url = parsed.href;
      targetHost = parsed.hostname.toLowerCase();
    } catch {
      throw new Error(`[${type}] 无法解析网站URL: ${url}，请在设置中检查网站地址`);
    }
  }

  // 基于域名匹配已有标签页
  const getBaseDomain = (hostname) => {
    const parts = hostname.split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
  };

  const targetDomain = getBaseDomain(targetHost);
  log(type, `目标域名: ${targetDomain}，开始查找已有标签页...`);

  try {
    const tabs = await chrome.tabs.query({});
    log(type, `当前共${tabs.length}个标签页`);

    const existing = tabs.find(t => {
      if (!t.url || t.url.startsWith('chrome') || t.url.startsWith('edge') || t.url.startsWith('about:')) return false;
      try {
        const tabHost = new URL(t.url).hostname.toLowerCase();
        return getBaseDomain(tabHost) === targetDomain;
      } catch {
        return false;
      }
    });

    if (existing) {
      log(type, `复用已有标签页: tabId=${existing.id}, url=${existing.url}`);
      return existing.id;
    }
  } catch (err) {
    log(type, `查询标签页失败: ${err.message}`, 'warn');
  }

  // 新建标签页（active: true 确保用户可见）
  log(type, `未找到匹配标签页，正在打开: ${url}`);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const tab = await chrome.tabs.create({ url, active: true });
      log(type, `标签页已创建: tabId=${tab.id}，等待加载完成...`);
      await waitForTabLoad(tab.id, TIMEOUTS.pageLoad);

      // 验证标签页确实存在
      const verify = await chrome.tabs.get(tab.id);
      log(type, `标签页就绪: tabId=${verify.id}, status=${verify.status}, url=${verify.url || '(加载中)'}`);
      return tab.id;

    } catch (err) {
      log(type, `第${attempt}次打开失败: ${err.message}`, 'error');
      if (attempt >= 2) {
        throw new Error(`[${type}] 打开网页失败（${url}）：${err.message}`);
      }
      await sleep(2000);
    }
  }
}

/**
 * 关闭旧标签页并重新打开网站，返回新tabId。
 * @param {'analysis'|'imagegen'} role
 * @returns {Promise<number>} 新的tabId
 */
async function reopenSiteTab(role) {
  const oldTabId = role === 'analysis' ? State.arenaTabId : State.doubaoTabId;
  const site = pickSiteByRole(State.config, role);
  const siteName = site?.name || (role === 'analysis' ? '分析网站' : '生图网站');
  const url = site?.url
    || (role === 'analysis' ? State.config.arenaConfig?.siteUrl : State.config.doubaoConfig?.siteUrl)
    || '';

  log('隔离策略', `关闭${siteName}旧标签页 (tabId=${oldTabId})...`);
  if (oldTabId) {
    // 标记为"扩展自身主动关闭"，让 onRemoved 监听器跳过自动暂停逻辑
    _selfClosedTabIds.add(oldTabId);
    try {
      await chrome.tabs.remove(oldTabId);
    } catch {
      // 如果关闭失败（tab 可能已不存在），手动清除标记避免泄漏
      _selfClosedTabIds.delete(oldTabId);
    }
    // 同时立即把 State 里指向旧 tabId 的引用清空，避免后续逻辑误用
    if (role === 'analysis' && State.arenaTabId === oldTabId) State.arenaTabId = null;
    if (role === 'imagegen' && State.doubaoTabId === oldTabId) State.doubaoTabId = null;
  }

  await sleep(1000);

  log('隔离策略', `重新打开${siteName}: ${url}`);
  const newTabId = await ensureTab(siteName, url);

  if (role === 'analysis') {
    State.arenaTabId = newTabId;
  } else {
    State.doubaoTabId = newTabId;
  }

  await waitForContentScript(newTabId);

  if (site?.preSteps?.length) {
    log('隔离策略', `执行${siteName}前置步骤...`);
    const preResult = await executePreSteps(newTabId, site.preSteps, siteName);
    if (!preResult.ok) {
      log('隔离策略', `${siteName}前置步骤失败: ${preResult.failedStep}`, 'warn');
    }
  }

  return newTabId;
}

/**
 * 刷新页面后检测页面状态（新对话 or 旧对话）。
 * 对比刷新前后的URL，并检查页面是否有对话内容。
 * @returns {Promise<'same'|'new'>}
 */
async function detectPageStateAfterRefresh(tabId, urlBefore) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const urlAfter = tab.url || '';

    // URL变化（对话ID消失）→ 新页面
    if (urlBefore && urlAfter && urlBefore !== urlAfter) {
      const beforePath = new URL(urlBefore).pathname;
      const afterPath  = new URL(urlAfter).pathname;
      if (beforePath !== afterPath) {
        log('页面检测', `URL变化: ${beforePath} → ${afterPath}，判定为新页面`);
        return 'new';
      }
    }

    // URL不变 → 检查DOM是否有对话内容
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const msgs = document.querySelectorAll(
          '[class*="message"], [class*="chat"] [class*="content"], ol > div, [data-testid*="message"]'
        );
        let hasContent = false;
        msgs.forEach(el => {
          if (el.textContent && el.textContent.trim().length > 50) hasContent = true;
        });
        return hasContent;
      }
    });

    const hasConversation = result[0]?.result === true;
    log('页面检测', `URL${urlBefore === (tab.url || '') ? '不变' : '变化'}, 对话内容=${hasConversation ? '有' : '无'}`);
    return hasConversation ? 'same' : 'new';
  } catch (err) {
    log('页面检测', `检测失败: ${err.message}，保守判定为新页面`, 'warn');
    return 'new';
  }
}

/**
 * 刷新页面并检测状态，根据结果决定恢复策略。
 * @returns {Promise<'same'|'new'>} 页面状态
 */
async function refreshAndDetect(tabId) {
  let urlBefore = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    urlBefore = tab.url || '';
  } catch {}

  await chrome.tabs.reload(tabId);
  await waitForTabLoad(tabId, 30000);
  await sleep(2000);
  await waitForContentScript(tabId);

  return await detectPageStateAfterRefresh(tabId, urlBefore);
}

async function switchToTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    await sleep(600);
  } catch (err) {
    throw new Error(`切换标签页失败（tabId=${tabId}）: ${err.message}`);
  }
}

async function waitForTabLoad(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      fn(arg);
    };

    const safeTabGet = (id) => {
      if (typeof id !== 'number' || !Number.isFinite(id) || id < 0) {
        return Promise.reject(new Error(`Invalid tabId: ${id}`));
      }
      try { return chrome.tabs.get(id); }
      catch (e) { return Promise.reject(e); }
    };

    const timer = setTimeout(() => {
      safeTabGet(tabId).then(tab => {
        if (tab.status === 'complete') {
          done(resolve);
        } else {
          done(reject, new Error(`页面加载超时（${timeout / 1000}秒），URL: ${tab.url || '未知'}`));
        }
      }).catch(() => {
        done(reject, new Error('页面加载超时且标签页不存在'));
      });
    }, timeout);

    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        done(resolve);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    safeTabGet(tabId).then(tab => {
      if (tab.status === 'complete') {
        done(resolve);
      }
    }).catch(err => {
      done(reject, new Error(`标签页不存在（tabId=${tabId}）：${err.message}`));
    });
  });
}

/**
 * 等待 content script 加载完成
 */
async function waitForContentScript(tabId, timeout = 10000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (State._stopSignal || !State.taskRunning) return;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!(
          window.__AutoUtilsReady &&
          window.__PickerReady &&
          window.__ValidatorReady &&
          window.__PlayerReady
        )
      });
      if (results[0]?.result === true) return;
    } catch {}
    await sleep(500);
  }
  // 超时后继续（可能部分功能不可用）
  log('警告', `content script 等待超时 tabId=${tabId}`);
}

// ═══════════════════════════════════════════
// 流水线 A：Arena.ai 分析
// ═══════════════════════════════════════════

let _lastSuccessReplyFp = '';

async function runPipelineA() {
  _lastSuccessReplyFp = '';
  State.globalReplyFingerprints.clear();

  const pendingProducts = State.products.filter(p =>
    ['待处理', '分析中'].includes(p.status)
  );

  const isolation = State.config?.advancedConfig?.productIsolation || 'reopen';
  log('流水线A', `开始处理 ${pendingProducts.length} 个商品，隔离模式=${isolation}`);

  for (let i = 0; i < pendingProducts.length; i++) {
    if (State._stopSignal || !State.taskRunning) break;
    await waitWhilePaused();
    if (State._stopSignal) break;

    const product = pendingProducts[i];
    State.analysisIndex = i;

    log('流水线A', `▶ 开始处理第${i + 1}/${pendingProducts.length}个商品: ${product.name}`);
    await processOneProductInArena(product, i, pendingProducts.length);
    log('流水线A', `◀ 第${i + 1}个商品流程结束，状态=${product.status}`);

    const hasNext = i < pendingProducts.length - 1 && State.taskRunning && !State._stopSignal;
    if (!hasNext) continue;

    if (product.status === '失败') {
      // 失败恢复：两种模式都需要重开页面确保下一个商品有干净环境
      log('流水线A', `${product.name}失败，为下一个商品重开页面`);
      try {
        await reopenSiteTab('analysis');
        // reopenSiteTab 内部已执行前置步骤，标记下一个商品跳过重复执行
        const nextProduct = pendingProducts[i + 1];
        if (nextProduct) nextProduct._preStepsAlreadyDone = true;
      } catch (e) {
        log('流水线A', `重开页面失败: ${e.message}`, 'error');
      }
    } else if (isolation === 'reopen') {
      log('流水线A', `隔离策略=reopen，为下一个商品关闭重开Arena.ai...`);
      await reopenSiteTab('analysis');
      log('流水线A', `Arena.ai重开完成，准备处理下一个商品`);
      // reopenSiteTab 内部已执行前置步骤，标记下一个商品跳过重复执行，避免页面刚初始化
      // 时同样的探测 + 点击链路再跑一遍导致卡住（尤其是 scripting.executeScript 偶发挂起）
      const nextProduct = pendingProducts[i + 1];
      if (nextProduct) nextProduct._preStepsAlreadyDone = true;
    }
  }

  log('流水线A', '所有商品处理完毕');
  broadcastToPopup({ type: 'PIPELINE_A_DONE' });
  checkAllComplete();
}

async function processOneProductInArena(product, index, total) {
  const cfg = State.config.arenaConfig;
  const maxRetries = cfg?.maxRetries || TIMEOUTS.maxRetries;
  let retryCount = 0;
  let recoveryAttempts = 0;
  const maxRecovery = 2; // 最多恢复2次：模式B刷新1次 + 关闭重开1次

  while (retryCount <= maxRetries) {
    State._skipCurrent = false;

    try {
      // ── STEP 1: 切换到分析站点 ──
      const _siteLabel = pickSiteByRole(State.config, 'analysis')?.name || 'Arena.ai';
      broadcastProgress('analysis', {
        productName:   product.name,
        productIndex:  index,
        total,
        stage:         'switching',
        status:        '分析中'
      });
      product.status = '分析中';
      await saveProgress();

      log(_siteLabel, `STEP 1: 切换到标签页 tabId=${State.arenaTabId}`);
      await switchToTab(State.arenaTabId);
      log(_siteLabel, `STEP 1: 等待 content script 就绪...`);
      await waitForContentScript(State.arenaTabId);
      log(_siteLabel, `STEP 1: content script 就绪`);

      // ── STEP 1.5: 执行前置步骤（智能检测：按元素实际状态决定是否执行）──
      // 如果刚刚通过 reopenSiteTab 重开页面且里面已经跑过前置步骤，则跳过避免重复
      if (product._preStepsAlreadyDone) {
        log(_siteLabel, `STEP 1.5: 重开页面时已执行前置步骤，跳过`);
        delete product._preStepsAlreadyDone;
      } else {
        const analysisSite = pickSiteByRole(State.config, 'analysis');
        if (analysisSite?.preSteps?.length) {
          log(_siteLabel, `STEP 1.5: 执行 ${analysisSite.preSteps.length} 步前置操作`);
          const preResult = await executePreSteps(
            State.arenaTabId, analysisSite.preSteps, analysisSite.name || 'Arena'
          );
          if (!preResult.ok) {
            throw new Error(`前置步骤失败: ${preResult.failedStep}`);
          }
        }
      }

      // ── STEP 2-4: 通过操作步骤引擎执行 (click/upload/input/send) ──
      broadcastProgress('analysis', {
        productName: product.name, productIndex: index, total,
        stage: 'uploading', status: '分析中'
      });

      const message = buildAnalysisMessage(product, State.config);

      // 读取当前 analysis 站点配置
      const analysisSite = pickSiteByRole(State.config, 'analysis');
      const siteReplySelector = analysisSite?.replyFeatures?.selector || null;

      // 拍摄发送前快照（位置+指纹），用于精确定位新回复
      const replySnapshot = await _getReplySnapshot(State.arenaTabId, siteReplySelector);
      log('发送消息', `快照: ${replySnapshot.totalDivs}个div, 旧回复${replySnapshot.fpLen}字符`);

      const analysisSteps = Array.isArray(cfg.operationSteps) && cfg.operationSteps.length > 0
        ? cfg.operationSteps
        : [
            cfg.uploadFeatures ? { type: 'upload', features: cfg.uploadFeatures } : null,
            cfg.inputFeatures  ? { type: 'input',  features: cfg.inputFeatures  } : null,
            cfg.sendFeatures   ? { type: 'send',   features: cfg.sendFeatures   } : null
          ].filter(Boolean);

      await executeOperationSteps(State.arenaTabId, analysisSteps, {
        cfg, product, sp: null, batchIndex: 0, message, wasPreviouslySent: false
      });

      // ── STEP 5: 等待Claude回复完成 ──
      broadcastProgress('analysis', {
        productName: product.name, productIndex: index, total,
        stage: 'waiting', status: '分析中'
      });

      // per-site 回复超时 / 停滞阈值（回退到全局）
      const replyTimeoutMs = (analysisSite?.replyTimeoutMs)
        || State.config?.advancedConfig?.claudeReplyTimeout
        || TIMEOUTS.claudeReply;
      const stallTimeoutMs = Number.isFinite(analysisSite?.replyStallTimeoutMs)
        ? analysisSite.replyStallTimeoutMs
        : (State.config?.advancedConfig?.replyStallTimeout ?? 45000);

      await waitForSendButtonReady(State.arenaTabId, cfg, replyTimeoutMs, {
        replySnapshot,
        replySelector: siteReplySelector,
        copyBtnSelector: analysisSite?.copyButtonFeatures?.selector || null,
        stallTimeout: stallTimeoutMs
      });

      if (State._skipCurrent) {
        await markProductSkipped(product); return;
      }

      // ── STEP 6: 获取完整回复（只取快照之后的新回复）──
      broadcastProgress('analysis', {
        productName: product.name, productIndex: index, total,
        stage: 'extracting', status: '分析中'
      });

      // 优先通过复制按钮获取完整回复（适用于虚拟滚动网站如千问）
      const siteCopyBtnSelector = analysisSite?.copyButtonFeatures?.selector || null;
      let replyText = null;

      if (siteCopyBtnSelector) {
        replyText = await _getReplyViaCopyButton(State.arenaTabId, siteCopyBtnSelector);
      }

      // 兜底：直接 innerText 提取（适用于非虚拟滚动网站或复制按钮未配置时）
      if (!replyText) {
        replyText = await getLastReply(State.arenaTabId, replySnapshot, siteReplySelector);
      }
      if (!replyText || replyText.length < 200) {
        throw new Error(`获取到的Claude回复过短（${replyText?.length || 0}字符）`);
      }

      // 重复回复检测：与上一个成功商品的回复比对
      const replyFp = replyText.slice(0, 300) + '|' + replyText.length;
      if (_lastSuccessReplyFp && replyFp === _lastSuccessReplyFp) {
        throw new Error('获取到的回复与上一个商品的回复完全相同，可能未成功发送新消息');
      }

      product.analysisResult = replyText;
      _lastSuccessReplyFp = replyFp;
      log('获取回复', `${replyText.length}字符`);

      // ── STEP 7: 提取提示词 ──
      const extractResult = extractPrompts(replyText, State.config.extractConfig);
      product.promptText   = extractResult.promptText;
      product.imagePrompts = extractResult.prompts;

      if (extractResult.count === 0) {
        throw new Error('提示词提取结果为空，请检查提取标记配置');
      }
      log('提取提示词', `${extractResult.count}条`);

      // ── STEP 8: 保存并触发流水线B ──
      broadcastProgress('analysis', {
        productName: product.name, productIndex: index, total,
        stage: 'saving', status: '分析完成'
      });

      product.status = '分析完成';
      await saveProgress();

      broadcastToPopup({
        type: 'PRODUCT_STATUS_CHANGED',
        data: {
          index: product.index,
          status: '分析完成',
          analysisResult: product.analysisResult,
          imagePrompts:   product.imagePrompts || [],
          promptText:     product.promptText   || ''
        }
      });

      // 根据流水线模式决定是否进入生图队列
      const _pm = State.config.pipelineMode || 'both';
      if (_pm === 'both') {
        State.doubaoQueue.push({ ...product });
        if (!State.doubaoRunning) {
          runPipelineB().catch(err => {
            console.error('[Pipeline B] 致命错误:', err);
          });
        }
      } else {
        // analysis_only: 分析完成即为最终状态
        product.status = '完成';
        const sp = State.products.find(p => p.index === product.index);
        if (sp) sp.status = '完成';
        await saveProgress();
        broadcastToPopup({
          type: 'PRODUCT_STATUS_CHANGED',
          data: { index: product.index, status: '完成' }
        });
      }

      return;  // 成功，退出重试循环

    } catch (err) {
      if (err.message === 'TASK_STOPPED' || err.code === 'TASK_STOPPED') {
        log('流水线A', '任务已被用户停止');
        return;
      }
      retryCount++;
      const errMsg = err.message || String(err);
      log('流水线A错误', `商品${product.name}，第${retryCount}次，${errMsg}`);

      await writeErrorLog({
        productName: product.name,
        pipeline:    'analysis',
        stage:       'processProduct',
        errorType:   'PROCESS_ERROR',
        message:     errMsg,
        retryCount
      });

      if (retryCount > maxRetries) {
        if (recoveryAttempts >= maxRecovery) {
          // 恢复次数也用尽 → 彻底放弃
        } else {
          recoveryAttempts++;
          const isolation = State.config?.advancedConfig?.productIsolation || 'reopen';
          log('流水线A', `${product.name} 重试耗尽，恢复尝试${recoveryAttempts}/${maxRecovery}（模式=${isolation}）`);

          if (isolation === 'continue' && recoveryAttempts === 1) {
            // 模式B第1次恢复：刷新页面
            try {
              const pageState = await refreshAndDetect(State.arenaTabId);
              if (pageState === 'new') {
                log('流水线A', '刷新后为新页面，执行前置步骤');
                const site = pickSiteByRole(State.config, 'analysis');
                if (site?.preSteps?.length) {
                  await executePreSteps(State.arenaTabId, site.preSteps, site.name || 'Arena');
                }
              } else {
                log('流水线A', '刷新后为旧对话，直接重试');
              }
              retryCount = 0;
              continue;
            } catch (refreshErr) {
              log('流水线A', `刷新恢复失败: ${refreshErr.message}，升级为关闭重开`, 'error');
            }
          }

          // 模式A直接进入 / 模式B第2次恢复 / 模式B刷新失败：关闭重开
          try {
            log('流水线A', `关闭重开页面后重试: ${product.name}`);
            await reopenSiteTab('analysis');
            retryCount = 0;
            continue;
          } catch (reopenErr) {
            log('流水线A', `关闭重开失败: ${reopenErr.message}`, 'error');
          }
        }

        // 彻底放弃
        product.status       = '失败';
        product.errorMessage = errMsg;
        await saveProgress();

        const failAction = resolveFailActionByRole('analysis');

        broadcastToPopup({
          type: 'ERROR',
          pipeline: 'analysis',
          data: {
            productName: product.name,
            errorType:   'MAX_RETRY',
            message:     `处理失败（恢复后仍失败）：${errMsg}`,
            retryCount:  maxRetries,
            action:      failAction.toUpperCase()
          }
        });
        broadcastToPopup({
          type: 'PRODUCT_STATUS_CHANGED',
          data: {
            index: product.index,
            status: '失败',
            errorMessage: product.errorMessage
          }
        });

        if (failAction === 'pause') {
          State.taskPaused = true;
          broadcastToPopup({
            type: 'NEED_ACTION',
            data: { message: `商品"${product.name}"分析失败，任务已暂停。处理后点击继续。` }
          });
        } else if (failAction === 'stop') {
          State._stopSignal = true;
          State.taskRunning = false;
        }
        return;
      }

      // 常规重试间隔内刷新页面
      try {
        await chrome.tabs.reload(State.arenaTabId);
        await waitForTabLoad(State.arenaTabId, 15000);
        await sleep(3000);
      } catch { /* 刷新失败也继续 */ }

      await sleep(TIMEOUTS.retryDelay);
    }
  }
}

// ═══════════════════════════════════════════
// 流水线 B：豆包 AI 生图
// ═══════════════════════════════════════════

async function runPipelineB() {
  if (State.doubaoRunning) return;
  State.doubaoRunning = true;
  State.globalDownloadedUrls.clear();

  const isolation = State.config?.advancedConfig?.productIsolation || 'reopen';
  const _igSite = pickSiteByRole(State.config, 'imagegen');
  const _igSiteId = _igSite?.id || 'site_doubao';
  log('流水线B', `启动，隔离模式=${isolation}`);

  while (State.doubaoQueue.length > 0 && State.taskRunning && !State._stopSignal) {
    await waitWhilePaused();
    if (State._stopSignal) break;

    const product = State.doubaoQueue.shift();
    log('流水线B', `开始处理：${product.name}`);

    let success = false;
    let recoveryStage = 0; // 0=首次执行, 1=刷新后重试(模式B), 2=关闭重开后重试
    // 若上一商品 reopen 时已跑过前置步骤，本商品首次处理时直接跳过避免重复探测导致卡住
    let skipPreSteps = !!product._preStepsAlreadyDone;
    if (product._preStepsAlreadyDone) {
      log('流水线B', `上一商品 reopen 时已跑过前置步骤，本商品首次跳过`);
      delete product._preStepsAlreadyDone;
    }

    while (recoveryStage <= 2 && !success && State.taskRunning && !State._stopSignal) {
      try {
        await processOneProductInDoubao(product, { skipPreSteps });
        success = true;
      } catch (err) {
        if (err.message === 'TASK_STOPPED' || err.code === 'TASK_STOPPED') {
          State._stopSignal = true;
          break;
        }

        const sp = State.products.find(p => p.index === product.index);
        log('流水线B错误', `${product.name} (恢复阶段${recoveryStage}): ${err.message}`, 'error');

        await writeErrorLog({
          productName: product.name, pipeline: 'image',
          stage: 'processProduct', errorType: 'IMAGE_GEN_FAILED',
          message: err.message
        });

        // 重置脏状态以便重试
        // 注意：保留 _batchCompleted —— 已完成批次的图片已落盘，续跑时跳过
        // 保留 currentBatchIndex —— 指向失败那批，续跑从这里继续
        // _promptSentBatches 和 _waitBaselineByBatch 绑定的是旧会话/旧标签页，
        //   刷新或重开后全部失效，清掉让续跑重新发送
        // _referenceImagesUploaded 清掉，新标签页/新会话必须重传参考图
        if (sp) {
          delete sp._referenceImagesUploaded;
          delete sp._promptSentBatches;
          delete sp._waitBaselineByBatch;
        }

        if (recoveryStage === 0 && isolation === 'continue') {
          // 模式B首次失败 → 刷新页面
          recoveryStage = 1;
          skipPreSteps = false;
          log('流水线B', `刷新页面后重试: ${product.name}`);
          broadcastToPopup({ type: 'LOG', data: {
            time: new Date().toLocaleTimeString(), site: '生图', level: 'warn',
            message: `${product.name} 失败，刷新页面后重试`
          }});
          try {
            const pageState = await refreshAndDetect(State.doubaoTabId);
            if (pageState === 'new') {
              log('流水线B', '刷新后为新页面，需执行前置步骤+重传参考图');
              skipPreSteps = false;
              if (sp) sp._referenceImagesUploaded = false;
            } else {
              log('流水线B', '刷新后为旧对话，跳过前置步骤直接重试');
              skipPreSteps = true;
            }
            await ensureInterceptorInstalled(State.doubaoTabId, _igSiteId);
            continue;
          } catch (refreshErr) {
            log('流水线B', `刷新失败: ${refreshErr.message}，升级为关闭重开`, 'error');
          }
          // 刷新失败，直接进入关闭重开
        }

        if (recoveryStage < 2) {
          // 模式A首次失败 / 模式B刷新后仍失败 → 关闭重开
          recoveryStage = 2;
          skipPreSteps = false;
          log('流水线B', `关闭重开页面后最后重试: ${product.name}`);
          broadcastToPopup({ type: 'LOG', data: {
            time: new Date().toLocaleTimeString(), site: '生图', level: 'warn',
            message: `${product.name} 失败，关闭并重开页面后最后重试1次`
          }});
          try {
            await reopenSiteTab('imagegen');
            await ensureInterceptorInstalled(State.doubaoTabId, _igSiteId);
            if (sp) sp._referenceImagesUploaded = false;
            continue;
          } catch (reopenErr) {
            log('流水线B', `关闭重开失败: ${reopenErr.message}`, 'error');
          }
        }

        // 彻底放弃
        if (sp) {
          sp.status       = '失败';
          sp.errorMessage = (sp.errorMessage || '') + '\n生图失败: ' + err.message;
        }
        await saveProgress();

        const failAction = resolveFailActionByRole('imagegen');

        broadcastToPopup({ type: 'ERROR', pipeline: 'image', data: {
          productName: product.name, errorType: 'IMAGE_GEN_FAILED',
          message: err.message,
          action: failAction.toUpperCase()
        }});
        broadcastToPopup({ type: 'PRODUCT_STATUS_CHANGED', data: {
          index: product.index, status: '失败',
          errorMessage: sp?.errorMessage || err.message
        }});
        if (failAction === 'pause') {
          State.taskPaused = true;
          broadcastToPopup({ type: 'NEED_ACTION', data: {
            message: `商品"${product.name}"生图失败，任务已暂停。处理后点击继续。`
          }});
        } else if (failAction === 'stop') {
          State._stopSignal = true;
          State.taskRunning = false;
        }
        break;
      }
    }

    // 处理完一个商品后，为下一个商品准备环境
    const hasNext = State.doubaoQueue.length > 0 && State.taskRunning && !State._stopSignal;
    if (!hasNext) continue;

    const markNextSkipPre = () => {
      const next = State.doubaoQueue[0];
      if (next) next._preStepsAlreadyDone = true;
    };

    if (!success) {
      log('流水线B', `${product.name}失败，为下一个商品重开页面`);
      try {
        await reopenSiteTab('imagegen');
        markNextSkipPre();
      } catch (e) {
        log('流水线B', `重开页面失败: ${e.message}`, 'error');
      }
    } else if (isolation === 'reopen') {
      log('流水线B', `隔离策略=reopen，为下一个商品关闭重开豆包...`);
      await reopenSiteTab('imagegen');
      log('流水线B', `豆包重开完成，准备处理下一个商品`);
      markNextSkipPre();
    }
  }

  State.doubaoRunning = false;
  log('流水线B', '队列处理完毕');
  checkAllComplete();
}

async function processOneProductInDoubao(product, opts = {}) {
  const cfg  = State.config.doubaoConfig;
  const imagegenSite = pickSiteByRole(State.config, 'imagegen');
  const igCfg = imagegenSite?.imageGenConfig || State.config.imageGenConfig || {};

  const normPrompts = normalizeImagePromptsArray(product.imagePrompts || [], State.config.extractConfig);
  if (normPrompts !== product.imagePrompts) {
    product.imagePrompts = normPrompts;
    const spSync = State.products.find(p => p.index === product.index);
    if (spSync) spSync.imagePrompts = normPrompts;
    log('提示词', `长文本已按编号拆成 ${normPrompts.length} 条提示词`);
  }

  const prompts = product.imagePrompts;
  if (!prompts?.length) throw new Error('没有可用的生图提示词');

  // 计算批次
  let batches;
  if (igCfg.sendMode === 'all') {
    batches = [{
      index: 1, total: 1, prompts,
      startNum: 1, endNum: prompts.length,
      status: 'pending', downloadedCount: 0, retryCount: 0
    }];
  } else {
    batches = splitIntoBatches(prompts, igCfg.batchSize || 10);
  }

  // 初始化进度
  const sp = State.products.find(p => p.index === product.index);
  if (sp) {
    sp.batches           = batches;
    sp.status            = '生图中';
    sp.totalSavedCount   = sp.totalSavedCount || 0;

    // ── 断点续跑：以 _batchCompleted 为准，找第一个未完成批次 ──
    // 这样刷新/重开后能准确定位到断点，而不是从 0 重来。
    let firstIncomplete = 0;
    if (sp._batchCompleted) {
      while (firstIncomplete < batches.length && sp._batchCompleted[firstIncomplete]) {
        firstIncomplete++;
      }
    }
    sp.currentBatchIndex = firstIncomplete;

    if (firstIncomplete > 0) {
      // 早期批次已完成（图片落盘）→ 标记它们为"已发送"，跳过时不再写入
      // 注意：不再强设 _referenceImagesUploaded=true，
      //       刷新/重开后必须重新上传参考图（由 STEP 3 根据该标志自主判定）
      sp._promptSentBatches = sp._promptSentBatches || {};
      for (let j = 0; j < firstIncomplete; j++) sp._promptSentBatches[j] = true;
      log('断点续跑',
        `已完成批次 1~${firstIncomplete}，从批次 ${firstIncomplete + 1}/${batches.length} 继续`);
    }
  }
  await saveProgress();

  log('豆包', `STEP 1: 切换到标签页 tabId=${State.doubaoTabId}`);
  await switchToTab(State.doubaoTabId);
  log('豆包', `STEP 1: 等待 content script 就绪...`);
  await waitForContentScript(State.doubaoTabId);
  log('豆包', `STEP 1: content script 就绪`);

  // ── 确保 API 拦截器已安装，并重置已捕获 URL（新商品不应继承旧会话的URL） ──
  const _siteId = imagegenSite?.id || 'site_doubao';
  await ensureInterceptorInstalled(State.doubaoTabId, _siteId);
  await resetInterceptorUrls(State.doubaoTabId, _siteId);

  // ── 执行前置步骤（刷新后旧对话页面可跳过） ──
  if (!opts.skipPreSteps) {
    const imagegenSite = pickSiteByRole(State.config, 'imagegen');
    if (imagegenSite?.preSteps?.length) {
      log('豆包', `STEP 1.5: 执行 ${imagegenSite.preSteps.length} 步前置操作`);
      const preResult = await executePreSteps(
        State.doubaoTabId, imagegenSite.preSteps, imagegenSite.name || '豆包'
      );
      if (!preResult.ok) {
        throw new Error(`前置步骤失败: ${preResult.failedStep}`);
      }
    }
  } else {
    log('生图', '跳过前置步骤（旧对话/已在 reopen 中执行过）');
  }

  const startBatch = sp?.currentBatchIndex || 0;

  for (let bi = startBatch; bi < batches.length; bi++) {
    if (State._stopSignal || !State.taskRunning) break;
    await waitWhilePaused();
    if (State._stopSignal) break;

    // 已完成批次直接跳过（恢复路径下防御性检查，正常情况不会命中）
    if (sp?._batchCompleted?.[bi]) {
      log('断点续跑', `批次${bi + 1} 已完成，跳过`);
      continue;
    }

    const batch = batches[bi];
    batch.status = 'processing';

    if (sp) sp.currentBatchIndex = bi;

    let batchRetry = 0;
    while (batchRetry <= (igCfg.maxRetries || 3)) {
      try {
        await processOneBatch(product, batch, bi, batches.length, cfg, igCfg, sp, _siteId);
        break;
      } catch (err) {
        if (err.message === 'TASK_STOPPED' || err.code === 'TASK_STOPPED') {
          throw err;
        }
        // "消息未发送成功" 快失败信号：走智能恢复决策树
        if (err.code === 'MESSAGE_NOT_SENT') {
          const smartResult = await _handleMessageNotSent(
            State.doubaoTabId, cfg, product, batch, sp, bi, _siteId
          );

          if (smartResult === 'empty_input') {
            // 输入框/附件已不复存在 → 本地重试也救不了，直接冒泡到 reopen 恢复层
            log('批次失败', `批次${bi + 1}: 输入框/附件已丢失，跳过本地重试直接进刷新恢复层`, 'warn');
            throw err;
          }

          if (smartResult === 'resend_ok') {
            // 補点一次成功（豆包已进入生成状态）→ 保留 sent 标志和 baseline
            // 下一轮 processOneBatch 会幂等跳过 send，直接进 waitForNewImages
            // 这种情况不算"失败重试"，batchRetry 不累加
            log('智能恢复', `批次${bi + 1}: 补点一次后豆包已响应，继续等图`);
            await sleep(1000);
            continue;
          }

          // 'unrecoverable' / 'dialog_persist' / 'resend_click_failed' → 清脏状态走普通重试
          if (sp) {
            if (sp._promptSentBatches) delete sp._promptSentBatches[bi];
            if (sp._waitBaselineByBatch) delete sp._waitBaselineByBatch[bi];
          }
          log('批次失败',
            `批次${bi + 1}: 智能恢复未能救回（${smartResult}），已清除sent标志，下次重试将重新输入并点击发送`,
            'warn');
        }
        batchRetry++;
        log('批次失败', `批次${bi + 1}，第${batchRetry}次重试：${err.message}`);
        if (batchRetry > (igCfg.maxRetries || 3)) throw err;
        await sleep(TIMEOUTS.retryDelay);
      }
    }
  }

  // 全部批次完成
  if (sp) {
    sp.status = '完成';
    delete sp._referenceImagesUploaded;
    delete sp._promptSentBatches;
    delete sp._waitBaselineByBatch;
    delete sp._batchCompleted;
    await saveProgress();
  }

  broadcastToPopup({
    type: 'PRODUCT_STATUS_CHANGED',
    data: { index: product.index, status: '完成' }
  });

  log('流水线B', `${product.name} 全部完成`);
}

/**
 * MESSAGE_NOT_SENT 智能恢复决策树
 *
 * 判断页面当前状态，决定走哪条路：
 *   Path 1 [补点一次]：文本+附件都在 && 发送按钮可点 && 无错误弹窗
 *          → 点一次发送按钮 → 15s 内 loading=true 或拦截器有新请求 → 成功
 *   Path 2 [关弹窗再补点]：有错误弹窗 + 文本还在
 *          → 关弹窗 → 再走一次 Path 1
 *   Path 3 [升级刷新]：文本丢了 / 附件丢了 / 前两条都失败
 *          → 返回 'empty_input' 让上层跳过本地重试直接进 reopen
 *
 * @returns {Promise<'resend_ok'|'empty_input'|'dialog_persist'|'resend_click_failed'|'unrecoverable'>}
 */
async function _handleMessageNotSent(tabId, cfg, product, batch, sp, batchIndex, siteId) {
  // 发送前拦截器快照（用来判断补点后是否产生了新请求）
  const baselineIntercepted = new Set(
    sp?._waitBaselineByBatch?.[batchIndex]?.intercepted || []
  );
  const beforeDataForObserve = { intercepted: baselineIntercepted };

  // 本批消息文本头部（用来验证输入框里的内容是我们写入的）
  const expectedHead = (batch.prompts?.[0] || '').slice(0, 80);
  const expectedAttachments = product.imagesData?.length || 0;

  // 第一次状态检查
  let state = await verifyInputStateForRecovery(tabId, cfg, expectedHead);
  log('智能恢复',
    `批次${batchIndex + 1} 状态: 文本=${state.hasText ? state.textLen + '字' : '空'}` +
    `${state.textMatchesExpected ? '(匹配)' : ''}` +
    `, 附件=${state.attachmentCount}/${expectedAttachments}` +
    `, 发送按钮=${state.sendButtonEnabled ? '可点' : '禁用/缺失'}` +
    `, 错误弹窗=${state.errorDialogPresent ? '有' : '无'}`);

  // 如果有错误弹窗 → 先尝试关闭（Path 2）
  if (state.errorDialogPresent) {
    log('智能恢复', `批次${batchIndex + 1}: 检测到错误弹窗"${(state.errorDialogText || '').slice(0, 40)}"，尝试关闭`);
    await tryDismissErrorDialog(tabId);
    // 重新取一次状态
    state = await verifyInputStateForRecovery(tabId, cfg, expectedHead);
    if (state.errorDialogPresent) {
      log('智能恢复', `批次${batchIndex + 1}: 错误弹窗仍存在，放弃智能恢复`, 'warn');
      return 'dialog_persist';
    }
    log('智能恢复', `批次${batchIndex + 1}: 错误弹窗已关闭`);
  }

  // Path 3：输入框空 或 附件不够 → 必须刷新重上传
  if (!state.hasText || state.attachmentCount < Math.max(1, expectedAttachments)) {
    log('智能恢复',
      `批次${batchIndex + 1}: 输入框文本/附件已不完整（text=${state.hasText}, attach=${state.attachmentCount}/${expectedAttachments}），升级到刷新恢复`);
    return 'empty_input';
  }

  // 文本内容对不上（可能被其他东西替换了）→ 也走刷新
  if (!state.textMatchesExpected) {
    log('智能恢复', `批次${batchIndex + 1}: 输入框文本与本批提示词不匹配，升级到刷新恢复`, 'warn');
    return 'empty_input';
  }

  // 发送按钮不可点 → 可能页面异常，放弃智能恢复
  if (!state.sendButtonEnabled) {
    log('智能恢复', `批次${batchIndex + 1}: 发送按钮不可点，放弃智能恢复`, 'warn');
    return 'unrecoverable';
  }

  // ── Path 1：补点一次 ──
  log('智能恢复', `批次${batchIndex + 1}: 文本+附件齐全，尝试补点一次发送按钮`);
  const clicked = await tryResendOnce(tabId, cfg);
  if (!clicked) {
    log('智能恢复', `批次${batchIndex + 1}: 补点发送失败`, 'warn');
    return 'resend_click_failed';
  }

  // 观察 15 秒：只要页面进入 loading 或拦截器有新 CDN 请求，就视为点击生效
  const observe = await observeResendResult(tabId, cfg, beforeDataForObserve, 15000, siteId);
  if (observe.ok) {
    log('智能恢复', `批次${batchIndex + 1}: 补点生效（${observe.reason}），恢复等图流程`);
    return 'resend_ok';
  }

  log('智能恢复',
    `批次${batchIndex + 1}: 补点后 15 秒无任何反馈（${observe.reason}），升级到刷新恢复`,
    'warn');
  return 'unrecoverable';
}

async function processOneBatch(product, batch, batchIndex, totalBatches, cfg, igCfg, sp, _siteId) {
  const totalSaved = sp?.totalSavedCount || 0;

  broadcastProgress('image', {
    productName:   product.name,
    batchCurrent:  batchIndex + 1,
    batchTotal:    totalBatches,
    promptsCurrent: batch.endNum,
    promptsTotal:  product.imagePrompts.length,
    imagesSaved:   totalSaved,
    stage:         'uploading',
    status:        '生图中'
  });

  // ── STEP 3: 参考图整单只上传一次（实际由动态操作步骤中的 upload 步骤执行，
  //            上传步骤内部通过 sp._referenceImagesUploaded 去重） ──

  // ── STEP 4: 记录「发送前」URL 基准（等待新图时与此对比）
  // 重试同一批次且已发过提示词时，必须复用首次发送前的基准，否则会误判「无新图」
  let beforeData;
  if (sp?._promptSentBatches?.[batchIndex] && sp._waitBaselineByBatch?.[batchIndex]) {
    const bl = sp._waitBaselineByBatch[batchIndex];
    beforeData = {
      intercepted: new Set(bl.intercepted || []),
      dom:         new Set(bl.dom || [])
    };
    log('图片检测', `重试批次${batchIndex + 1}：复用上次发送前的URL基准（拦截器${beforeData.intercepted.size} / DOM${beforeData.dom.size}）`);
  } else {
    const [interceptedBefore, fullPageUrls, areaUrls] = await Promise.all([
      getInterceptedImageUrls(State.doubaoTabId, _siteId),
      getPageImageUrls(State.doubaoTabId, {}),
      getPageImageUrls(State.doubaoTabId, cfg)
    ]);
    beforeData = {
      intercepted: new Set(interceptedBefore),
      dom:         new Set([...fullPageUrls, ...areaUrls])
    };
    log('图片检测', `发送前已知: 拦截器=${interceptedBefore.length}, DOM全页面=${fullPageUrls.length}, DOM配置区=${areaUrls.length}`);
  }

  // ── STEP 5: 按用户自定义的「操作步骤」依次执行 upload → input → send（或其他顺序/类型）
  //            整合原来硬编码的「上传参考图 → 输入文本 → 点击发送」
  broadcastProgress('image', {
    productName:   product.name,
    batchCurrent:  batchIndex + 1, batchTotal: totalBatches,
    promptsCurrent: batch.endNum,  promptsTotal: product.imagePrompts.length,
    imagesSaved:   totalSaved, stage: 'sending', status: '生图中'
  });

  const message = buildBatchMessage(batch, product.name, igCfg);
  const wasPreviouslySent = !!sp?._promptSentBatches?.[batchIndex];
  if (wasPreviouslySent) {
    log('批次', `批次${batchIndex + 1}提示词已发送过，跳过重复输入（仅继续等待/下载）`);
  } else {
    const steps = Array.isArray(cfg.operationSteps) && cfg.operationSteps.length > 0
      ? cfg.operationSteps
      // 老配置兜底：按默认顺序 upload → input → send 合成临时步骤
      : [
          cfg.uploadFeatures ? { type: 'upload', features: cfg.uploadFeatures } : null,
          cfg.inputFeatures  ? { type: 'input',  features: cfg.inputFeatures  } : null,
          cfg.sendFeatures   ? { type: 'send',   features: cfg.sendFeatures   } : null
        ].filter(Boolean);

    await executeOperationSteps(State.doubaoTabId, steps, {
      cfg, product, sp, batchIndex, message, wasPreviouslySent: false
    });
  }

  // ── STEP 5.5: 发送后刷新基准，排除被回显的参考图 ──
  // 发送后页面会回显用户消息（含参考图），这些图不应被当作生成结果
  //
  // 注意：如果是"已发送过"的幂等路径（比如智能恢复补点后重入），跳过基准刷新。
  //       否则补点触发的 CDN 响应会被加进 baseline，导致 waitForNewImages 漏检结果图。
  if (!wasPreviouslySent) {
    await sleep(3000);
    assertTaskRunning();
    const [interceptedAfterSend, domAfterSend] = await Promise.all([
      getInterceptedImageUrls(State.doubaoTabId, _siteId),
      getPageImageUrls(State.doubaoTabId, cfg)
    ]);
    interceptedAfterSend.forEach(u => beforeData.intercepted.add(u));
    domAfterSend.forEach(u => beforeData.dom.add(u));
    log('图片检测', `发送后刷新基准: 拦截器=${beforeData.intercepted.size}, DOM=${beforeData.dom.size}`);

    if (sp) {
      sp._waitBaselineByBatch = sp._waitBaselineByBatch || {};
      sp._waitBaselineByBatch[batchIndex] = {
        intercepted: Array.from(beforeData.intercepted),
        dom:         Array.from(beforeData.dom)
      };
      await saveProgress();
    }
  } else {
    log('图片检测', `复用旧基准（智能恢复路径），不再刷新: 拦截器=${beforeData.intercepted.size}, DOM=${beforeData.dom.size}`);
  }

  // ── STEP 6: 等待本批图片生成完成 ──
  broadcastProgress('image', {
    productName:   product.name,
    batchCurrent:  batchIndex + 1, batchTotal: totalBatches,
    promptsCurrent: batch.endNum,  promptsTotal: product.imagePrompts.length,
    imagesSaved:   totalSaved, stage: 'generating', status: '生图中'
  });

  // 预期图片数: 每条提示词生成若干张（豆包通常每次4张，但无精确值时按1估）
  const expectedImgCount = (batch.prompts?.length || 1) * (igCfg.imagesPerPrompt || 1);
  const detection = await waitForNewImages(
    State.doubaoTabId, cfg, beforeData,
    igCfg.batchTimeout || TIMEOUTS.imageBatch,
    expectedImgCount,
    _siteId
  );

  let downloadUrls = detection.urls;
  const detectionSource = detection.source;

  // 全局去重：排除已下载过的URL（模式B防跨商品污染）
  if (State.globalDownloadedUrls.size > 0) {
    const beforeGlobalDedup = downloadUrls.length;
    downloadUrls = downloadUrls.filter(u => !State.globalDownloadedUrls.has(u));
    if (downloadUrls.length < beforeGlobalDedup) {
      log('图片过滤', `全局去重排除了${beforeGlobalDedup - downloadUrls.length}张已下载图片`);
    }
  }

  // 过滤掉参考图: 如果有参考图数据，排除尺寸/URL与参考图匹配的结果
  if (product.imagesData?.length > 0) {
    const refNames = new Set(product.imagesData.map(f => (f.name || '').toLowerCase()));
    const beforeDownloadCount = downloadUrls.length;
    downloadUrls = downloadUrls.filter(url => {
      const lower = url.toLowerCase();
      for (const refName of refNames) {
        if (refName && lower.includes(refName.replace(/\.[^.]+$/, ''))) return false;
      }
      return true;
    });
    if (downloadUrls.length < beforeDownloadCount) {
      log('图片过滤', `排除了${beforeDownloadCount - downloadUrls.length}张疑似参考图`);
    }
  }

  // 安全检查：数量异常多时截断
  const maxExpected = Math.max((batch.prompts?.length || 1) * 4, 20);
  if (downloadUrls.length > maxExpected) {
    log('图片检测', `检测到${downloadUrls.length}张(超过预期上限${maxExpected})，仅取最后${maxExpected}张`, 'warn');
    downloadUrls = downloadUrls.slice(-maxExpected);
  }

  // ── STEP 7: 下载 ──
  // 拦截器返回的已是无水印原图URL，可直接下载
  // DOM扫描返回的是缩略图URL，需要先解析为原图
  if (detectionSource === 'dom') {
    // 先尝试拦截器映射，再回退到CDN模式推导
    const mapped = await resolveViaInterceptor(State.doubaoTabId, downloadUrls, _siteId);
    if (mapped) {
      const changedCount = mapped.filter((u, i) => u !== downloadUrls[i]).length;
      if (changedCount > 0) log('图片检测', `通过拦截器映射了${changedCount}个缩略图→原图`);
      downloadUrls = mapped;
    } else {
      downloadUrls = await resolveOriginalUrls(State.doubaoTabId, downloadUrls);
    }
  }
  log('图片检测', `来源=${detectionSource}, 共${downloadUrls.length}张待下载`);

  broadcastProgress('image', {
    productName:   product.name,
    batchCurrent:  batchIndex + 1, batchTotal: totalBatches,
    promptsCurrent: batch.endNum,  promptsTotal: product.imagePrompts.length,
    imagesSaved:   totalSaved, stage: 'downloading', status: '生图中'
  });

  let savedCount = 0;

  for (let i = 0; i < downloadUrls.length; i++) {
    assertTaskRunning();
    const url       = downloadUrls[i];
    const fileIndex = (sp?.totalSavedCount || 0) + i + 1;
    const ext       = guessImageExt(url);
    const filename  = `gen_${String(fileIndex).padStart(3, '0')}.${ext}`;
    // 路径层级: 生图结果_<任务时间戳>/<商品文件夹名>/AI生成/gen_XXX.ext
    // 任务时间戳兜底：极端情况下若未初始化，退化为当天日期
    const taskTag = State.taskFolderTag
      || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const safeFolderName = (product.folderName || 'unknown')
      .replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
    const savePath  = `生图结果_${taskTag}/${safeFolderName}/AI生成/${filename}`;

    let downloadUrl = null;
    try {
      if (url.startsWith('blob:') || url.startsWith('data:')) {
        const dataUrl = await convertToDataUrl(State.doubaoTabId, url);
        if (!dataUrl) {
          log('下载失败', `无法转换 blob/data URL: ${url.substring(0, 80)}`);
          continue;
        }
        downloadUrl = dataUrl;
      } else {
        downloadUrl = url;
      }

      // 关键：把 URL→目标路径 登记进映射表，onDeterminingFilename 监听器会据此强制落盘
      State.pendingDownloadPaths.set(downloadUrl, savePath);

      await chrome.downloads.download({
        url:            downloadUrl,
        filename:       savePath,
        saveAs:         false,
        conflictAction: 'uniquify'
      });

      if (sp) sp.savedImages = sp.savedImages || [];
      if (sp) sp.savedImages.push(filename);
      State.globalDownloadedUrls.add(url);
      savedCount++;
      if (savedCount === 1) {
        log('下载路径', `保存至子文件夹: 生图结果_${taskTag}/${safeFolderName}/AI生成/`);
      }
      log('下载', `${filename} (${url.substring(0, 100)}...)`);
    } catch (err) {
      // 发生异常时及时清理映射，避免内存泄漏和错配
      if (downloadUrl) State.pendingDownloadPaths.delete(downloadUrl);
      log('下载失败', `${url.substring(0, 120)}: ${err.message}`);
    }

    await sleep(300);
  }

  if (!detection.urls.length) {
    log('图片检测', '未检测到新图片，可能原因：1)图片区域选择器未包含生成结果 2)图片格式不支持 3)生成超时', 'warn');
  }

  // ── 批次完成度阈值判定 ──
  // 规则：本批下载成功数 >= 预期数 × 50% 视为成功
  // 例：10条提示词，保存8张 → 80% ≥ 50% → 判定为成功（个别失败不触发整批重试）
  // 低于 50% 则抛错，上层据此进入批次重试 / 刷新续跑
  const expectedForBatch = (batch.prompts?.length || 1) * (igCfg.imagesPerPrompt || 1);
  const minAcceptable    = Math.max(1, Math.ceil(expectedForBatch * 0.5));

  if (sp) {
    sp.totalSavedCount = (sp.totalSavedCount || 0) + savedCount;
    batch.downloadedCount = savedCount;
    if (sp._waitBaselineByBatch) {
      delete sp._waitBaselineByBatch[batchIndex];
    }
  }

  if (savedCount < minAcceptable) {
    if (sp) {
      batch.status = 'failed';
      // 把本批 sent 标志清掉，续跑时会重新发送提示词
      if (sp._promptSentBatches) delete sp._promptSentBatches[batchIndex];
    }
    await saveProgress();
    throw new Error(
      `批次${batchIndex + 1}完成度不足：保存 ${savedCount}/${expectedForBatch} 张 (阈值 ${minAcceptable})`
    );
  }

  if (sp) {
    batch.status = 'done';
    sp._batchCompleted = sp._batchCompleted || {};
    sp._batchCompleted[batchIndex] = true;
  }

  await saveProgress();

  broadcastProgress('image', {
    productName:   product.name,
    batchCurrent:  batchIndex + 1, batchTotal: totalBatches,
    promptsCurrent: batch.endNum,  promptsTotal: product.imagePrompts.length,
    imagesSaved:   sp?.totalSavedCount || 0,
    stage:         'done', status: '生图中'
  });

  const pctInfo = expectedForBatch > 1
    ? ` (${savedCount}/${expectedForBatch}, ${Math.round(savedCount * 100 / expectedForBatch)}%)`
    : '';
  log('批次完成', `批次${batchIndex + 1}/${totalBatches}，本批保存${savedCount}张${pctInfo}`);
}

// ═══════════════════════════════════════════
// 页面操作函数（通过 scripting.executeScript）
// ═══════════════════════════════════════════

/**
 * 向页面发送消息（填入文字 + 点击发送）
 */
// CDP (Chrome DevTools Protocol) 方式写入 contenteditable，模拟真实键盘输入
async function fillViaCDP(tabId, text, siteConfig) {
  const expectedLen = text.length;

  // 写入前先确保输入框有焦点（通过注入脚本 click + focus）
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (inputFeatures) => {
      const sels = [
        inputFeatures?.selector,
        ...(inputFeatures?.candidateSelectors || []),
        'textarea', '[contenteditable="true"]', 'input'
      ].filter(Boolean);
      for (const sel of sels) {
        try {
          const el = document.querySelector(sel);
          if (el && el.getBoundingClientRect().width > 0) {
            el.click();
            el.focus();
            return;
          }
        } catch {}
      }
    },
    args: [siteConfig.inputFeatures]
  });
  await sleep(100);

  let debuggerAttached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerAttached = true;
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
    log('CDP写入', `已通过 Input.insertText 写入 ${expectedLen} 字符`);
  } catch (cdpErr) {
    log('CDP写入', `CDP 失败: ${cdpErr.message}，回退到 execCommand`, 'warn');
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (text) => {
        const el = document.activeElement;
        if (el) {
          el.focus();
          document.execCommand('insertText', false, text);
        }
      },
      args: [text]
    });
  } finally {
    if (debuggerAttached) {
      try { await chrome.debugger.detach({ tabId }); } catch {}
    }
  }

  await sleep(300);

  // 严格验证：检查实际长度与预期长度的比例
  const verifyResult = await chrome.scripting.executeScript({
    target: { tabId },
    func: (inputFeatures) => {
      // 优先从焦点元素读取，兜底从选择器读取
      const readLen = (el) => {
        if (!el) return 0;
        const tag = el.tagName?.toUpperCase();
        const content = (tag === 'TEXTAREA' || tag === 'INPUT')
          ? (el.value || '').trim()
          : (el.innerText || el.textContent || '').trim();
        return content.length;
      };

      let len = readLen(document.activeElement);

      if (len < 50) {
        const sels = [
          inputFeatures?.selector,
          ...(inputFeatures?.candidateSelectors || []),
          'textarea'
        ].filter(Boolean);
        for (const sel of sels) {
          try {
            const el = document.querySelector(sel);
            if (el) {
              const l = readLen(el);
              if (l > len) len = l;
            }
          } catch {}
        }
      }

      return { length: len };
    },
    args: [siteConfig.inputFeatures]
  });

  const actualLen = verifyResult[0]?.result?.length || 0;
  const ratio = expectedLen > 0 ? actualLen / expectedLen : 0;

  if (ratio >= 0.5) {
    log('CDP写入', `验证成功 (len=${actualLen})`);
  } else {
    throw new Error(
      `输入框写入验证失败：预期${expectedLen}字符，实际检测到${actualLen}字符（${Math.round(ratio * 100)}%）。输入框可能未获得焦点`
    );
  }
}

// 脚本方式写入 textarea/input（React nativeSetter）
async function fillViaScript(tabId, text, siteConfig) {
  const fillResult = await chrome.scripting.executeScript({
    target: { tabId },
    func: (text, inputFeatures) => {
      const el = document.activeElement;
      if (!el || el === document.body) return { ok: false, error: '输入框丢失焦点' };

      const nativeTASetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value'
      )?.set;
      const nativeISetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, 'value'
      )?.set;
      const tag = el.tagName.toUpperCase();

      if (tag === 'TEXTAREA' && nativeTASetter) {
        nativeTASetter.call(el, text);
      } else if (tag === 'INPUT' && nativeISetter) {
        nativeISetter.call(el, text);
      } else {
        el.value = text;
      }
      ['input', 'change'].forEach(evType => {
        el.dispatchEvent(new Event(evType, { bubbles: true }));
      });

      const current = (el.value || '').trim();
      if (!current) return { ok: false, error: '输入框写入失败' };
      return { ok: true, length: current.length };
    },
    args: [text, siteConfig.inputFeatures]
  });

  const fillR = fillResult[0]?.result;
  if (!fillR?.ok) throw new Error(fillR?.error || '输入框写入失败');
  log('脚本写入', `成功 (len=${fillR.length})`);
}

async function sendMessageToPage(tabId, text, siteConfig) {
  assertTaskRunning();
  // ── Step 1: 找到输入框并聚焦 + 清空已有内容 ──
  const focusResult = await chrome.scripting.executeScript({
    target: { tabId },
    func: (inputFeatures) => {
      const findEl = (features, intent) => {
        if (!features) return null;
        const selectors = [
          features.selector,
          ...(features.candidateSelectors || []),
          features.attrs?.id ? `#${features.attrs.id}` : null,
          features.attrs?.ariaLabel ? `[aria-label="${features.attrs.ariaLabel}"]` : null,
          features.attrs?.placeholder ? `[placeholder="${features.attrs.placeholder}"]` : null,
          features.attrs?.dataTestId ? `[data-testid="${features.attrs.dataTestId}"]` : null,
          features.attrs?.name ? `[name="${features.attrs.name}"]` : null
        ].filter(Boolean);
        const pool = new Set();
        selectors.forEach(sel => {
          try { document.querySelectorAll(sel).forEach(el => pool.add(el)); } catch {}
        });
        document.querySelectorAll('textarea,input,[contenteditable="true"]').forEach(el => pool.add(el));

        const score = (el) => {
          let s = 0;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) s += 10;
          selectors.forEach((sel, idx) => {
            try { if (el.matches(sel)) s += idx === 0 ? 30 : 14; } catch {}
          });
          if (features.tag && el.tagName.toLowerCase() === features.tag) s += 8;
          if (features.attrs?.id && el.id === features.attrs.id) s += 22;
          if (features.attrs?.dataTestId && el.getAttribute('data-testid') === features.attrs.dataTestId) s += 18;
          if (features.attrs?.ariaLabel && el.getAttribute('aria-label') === features.attrs.ariaLabel) s += 16;
          if (features.attrs?.placeholder && el.getAttribute('placeholder') === features.attrs.placeholder) s += 12;
          if (intent === 'input') {
            const type = (el.getAttribute('type') || '').toLowerCase();
            if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && type !== 'file') || el.hasAttribute('contenteditable')) s += 14;
            else s -= 8;
          }
          return s;
        };

        let best = null;
        let bestScore = -1;
        pool.forEach(el => {
          const s = score(el);
          if (s > bestScore) { best = el; bestScore = s; }
        });
        return bestScore >= 20 ? best : null;
      };

      const inputEl = findEl(inputFeatures, 'input');
      if (!inputEl) return { ok: false, error: '找不到输入框元素' };

      const tag = inputEl.tagName.toUpperCase();
      const isContentEditable = inputEl.isContentEditable ||
        inputEl.hasAttribute('contenteditable') ||
        (tag !== 'TEXTAREA' && tag !== 'INPUT');

      inputEl.focus();

      // 清空已有内容
      if (isContentEditable) {
        if ((inputEl.innerText || '').trim()) {
          document.execCommand('selectAll');
          document.execCommand('delete');
        }
      } else {
        inputEl.select();
        document.execCommand('delete');
      }

      return { ok: true, isContentEditable, tag };
    },
    args: [siteConfig.inputFeatures]
  });

  const focusR = focusResult[0]?.result;
  if (!focusR?.ok) throw new Error(focusR?.error || '找不到输入框');

  await sleep(150);

  // ── Step 2: 写入文字（统一优先使用 CDP，兜底 nativeSetter）──
  let cdpWriteOk = false;
  for (let cdpAttempt = 0; cdpAttempt < 2 && !cdpWriteOk; cdpAttempt++) {
    try {
      if (cdpAttempt > 0) {
        log('文本输入', `CDP 第${cdpAttempt + 1}次尝试：重新聚焦输入框`);
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (inputFeatures) => {
            const sels = [
              inputFeatures?.selector,
              ...(inputFeatures?.candidateSelectors || []),
              'textarea', '[contenteditable="true"]'
            ].filter(Boolean);
            for (const sel of sels) {
              try {
                const el = document.querySelector(sel);
                if (el && el.getBoundingClientRect().width > 0) {
                  el.click();
                  el.focus();
                  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                    el.select();
                    document.execCommand('delete');
                  } else {
                    document.execCommand('selectAll');
                    document.execCommand('delete');
                  }
                  return;
                }
              } catch {}
            }
          },
          args: [siteConfig.inputFeatures]
        });
        await sleep(300);
      }
      await fillViaCDP(tabId, text, siteConfig);
      cdpWriteOk = true;
    } catch (cdpFillErr) {
      if (cdpAttempt === 0) {
        log('文本输入', `CDP 首次失败: ${cdpFillErr.message}，将重试`, 'warn');
      } else {
        log('文本输入', `CDP 第2次失败: ${cdpFillErr.message}，回退到脚本写入`, 'warn');
        if (!focusR.isContentEditable) {
          await fillViaScript(tabId, text, siteConfig);
        } else {
          throw cdpFillErr;
        }
      }
    }
  }

  // Step2: 等待500ms
  await sleep(500);

  // Step3: 点击发送按钮
  const clickResult = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sendFeatures) => {
      const pick = (features) => {
        if (!features) return null;
        const selectors = [
          features.selector,
          ...(features.candidateSelectors || []),
          features.attrs?.id ? `#${features.attrs.id}` : null,
          features.attrs?.ariaLabel ? `[aria-label="${features.attrs.ariaLabel}"]` : null,
          features.attrs?.dataTestId ? `[data-testid="${features.attrs.dataTestId}"]` : null,
          'button[type="submit"]',
          'button'
        ].filter(Boolean);
        const pool = new Set();
        selectors.forEach(sel => {
          try { document.querySelectorAll(sel).forEach(el => pool.add(el)); } catch {}
        });
        let best = null;
        let bestScore = -1;
        pool.forEach(el => {
          let s = 0;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) s += 8;
          selectors.forEach((sel, idx) => {
            try { if (el.matches(sel)) s += idx === 0 ? 28 : 12; } catch {}
          });
          const txt = `${el.innerText || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
          if (txt.includes('发送') || txt.includes('send') || txt.includes('submit')) s += 12;
          if (features.tag && el.tagName.toLowerCase() === features.tag) s += 8;
          if (s > bestScore) { best = el; bestScore = s; }
        });
        return bestScore >= 18 ? best : null;
      };

      const sendEl = pick(sendFeatures);

      if (!sendEl) return { ok: false, error: '找不到发送按钮' };
      if (sendEl.disabled || sendEl.getAttribute('aria-disabled') === 'true') {
        return { ok: false, error: '发送按钮处于禁用状态' };
      }

      sendEl.click();
      return { ok: true };
    },
    args: [siteConfig.sendFeatures]
  });

  const clickR = clickResult[0]?.result;
  if (!clickR?.ok) {
    // 发送按钮可能因为图片仍在加载等原因被暂时禁用，等待后重试
    if (clickR?.error?.includes('禁用')) {
      log('发送', '发送按钮暂时禁用，等待后重试...');
      await waitForSendButtonReady(tabId, siteConfig, 15000, { skipGeneratingCheck: true });
      const retry = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sendFeatures) => {
          const sels = [
            sendFeatures?.selector,
            ...(sendFeatures?.candidateSelectors || []),
            'button[type="submit"]', 'button'
          ].filter(Boolean);
          for (const sel of sels) {
            try {
              const btn = document.querySelector(sel);
              if (btn && !btn.disabled && btn.getBoundingClientRect().width > 0) {
                btn.click();
                return { ok: true };
              }
            } catch {}
          }
          return { ok: false, error: '重试仍找不到可用发送按钮' };
        },
        args: [siteConfig.sendFeatures]
      });
      const retryR = retry[0]?.result;
      if (!retryR?.ok) throw new Error(retryR?.error || '点击发送按钮失败（重试后）');
    } else {
      throw new Error(clickR?.error || '点击发送按钮失败');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// 操作步骤执行引擎（动态步骤：upload/input/send/click/wait/waitForElement/delete）
// 仅在生图流水线（processOneBatch）调用；Arena 分析流水线仍走老 sendMessageToPage
// ═══════════════════════════════════════════════════════════════════

/** 聚焦输入框并写入文本（不点击发送），从 sendMessageToPage 中的 Step1+Step2 提取 */
async function focusAndWriteText(tabId, text, inputFeatures) {
  assertTaskRunning();
  const siteConfig = { inputFeatures };

  const focusResult = await chrome.scripting.executeScript({
    target: { tabId },
    func: (inputFeatures) => {
      const findEl = (features, intent) => {
        if (!features) return null;
        const selectors = [
          features.selector,
          ...(features.candidateSelectors || []),
          features.attrs?.id ? `#${features.attrs.id}` : null,
          features.attrs?.ariaLabel ? `[aria-label="${features.attrs.ariaLabel}"]` : null,
          features.attrs?.placeholder ? `[placeholder="${features.attrs.placeholder}"]` : null,
          features.attrs?.dataTestId ? `[data-testid="${features.attrs.dataTestId}"]` : null,
          features.attrs?.name ? `[name="${features.attrs.name}"]` : null
        ].filter(Boolean);
        const pool = new Set();
        selectors.forEach(sel => {
          try { document.querySelectorAll(sel).forEach(el => pool.add(el)); } catch {}
        });
        document.querySelectorAll('textarea,input,[contenteditable="true"]').forEach(el => pool.add(el));
        const score = (el) => {
          let s = 0;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) s += 10;
          selectors.forEach((sel, idx) => {
            try { if (el.matches(sel)) s += idx === 0 ? 30 : 14; } catch {}
          });
          if (features.tag && el.tagName.toLowerCase() === features.tag) s += 8;
          if (features.attrs?.id && el.id === features.attrs.id) s += 22;
          if (features.attrs?.dataTestId && el.getAttribute('data-testid') === features.attrs.dataTestId) s += 18;
          if (features.attrs?.ariaLabel && el.getAttribute('aria-label') === features.attrs.ariaLabel) s += 16;
          if (features.attrs?.placeholder && el.getAttribute('placeholder') === features.attrs.placeholder) s += 12;
          if (intent === 'input') {
            const type = (el.getAttribute('type') || '').toLowerCase();
            if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && type !== 'file') || el.hasAttribute('contenteditable')) s += 14;
            else s -= 8;
          }
          return s;
        };
        let best = null, bestScore = -1;
        pool.forEach(el => { const s = score(el); if (s > bestScore) { best = el; bestScore = s; } });
        return bestScore >= 20 ? best : null;
      };
      const inputEl = findEl(inputFeatures, 'input');
      if (!inputEl) return { ok: false, error: '找不到输入框元素' };
      const tag = inputEl.tagName.toUpperCase();
      const isContentEditable = inputEl.isContentEditable ||
        inputEl.hasAttribute('contenteditable') ||
        (tag !== 'TEXTAREA' && tag !== 'INPUT');
      inputEl.focus();
      if (isContentEditable) {
        if ((inputEl.innerText || '').trim()) {
          document.execCommand('selectAll');
          document.execCommand('delete');
        }
      } else {
        inputEl.select();
        document.execCommand('delete');
      }
      return { ok: true, isContentEditable, tag };
    },
    args: [inputFeatures]
  });

  const focusR = focusResult[0]?.result;
  if (!focusR?.ok) throw new Error(focusR?.error || '找不到输入框');

  await sleep(150);

  let cdpWriteOk = false;
  for (let cdpAttempt = 0; cdpAttempt < 2 && !cdpWriteOk; cdpAttempt++) {
    try {
      if (cdpAttempt > 0) {
        log('文本输入', `CDP 第${cdpAttempt + 1}次尝试：重新聚焦输入框`);
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (inputFeatures) => {
            const sels = [
              inputFeatures?.selector,
              ...(inputFeatures?.candidateSelectors || []),
              'textarea', '[contenteditable="true"]'
            ].filter(Boolean);
            for (const sel of sels) {
              try {
                const el = document.querySelector(sel);
                if (el && el.getBoundingClientRect().width > 0) {
                  el.click(); el.focus();
                  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                    el.select(); document.execCommand('delete');
                  } else {
                    document.execCommand('selectAll'); document.execCommand('delete');
                  }
                  return;
                }
              } catch {}
            }
          },
          args: [inputFeatures]
        });
        await sleep(300);
      }
      await fillViaCDP(tabId, text, siteConfig);
      cdpWriteOk = true;
    } catch (cdpFillErr) {
      if (cdpAttempt === 0) {
        log('文本输入', `CDP 首次失败: ${cdpFillErr.message}，将重试`, 'warn');
      } else {
        log('文本输入', `CDP 第2次失败: ${cdpFillErr.message}，回退到脚本写入`, 'warn');
        if (!focusR.isContentEditable) {
          await fillViaScript(tabId, text, siteConfig);
        } else {
          throw cdpFillErr;
        }
      }
    }
  }
  await sleep(500);
}

/** 仅点击发送按钮（不负责输入文字） */
async function clickSendButtonOnly(tabId, sendFeatures) {
  assertTaskRunning();
  const clickResult = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sendFeatures) => {
      const pick = (features) => {
        if (!features) return null;
        const selectors = [
          features.selector,
          ...(features.candidateSelectors || []),
          features.attrs?.id ? `#${features.attrs.id}` : null,
          features.attrs?.ariaLabel ? `[aria-label="${features.attrs.ariaLabel}"]` : null,
          features.attrs?.dataTestId ? `[data-testid="${features.attrs.dataTestId}"]` : null,
          'button[type="submit"]', 'button'
        ].filter(Boolean);
        const pool = new Set();
        selectors.forEach(sel => {
          try { document.querySelectorAll(sel).forEach(el => pool.add(el)); } catch {}
        });
        let best = null, bestScore = -1;
        pool.forEach(el => {
          let s = 0;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) s += 8;
          selectors.forEach((sel, idx) => {
            try { if (el.matches(sel)) s += idx === 0 ? 28 : 12; } catch {}
          });
          const txt = `${el.innerText || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
          if (txt.includes('发送') || txt.includes('send') || txt.includes('submit')) s += 12;
          if (features.tag && el.tagName.toLowerCase() === features.tag) s += 8;
          if (s > bestScore) { best = el; bestScore = s; }
        });
        return bestScore >= 18 ? best : null;
      };
      const sendEl = pick(sendFeatures);
      if (!sendEl) return { ok: false, error: '找不到发送按钮' };
      if (sendEl.disabled || sendEl.getAttribute('aria-disabled') === 'true') {
        return { ok: false, error: '发送按钮处于禁用状态' };
      }
      sendEl.click();
      return { ok: true };
    },
    args: [sendFeatures]
  });
  const clickR = clickResult[0]?.result;
  if (!clickR?.ok) throw new Error(clickR?.error || '点击发送按钮失败');
}

/** 通用点击：根据 features 找到元素并 click */
async function clickGenericElement(tabId, features, label = '元素', maxRetries = 3) {
  assertTaskRunning();
  const _tryClick = async () => {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: (features) => {
        if (!features) return { ok: false, error: '未提供特征' };
        const selectors = [
          features.selector,
          ...(features.candidateSelectors || []),
          features.attrs?.id ? `#${features.attrs.id}` : null,
          features.attrs?.ariaLabel ? `[aria-label="${features.attrs.ariaLabel}"]` : null,
          features.attrs?.dataTestId ? `[data-testid="${features.attrs.dataTestId}"]` : null
        ].filter(Boolean);
        for (const sel of selectors) {
          try {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0 && !el.disabled) {
                el.click();
                return { ok: true };
              }
            }
          } catch {}
        }
        return { ok: false, error: '找不到可点击的元素' };
      },
      args: [features]
    });
    return r[0]?.result;
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    assertTaskRunning();
    const res = await _tryClick();
    if (res?.ok) return;
    if (attempt < maxRetries) {
      log('步骤执行', `${label} 未找到(第${attempt}次)，等待2秒后重试...`, 'warn');
      await sleep(2000);
    } else {
      throw new Error(`${label}：${res?.error || '点击失败'}`);
    }
  }
}

/** 轮询等待某元素 出现 / 消失 */
async function waitForElementCondition(tabId, features, condition, timeout) {
  assertTaskRunning();
  const start = Date.now();
  const POLL = 500;
  const isAppear = condition !== 'disappear';
  while (Date.now() - start < timeout) {
    assertTaskRunning();
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: (features) => {
        if (!features) return { visible: false };
        const selectors = [
          features.selector,
          ...(features.candidateSelectors || []),
          features.attrs?.id ? `#${features.attrs.id}` : null,
          features.attrs?.ariaLabel ? `[aria-label="${features.attrs.ariaLabel}"]` : null
        ].filter(Boolean);
        for (const sel of selectors) {
          try {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
              const rect = el.getBoundingClientRect();
              const st = getComputedStyle(el);
              if (rect.width > 0 && rect.height > 0 && st.display !== 'none' && st.visibility !== 'hidden') {
                return { visible: true };
              }
            }
          } catch {}
        }
        return { visible: false };
      },
      args: [features]
    });
    const visible = !!r[0]?.result?.visible;
    if (isAppear && visible) return true;
    if (!isAppear && !visible) return true;
    await sleep(POLL);
  }
  throw new Error(`等待元素${isAppear ? '出现' : '消失'}超时（${Math.round(timeout / 1000)}秒）`);
}

/**
 * 按顺序执行操作步骤列表
 * @param {number} tabId
 * @param {Array} steps  操作步骤数组
 * @param {Object} ctx   { cfg, product, sp, batchIndex, message, wasPreviouslySent, hooks }
 *   hooks: { beforeSend?: async () => void }
 * 约定：
 *   - 如果 ctx.wasPreviouslySent===true，则跳过 upload/input/send/click/delete 等写入类动作，
 *     仍执行 wait / waitForElement（用于等待响应）
 *   - upload 步骤内部通过 sp._referenceImagesUploaded 去重，整单只真正上传一次
 *   - send 步骤成功后会置位 sp._promptSentBatches[batchIndex]=true
 */
async function executeOperationSteps(tabId, steps, ctx) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('操作步骤为空：请在设置中为该网站配置「操作步骤」');
  }
  const { cfg, product, sp, batchIndex, message, wasPreviouslySent, hooks = {} } = ctx;

  for (const step of steps) {
    await waitWhilePaused();
    assertTaskRunning();
    const def = step.type;
    const isPassive = def === 'wait' || def === 'waitForElement';
    if (wasPreviouslySent && !isPassive) continue;

    switch (def) {
      case 'upload': {
        if (!product?.imagesData?.length) {
          log('步骤执行', `upload 步骤：无参考图可上传，跳过`);
          break;
        }
        if (sp && sp._referenceImagesUploaded) {
          log('步骤执行', `upload 步骤：整单已上传过，跳过`);
          break;
        }
        const stepCfg  = { ...cfg, uploadFeatures: step.features || cfg.uploadFeatures };
        const uploader = new BgUploader(stepCfg, tabId);
        const result   = await uploader.uploadAndVerify(product.imagesData);
        if (!result.success) {
          throw new Error(`图片上传失败：${result.successCount}/${product.imagesData.length}张`);
        }
        if (sp) {
          sp._referenceImagesUploaded = true;
          await saveProgress();
        }
        log('参考图', '等待参考图在页面上加载完成...');
        let uploadReady = await waitForUploadSettled(tabId, stepCfg, 60000);
        if (!uploadReady) {
          log('参考图', '首次等待超时(60秒)，再等30秒...', 'warn');
          uploadReady = await waitForUploadSettled(tabId, stepCfg, 30000);
        }
        if (!uploadReady) {
          throw new Error('参考图上传超时：页面90秒内仍未就绪，请检查网络或手动刷新页面后重试');
        }
        log('参考图', '参考图加载完成，页面就绪');
        break;
      }

      case 'input': {
        if (!message) throw new Error('input 步骤：未收到待输入文本');
        const feat = step.features || cfg.inputFeatures;
        if (!feat) throw new Error('input 步骤：未配置输入框元素');
        await focusAndWriteText(tabId, message, feat);
        break;
      }

      case 'send': {
        const feat = step.features || cfg.sendFeatures;
        if (!feat) throw new Error('send 步骤：未配置发送按钮元素');
        const sendReadyTimeout = batchIndex > 0 ? 30000 : TIMEOUTS.buttonReady;
        log('批次', `等待发送按钮就绪(${sendReadyTimeout / 1000}秒)...`);
        const sendCfg = { ...cfg, sendFeatures: feat };
        try {
          await waitForSendButtonReady(tabId, sendCfg, sendReadyTimeout);
        } catch (e) {
          if (e.code === 'TASK_STOPPED') throw e;
          log('批次', `发送按钮等待超时，仍继续尝试发送: ${e.message}`, 'warn');
        }
        if (hooks.beforeSend) {
          try { await hooks.beforeSend(); }
          catch (e) { log('步骤执行', `beforeSend hook 失败: ${e.message}`, 'warn'); }
        }
        try {
          await clickSendButtonOnly(tabId, feat);
        } catch (e) {
          // 发送按钮可能被短暂禁用，等待后重试一次
          if (/禁用/.test(e.message)) {
            log('发送', '发送按钮暂时禁用，等待后重试...');
            await waitForSendButtonReady(tabId, sendCfg, 15000, { skipGeneratingCheck: true });
            await clickSendButtonOnly(tabId, feat);
          } else {
            throw e;
          }
        }
        if (sp) {
          if (!sp._promptSentBatches) sp._promptSentBatches = {};
          sp._promptSentBatches[batchIndex] = true;
        }
        break;
      }

      case 'click':
      case 'delete': {
        const feat = step.features;
        if (!feat) {
          log('步骤执行', `${def} 步骤未配置元素，跳过`, 'warn');
          break;
        }
        if (def === 'click' && step.skipIfPressed) {
          const probeR = await chrome.scripting.executeScript({
            target: { tabId },
            func: (features) => {
              const selectors = [
                features.selector,
                ...(features.candidateSelectors || []),
                features.attrs?.ariaLabel ? `[aria-label="${features.attrs.ariaLabel}"]` : null
              ].filter(Boolean);
              for (const sel of selectors) {
                try {
                  for (const el of document.querySelectorAll(sel)) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                      return { found: true, pressed: el.getAttribute('aria-pressed') === 'true' };
                    }
                  }
                } catch {}
              }
              return { found: false, pressed: false };
            },
            args: [feat]
          });
          const probe = probeR[0]?.result;
          if (probe?.found && probe.pressed) {
            log('步骤执行', `${step.label || '点击'} 已处于激活状态(aria-pressed)，跳过`);
            break;
          }
        }
        await clickGenericElement(tabId, feat, step.label || def);
        log('步骤执行', `${step.label || def} 已点击`);
        break;
      }

      case 'wait': {
        const ms = Math.max(0, step.duration || 0);
        if (ms > 0) {
          log('步骤执行', `等待 ${Math.round(ms / 1000)} 秒...`);
          await sleep(ms);
        }
        break;
      }

      case 'waitForElement': {
        const feat = step.features;
        if (!feat) {
          log('步骤执行', `waitForElement 步骤未配置元素，跳过`, 'warn');
          break;
        }
        const cond = step.condition || 'appear';
        const to   = step.timeout || 30000;
        log('步骤执行', `等待元素${cond === 'disappear' ? '消失' : '出现'}（最多 ${Math.round(to / 1000)} 秒）...`);
        await waitForElementCondition(tabId, feat, cond, to);
        break;
      }

      default:
        log('步骤执行', `未知步骤类型「${def}」，跳过`, 'warn');
    }
  }
}

/**
 * 等待发送按钮重新可用（表示AI回复完成）
 * 同时检测页面上的"AI正在生成"指示器，避免在生成中误判为完成
 */
async function waitForSendButtonReady(tabId, siteConfig, timeout, opts = {}) {
  const {
    skipGeneratingCheck = false,
    replySnapshot = null,
    replySelector = null,
    copyBtnSelector = null, // 站点配置的"复制按钮"选择器；可见即视为完成（最高优先级信号）
    stallTimeout = 0        // 回复文本连续 N 毫秒无增长 + 按钮未就绪 → 提前判失败（0 = 关闭）
  } = opts;
  const startTime = Date.now();
  let lastReplyLen = -1;
  let lastChangeAt = Date.now();
  let loggedStallWarn = false;

  return new Promise((resolve, reject) => {
    const check = async () => {
      if (State._stopSignal || !State.taskRunning) {
        reject(Object.assign(new Error('TASK_STOPPED'), { code: 'TASK_STOPPED' }));
        return;
      }
      if (Date.now() - startTime > timeout) {
        reject(new Error('等待AI回复完成超时'));
        return;
      }

      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (sendFeatures, checkGenerating, snap, replySel, copyBtnSel) => {
            let isGenerating = false;
            let generatingHint = '';
            let currentReplyLen = -1;    // 当前最新非用户气泡的文本长度（用于稳定性 + 停滞检测）

            // ── 始终先采样最新非用户气泡的文本长度（无论 isGenerating 与否，都需要跟踪）──
            const divs = Array.from(document.querySelectorAll(replySel || 'ol > div'));
            for (let i = divs.length - 1; i >= 0; i--) {
              const el = divs[i];
              if (el.className?.includes('justify-end')) continue;
              const text = (el.innerText || el.textContent || '').trim();
              currentReplyLen = text.length;
              break;
            }

            // ── 优先级最高：复制按钮可见 = AI 真正完成 ──
            // 仅当用户配置了 copyBtnSel 时启用（如千问），其他站点跳过
            if (copyBtnSel) {
              try {
                const copyBtns = document.querySelectorAll(copyBtnSel);
                for (const btn of copyBtns) {
                  const rect = btn.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    return { ready: true, generating: false, hint: 'copy-btn-visible', currentReplyLen };
                  }
                }
              } catch (_) {}
            }

            // ── 检测"AI 正在生成"指示器（可跳过）──
            if (checkGenerating) {

            // 方法1: 检测 "Generating..." 等文本（最可靠）
            const generatingTexts = [
              'Generating', 'Thinking', 'Responding', 'Searching',
              '生成中', '正在回复', '正在思考', '思考中'
            ];
            const candidates = document.querySelectorAll('span, p, div');
            for (const el of candidates) {
              const t = (el.textContent || '').trim();
              if (t.length < 2 || t.length > 25) continue;
              if (generatingTexts.some(p => t.startsWith(p) || t === p + '...')) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  isGenerating = true;
                  generatingHint = `text:"${t}"`;
                  break;
                }
              }
            }

            // 方法2: 检测"停止生成"按钮（aria-label 含 stop/cancel）
            if (!isGenerating) {
              const stopBtns = document.querySelectorAll(
                'button[aria-label*="stop" i], button[aria-label*="cancel" i], ' +
                'button[aria-label*="停止" i], button[title*="Stop" i]'
              );
              for (const btn of stopBtns) {
                const rect = btn.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  isGenerating = true;
                  generatingHint = `stopBtn:"${btn.getAttribute('aria-label') || btn.title}"`;
                  break;
                }
              }
            }

            } // end if (checkGenerating)

            if (isGenerating) return { ready: false, generating: true, hint: generatingHint, currentReplyLen };

            // ── 检测是否已有新的实质回复内容（fingerprint 匹配）──
            if (checkGenerating) {
              const isOld = (text) => {
                if (!snap || !snap.fp) return false;
                return text.slice(0, 200) === snap.fp &&
                       Math.abs(text.length - snap.fpLen) < 100;
              };
              for (let i = divs.length - 1; i >= 0; i--) {
                const el = divs[i];
                if (el.className?.includes('justify-end')) continue;
                const text = (el.innerText || el.textContent || '').trim();
                if (text.length <= 200) continue;
                if (isOld(text)) continue;
                return { ready: true, generating: false, hint: 'new-reply-by-fingerprint', currentReplyLen };
              }
            }

            // ── 检测发送按钮状态 ──
            const selectors = [
              sendFeatures?.selector,
              ...(sendFeatures?.candidateSelectors || []),
              sendFeatures?.attrs?.ariaLabel ? `[aria-label="${sendFeatures.attrs.ariaLabel}"]` : null,
              'button[type="submit"]',
              'button'
            ].filter(Boolean);
            const pool = new Set();
            selectors.forEach(sel => {
              try { document.querySelectorAll(sel).forEach(el => pool.add(el)); } catch {}
            });
            let target = null;
            let best = -1;
            pool.forEach(el => {
              let s = 0;
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) s += 8;
              selectors.forEach((sel, idx) => {
                try { if (el.matches(sel)) s += idx === 0 ? 26 : 10; } catch {}
              });
              const txt = `${el.innerText || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
              if (txt.includes('发送') || txt.includes('send') || txt.includes('submit')) s += 10;
              if (s > best) { best = s; target = el; }
            });
            if (!target || best < 16) return { ready: false, generating: false, currentReplyLen };
            const btnReady = !target.disabled &&
                   !target.hasAttribute('disabled') &&
                   target.getAttribute('aria-disabled') !== 'true';
            return { ready: btnReady, generating: false, currentReplyLen };
          },
          args: [siteConfig.sendFeatures, !skipGeneratingCheck, replySnapshot, replySelector, copyBtnSelector || null]
        });

        const r = results[0]?.result;
        const elapsed = Math.round((Date.now() - startTime) / 1000);

        // 始终跟踪文本长度变化（用于稳定性判断 + 停滞检测）
        // 用 !== 而非 > 以正确处理 DOM 结构变化（如多块切换导致 div 长度突降）
        if (typeof r?.currentReplyLen === 'number' && r.currentReplyLen >= 0) {
          if (r.currentReplyLen !== lastReplyLen) {
            lastReplyLen = r.currentReplyLen;
            lastChangeAt = Date.now();
            loggedStallWarn = false;
          }
        }

        if (r?.ready && !r?.generating) {
          // copy-btn-visible 是确定性信号（复制按钮只在 AI 真正完成后才出现），无需稳定性检查
          // 其他 ready 路径（fingerprint / btn-ready）需 5 秒稳定性以防误判
          const isDefinitive = r.hint === 'copy-btn-visible';
          if (!isDefinitive && lastReplyLen >= 0) {
            const STABILITY_MS = 5000;
            const stableMs = Date.now() - lastChangeAt;
            if (stableMs < STABILITY_MS) {
              if (elapsed % 20 === 0 || elapsed <= 5) {
                log('等待回复',
                  `[${elapsed}秒] 检测到回复但文本仍在变化（稳定 ${Math.round(stableMs / 1000)}/${STABILITY_MS / 1000} 秒，hint=${r.hint || 'btn-ready'}）`);
              }
              setTimeout(check, 2000);
              return;
            }
          }
          log('等待回复', `AI回复完成 (${elapsed}秒，hint=${r.hint || 'btn-ready'})`);
          resolve();
          return;
        }

        // ── 停滞检测：文本长度连续 stallTimeout 毫秒无增长 → 提前判失败 ──
        if (stallTimeout > 0 && lastReplyLen >= 0) {
          const stallMs = Date.now() - lastChangeAt;
          // 停滞达到一半阈值时先告警一次，便于用户观察
          if (!loggedStallWarn && stallMs >= stallTimeout / 2 && stallMs >= 10000) {
            log('等待回复',
              `回复文本 ${Math.round(stallMs / 1000)} 秒无增长（长度=${lastReplyLen}），继续观察...`,
              'warn');
            loggedStallWarn = true;
          }
          if (stallMs >= stallTimeout) {
            const err = new Error(
              `AI回复停滞：文本 ${Math.round(stallMs / 1000)} 秒无增长，发送按钮未恢复（疑似卡住）`
            );
            err.code = 'REPLY_STALLED';
            reject(err);
            return;
          }
        }

        if (elapsed % 20 === 0 || elapsed <= 5) {
          const reason = r?.generating
            ? `AI生成中 (${r.hint || ''})`
            : '发送按钮未就绪';
          log('等待回复', `[${elapsed}秒] ${reason}`);
        }
        setTimeout(check, 2000);
      } catch {
        setTimeout(check, 2000);
      }
    };

    // 延迟3秒开始检测（给AI足够时间进入"生成中"状态）
    setTimeout(check, 3000);
  });
}

/**
 * 等待图片上传在页面上真正完成:
 * 1) 没有正在上传/加载的指示器  2) 发送按钮可点击
 * 用于参考图上传后、文本输入前，确保页面已处理完附件
 */
async function waitForUploadSettled(tabId, cfg, timeout) {
  const start = Date.now();
  let stableCount = 0;
  let lastReason = '';

  while (Date.now() - start < timeout) {
    assertTaskRunning();
    const settled = await chrome.scripting.executeScript({
      target: { tabId },
      func: (uploadCfg, sendFeatures) => {
        const isVisible = el => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const st = getComputedStyle(el);
          return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
        };

        // 输入区域容器（限定 progressbar 检测范围，避免页面上旧对话中的 loading 干扰）
        const inputArea = document.querySelector('#input-engine-container')
          || document.querySelector('[class*="input-area"]')
          || document.querySelector('[class*="composer"]');

        const loadingSels = [
          uploadCfg?.uploadLoadingSelector,
          '[class*="upload"][class*="loading"]',
          '[class*="uploading"]',
          '.upload-progress',
          '[class*="image-loading"]',
          '[class*="img-loading"]',
          '[class*="file-loading"]',
          '[class*="attachment"] [class*="loading"]',
          '[class*="attach"] [class*="spinner"]',
          '[class*="preview"] [class*="loading"]'
        ].filter(Boolean);
        const searchRoot = inputArea || document;
        for (const sel of loadingSels) {
          try { if (isVisible(searchRoot.querySelector(sel))) return { ready: false, reason: 'loading:' + sel }; } catch {}
        }
        // progressbar 单独检查：仅在输入区域范围内
        if (inputArea) {
          try {
            const pb = inputArea.querySelector('[role="progressbar"]');
            if (isVisible(pb)) return { ready: false, reason: 'loading:[role="progressbar"]' };
          } catch {}
        }

        const previewRoot = inputArea || document;
        const previewImgs = previewRoot.querySelectorAll(
          '[class*="upload"] img, [class*="preview"] img, [class*="attachment"] img, [class*="attach"] img'
        );
        for (const img of previewImgs) {
          if (isVisible(img) && img.src && !img.complete) {
            return { ready: false, reason: 'img-incomplete' };
          }
        }

        const sendSels = [
          sendFeatures?.selector,
          ...(sendFeatures?.candidateSelectors || []),
          sendFeatures?.attrs?.ariaLabel ? `[aria-label="${sendFeatures.attrs.ariaLabel}"]` : null,
          'button[type="submit"]'
        ].filter(Boolean);
        for (const sel of sendSels) {
          try {
            const btn = document.querySelector(sel);
            if (btn && isVisible(btn)) {
              const disabled = btn.disabled ||
                btn.hasAttribute('disabled') ||
                btn.getAttribute('aria-disabled') === 'true';
              return { ready: !disabled, reason: disabled ? 'send-disabled' : 'ok' };
            }
          } catch {}
        }

        return { ready: true, reason: 'no-send-btn-found' };
      },
      args: [cfg, cfg.sendFeatures]
    });

    const res = settled?.[0]?.result;
    if (res?.ready) {
      stableCount++;
      if (stableCount >= 2) return true;
    } else {
      stableCount = 0;
      lastReason = res?.reason || 'unknown';
      if (res?.reason) log('参考图', `页面未就绪: ${res.reason}`);
    }
    await sleep(1000);
  }
  log('参考图', `等待页面就绪超时(${Math.round(timeout / 1000)}秒)，最后状态: ${lastReason}`, 'warn');
  return false;
}

/**
 * 滚动回复容器强制渲染完整内容（针对虚拟滚动的网站如千问）
 * 找到最新的 AI 回复容器，先滚到顶部再滚到底部，触发全部 DOM 渲染
 * 对不使用虚拟滚动的网站（如 Arena.ai）无副作用
 */
async function _scrollToForceRender(tabId, replySelector) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (sel) => {
        const scrollContainer = document.querySelector('.message-list-scroll-container');
        if (!scrollContainer) return { skipped: true, reason: 'no_scroll_container' };

        const replyEls = document.querySelectorAll(sel || 'ol > div');
        if (!replyEls.length) return { skipped: true, reason: 'no_reply_els' };
        const lastReply = replyEls[replyEls.length - 1];

        const lenBefore = (lastReply.innerText || '').length;

        scrollContainer.scrollTop = 0;
        await new Promise(r => setTimeout(r, 500));

        const sh = scrollContainer.scrollHeight;
        const step = Math.max(300, Math.floor(sh / 20));
        for (let pos = 0; pos <= sh; pos += step) {
          scrollContainer.scrollTop = pos;
          await new Promise(r => setTimeout(r, 200));
        }
        scrollContainer.scrollTop = sh;
        await new Promise(r => setTimeout(r, 800));

        const lenAfter = (lastReply.innerText || '').length;
        return { lenBefore, lenAfter, scrollHeight: sh };
      },
      args: [replySelector || null]
    });
    const info = results[0]?.result;
    if (info && !info.skipped) {
      log('滚动渲染', `渲染前${info.lenBefore}字符 → 渲染后${info.lenAfter}字符`);
    }
  } catch {}
}

/**
 * 发送消息前拍摄页面快照：总 div 数 + 最后回复的指纹（前200字符+长度）
 * 用于发送后精确定位「新回复」
 */
async function _getReplySnapshot(tabId, replySelector) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        const divs = Array.from(document.querySelectorAll(sel || 'ol > div'));
        const totalDivs = divs.length;
        let fp = '', fpLen = 0;
        for (let i = divs.length - 1; i >= 0; i--) {
          const el = divs[i];
          if (el.className?.includes('justify-end')) continue;
          const text = (el.innerText || el.textContent || '').trim();
          if (text.length > 100) {
            fp = text.slice(0, 200);
            fpLen = text.length;
            break;
          }
        }
        return { totalDivs, fp, fpLen };
      },
      args: [replySelector || null]
    });
    return results[0]?.result || { totalDivs: 0, fp: '', fpLen: 0 };
  } catch {
    return { totalDivs: 0, fp: '', fpLen: 0 };
  }
}

/**
 * 获取页面新的Claude回复（排除发送前已存在的旧回复）
 * 策略：优先用位置（只看 snapshot.totalDivs 之后的 div），兜底用指纹
 */
async function getLastReply(tabId, snapshot = null, replySelector) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (snap, sel) => {
      const divs = Array.from(document.querySelectorAll(sel || 'ol > div'));

      // 指纹匹配辅助：判断文本是否为快照中的旧回复
      const isOldReply = (text) => {
        if (!snap || !snap.fp) return false;
        return text.slice(0, 200) === snap.fp &&
               Math.abs(text.length - snap.fpLen) < 100;
      };

      // 策略1：指纹优先——从后往前找，跳过与旧指纹匹配的（最可靠）
      for (let i = divs.length - 1; i >= 0; i--) {
        const el = divs[i];
        if (el.className?.includes('justify-end')) continue;
        const text = (el.innerText || el.textContent || '').trim();
        if (text.length <= 100) continue;
        if (isOldReply(text)) continue;
        return { text, method: 'fingerprint' };
      }

      // 策略2：兜底——直接取最后一条（无快照或所有回复都匹配旧指纹时）
      for (let i = divs.length - 1; i >= 0; i--) {
        const el = divs[i];
        if (el.className?.includes('justify-end')) continue;
        const text = (el.innerText || el.textContent || '').trim();
        if (text.length > 100) return { text, method: 'fallback' };
      }

      return null;
    },
    args: [snapshot, replySelector || null]
  });

  const r = results[0]?.result;
  if (!r?.text) return null;

  log('获取回复', `定位方式: ${r.method}`);

  // fallback 策略额外校验：如果有快照且回复指纹与旧回复一致，说明没有产生新回复
  if (r.method === 'fallback' && snapshot && snapshot.fp) {
    const candidateFp = r.text.trim().slice(0, 200);
    const candidateLen = r.text.trim().length;
    if (candidateFp === snapshot.fp && Math.abs(candidateLen - snapshot.fpLen) < 50) {
      log('获取回复', `fallback 取到的回复与发送前快照一致（长度差${Math.abs(candidateLen - snapshot.fpLen)}），判定为未产生新回复`, 'warn');
      return null;
    }
  }

  let text = r.text;
  text = text.replace(/^[a-zA-Z0-9][\w\-\.\/]+\s*\n/, '').trim();
  return text;
}

/**
 * 通过点击页面「复制」按钮获取完整回复文本。
 * 在 MAIN world 中拦截 Clipboard.prototype.write/writeText（原型级），
 * 点击复制按钮后从拦截数据中取得完整回复。
 * 搜索范围限定在最新回复的工具栏内，取第一个匹配（复制按钮是工具栏首个操作）。
 * @param {number} tabId
 * @param {string} copyBtnSelector - 复制按钮的 CSS 选择器
 * @returns {Promise<string|null>}
 */
async function _getReplyViaCopyButton(tabId, copyBtnSelector) {
  if (!copyBtnSelector) return null;
  try {
    // 先滚动到底部，确保工具栏（含复制按钮）已渲染到 DOM
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const sc = document.querySelector('.message-list-scroll-container');
        if (sc) sc.scrollTop = sc.scrollHeight;
      }
    });
    await sleep(800);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (btnSel) => {
        // 将搜索范围限定到最新回复的工具栏
        let searchRoot = document;
        const scrollWrap = document.querySelector('[class*="scrollOutWrapper"]');
        if (scrollWrap) {
          const toolbars = scrollWrap.querySelectorAll('div.mt-4');
          if (toolbars.length) {
            searchRoot = toolbars[toolbars.length - 1];
          }
        }

        let candidates = searchRoot.querySelectorAll(btnSel);
        if (!candidates.length) {
          candidates = document.querySelectorAll(btnSel);
        }
        if (!candidates.length) {
          return { ok: false, reason: 'copy_btn_not_found' };
        }

        const target = candidates[0];

        let captured = null;

        // 原型级拦截：确保即使页面通过闭包引用了方法也能被拦截
        const origWrite = Clipboard.prototype.write;
        const origWriteText = Clipboard.prototype.writeText;

        Clipboard.prototype.write = async function (data) {
          try {
            for (const item of data) {
              for (const type of item.types) {
                if (type === 'text/plain') {
                  const blob = await item.getType(type);
                  captured = await blob.text();
                }
              }
            }
          } catch (_) {}
          // 不调用原始方法，避免 NotAllowedError
        };
        Clipboard.prototype.writeText = async function (text) {
          captured = text;
        };

        try {
          target.click();
          await new Promise(r => setTimeout(r, 1500));
        } finally {
          Clipboard.prototype.write = origWrite;
          Clipboard.prototype.writeText = origWriteText;
        }

        if (captured) {
          return { ok: true, text: captured, len: captured.length };
        }
        return { ok: false, reason: 'no_clipboard_data_after_prototype_hook' };
      },
      args: [copyBtnSelector]
    });

    const r = results[0]?.result;
    if (r?.ok && r.text) {
      log('获取回复', `通过复制按钮获取 ${r.len} 字符`);
      return r.text;
    }
    log('获取回复', `复制按钮方式失败: ${r?.reason || 'unknown'}`, 'warn');
    return null;
  } catch (e) {
    log('获取回复', `复制按钮异常: ${e.message}`, 'warn');
    return null;
  }
}

/**
 * 检测页面上是否有错误弹窗/Toast（豆包等站点）
 * 命中则返回错误文本（非空字符串），否则返回 null
 */
async function detectErrorDialog(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // 常见错误容器选择器（覆盖 semi-ui / 自定义弹窗 / toast）
        const selectors = [
          '.semi-modal.semi-modal-error',
          '.semi-toast-error',
          '.semi-toast[class*="error"]',
          '.semi-notification-notice-error',
          '[role="alertdialog"]',
          '[class*="error-modal"]',
          '[class*="ErrorModal"]'
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) {
            const text = (el.innerText || el.textContent || '').trim();
            if (text && text.length < 500) return text;
            return '(页面错误弹窗已出现)';
          }
        }
        // 兜底：命中含"失败/错误/异常/限流/审核/违规"文案的 toast 层
        const toasts = document.querySelectorAll('.semi-toast, [class*="toast"]');
        for (const t of toasts) {
          if (t.offsetParent === null) continue;
          const txt = (t.innerText || '').trim();
          if (/失败|错误|异常|限流|审核|违规|敏感|超时|unavailable|failed/i.test(txt) && txt.length < 200) {
            return txt;
          }
        }
        return null;
      }
    });
    return res?.result || null;
  } catch {
    return null;
  }
}

/**
 * 尝试关闭页面上的错误弹窗/Toast（best-effort）
 * 仅按通用关闭按钮 + Esc 键兜底，失败不抛错
 */
async function tryDismissErrorDialog(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const closeSelectors = [
          '.semi-modal-close',
          '.semi-modal .semi-button[aria-label*="关闭"]',
          '.semi-modal [aria-label="关闭"]',
          '.semi-modal [aria-label="Close"]',
          '.semi-toast-close',
          '[class*="modal"] [class*="close"]',
          '[role="alertdialog"] button'
        ];
        for (const sel of closeSelectors) {
          try {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) {
              el.click();
              return { closed: true, by: sel };
            }
          } catch {}
        }
        // Esc 键兜底
        try {
          const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true });
          document.dispatchEvent(ev);
          return { closed: true, by: 'Escape' };
        } catch {}
        return { closed: false };
      }
    });
  } catch { /* best effort */ }
  await sleep(400);
}

/**
 * 智能恢复前的页面状态检查
 * 一次 executeScript 拿齐所有判断依据，用于决定走"补点一次"还是"刷新重开"
 *
 * @returns {Promise<{
 *   hasText: boolean,
 *   textLen: number,
 *   textMatchesExpected: boolean,
 *   attachmentCount: number,
 *   sendButtonEnabled: boolean,
 *   errorDialogPresent: boolean,
 *   errorDialogText: string|null
 * }>}
 */
async function verifyInputStateForRecovery(tabId, cfg, expectedTextHead) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (inputFeatures, sendFeatures, expectedHead) => {
        const isVisible = el => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && el.offsetParent !== null;
        };

        // 定位输入框（复用 fillViaCDP 的选择器候选）
        const inputSels = [
          inputFeatures?.selector,
          ...(inputFeatures?.candidateSelectors || []),
          'textarea', '[contenteditable="true"]', 'input'
        ].filter(Boolean);
        let inputEl = null;
        for (const sel of inputSels) {
          try {
            const el = document.querySelector(sel);
            if (el && isVisible(el)) { inputEl = el; break; }
          } catch {}
        }

        const inputText = inputEl
          ? ((inputEl.value != null ? inputEl.value : inputEl.innerText) || '').trim()
          : '';
        const hasText  = inputText.length > 0;
        const textLen  = inputText.length;

        // 文本匹配：用头部 50 字比较，容忍格式化差异
        let textMatchesExpected = false;
        if (hasText && expectedHead && expectedHead.length >= 10) {
          const head = inputText.slice(0, Math.min(50, expectedHead.length));
          const exp  = expectedHead.slice(0, head.length);
          // 去空白后比较，允许 80% 字符重合
          const normH = head.replace(/\s+/g, '');
          const normE = exp.replace(/\s+/g, '');
          if (normH && normE) {
            let match = 0;
            for (let i = 0; i < Math.min(normH.length, normE.length); i++) {
              if (normH[i] === normE[i]) match++;
            }
            textMatchesExpected = match / normE.length >= 0.8;
          }
        }

        // 统计输入区域内的附件缩略图
        // 策略：在输入框的祖先容器里找带缩略图的节点，或者全局扫带 data-attachment/preview 的
        let attachmentCount = 0;
        const container = inputEl?.closest('[class*="editor"], [class*="input"], [class*="composer"], form, .semi-input-wrapper')
                          || inputEl?.parentElement?.parentElement
                          || document.body;
        const attachSels = [
          'img[src^="blob:"]',
          '[data-testid*="attachment"]',
          '[class*="attachment"] img',
          '[class*="upload-preview"] img',
          '[class*="UploadPreview"] img',
          '[class*="thumbnail"]'
        ];
        const seen = new Set();
        for (const sel of attachSels) {
          try {
            const els = container.querySelectorAll(sel);
            els.forEach(e => {
              if (isVisible(e) && !seen.has(e)) { seen.add(e); attachmentCount++; }
            });
          } catch {}
        }

        // 发送按钮状态
        const sendSels = [
          sendFeatures?.selector,
          ...(sendFeatures?.candidateSelectors || []),
          sendFeatures?.attrs?.ariaLabel ? `[aria-label="${sendFeatures.attrs.ariaLabel}"]` : null,
          'button[type="submit"]'
        ].filter(Boolean);
        let sendButtonEnabled = false;
        for (const sel of sendSels) {
          try {
            const el = document.querySelector(sel);
            if (el && isVisible(el)) {
              sendButtonEnabled = !el.disabled
                && !el.hasAttribute('disabled')
                && el.getAttribute('aria-disabled') !== 'true';
              break;
            }
          } catch {}
        }

        // 错误弹窗（轻量重查一次）
        let errorDialogPresent = false;
        let errorDialogText = null;
        const errSels = [
          '.semi-modal.semi-modal-error',
          '.semi-toast-error',
          '.semi-toast[class*="error"]',
          '.semi-notification-notice-error',
          '[role="alertdialog"]',
          '[class*="error-modal"]',
          '[class*="ErrorModal"]'
        ];
        for (const sel of errSels) {
          try {
            const el = document.querySelector(sel);
            if (el && isVisible(el)) {
              errorDialogPresent = true;
              errorDialogText = (el.innerText || '').trim().slice(0, 200);
              break;
            }
          } catch {}
        }

        return {
          hasText, textLen, textMatchesExpected,
          attachmentCount,
          sendButtonEnabled,
          errorDialogPresent, errorDialogText
        };
      },
      args: [cfg.inputFeatures, cfg.sendFeatures, (expectedTextHead || '').slice(0, 100)]
    });
    return res?.result || {
      hasText: false, textLen: 0, textMatchesExpected: false,
      attachmentCount: 0, sendButtonEnabled: false,
      errorDialogPresent: false, errorDialogText: null
    };
  } catch (e) {
    log('状态检查', `verifyInputStateForRecovery 异常: ${e.message}`, 'warn');
    return {
      hasText: false, textLen: 0, textMatchesExpected: false,
      attachmentCount: 0, sendButtonEnabled: false,
      errorDialogPresent: false, errorDialogText: null
    };
  }
}

/**
 * 只点一次发送按钮（不重写文本），用于"消息被吞掉"的轻量重发
 * 返回 true 表示点击成功（并不代表消息真发出去）
 */
async function tryResendOnce(tabId, cfg) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sendFeatures) => {
        const sels = [
          sendFeatures?.selector,
          ...(sendFeatures?.candidateSelectors || []),
          sendFeatures?.attrs?.ariaLabel ? `[aria-label="${sendFeatures.attrs.ariaLabel}"]` : null,
          'button[type="submit"]'
        ].filter(Boolean);
        for (const sel of sels) {
          try {
            const btn = document.querySelector(sel);
            if (!btn) continue;
            const rect = btn.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
            btn.click();
            return { ok: true, by: sel };
          } catch {}
        }
        return { ok: false };
      },
      args: [cfg.sendFeatures]
    });
    return !!res?.result?.ok;
  } catch {
    return false;
  }
}

/**
 * 观察"补点一次"后的反馈
 * 15 秒内，只要页面进入 loading 状态 或 拦截器抓到新 CDN 响应，就视为点击生效
 * @param {object} beforeData - { intercepted: Set } 发送前拦截器快照
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
async function observeResendResult(tabId, cfg, beforeData, timeoutMs = 15000, siteId) {
  const start = Date.now();
  let rounds = 0;
  while (Date.now() - start < timeoutMs) {
    if (State._stopSignal || !State.taskRunning) return { ok: false, reason: 'task_stopped' };
    rounds++;
    try {
      // 1) 拦截器有新 CDN → 点击生效
      const intercepted = await getInterceptedImageUrls(tabId, siteId);
      const hasNewCdn = intercepted.some(u => !beforeData.intercepted.has(u));
      if (hasNewCdn) return { ok: true, reason: 'new_cdn_request' };

      // 2) 页面进入 loading 状态（按钮禁用或有转圈）→ 点击生效
      const loading = await checkPageLoading(tabId, cfg);
      if (loading) return { ok: true, reason: 'page_entered_loading' };
    } catch { /* 继续轮询 */ }
    await sleep(2000);
  }
  return { ok: false, reason: `observed_${rounds}_rounds_no_feedback` };
}

/**
 * 等待页面出现新图片
 * 优先使用 API 拦截器（精准获取无水印原图），DOM 扫描作为兜底
 *
 * @param {number} tabId
 * @param {object} cfg - 站点配置
 * @param {object} beforeData - { intercepted: Set, dom: Set }
 * @param {number} timeout
 * @returns {Promise<{urls: string[], source: 'interceptor'|'dom'}>}
 */
async function waitForNewImages(tabId, cfg, beforeData, timeout, expectedCount = 0, siteId) {
  const startTime   = Date.now();
  let stableCounter = 0;
  let lastNewCount  = 0;
  let checkRound    = 0;
  let lastResult    = { urls: [], source: 'dom' };

  const hasInterceptor = true;
  const MIN_WAIT_MS = 20000;
  // 连续命中 blob 守卫的轮数（快失败阈值）
  let blobGuardStreak = 0;
  const BLOB_GUARD_FAST_FAIL = 6; // 6 轮 ≈ 12s 持续只见 blob 且无 CDN → 快失败

  log('等待生图', `开始监测: 拦截器已知=${beforeData.intercepted.size}, DOM已知=${beforeData.dom.size}, 超时=${Math.round(timeout / 1000)}秒, 预期≥${expectedCount}张`);

  return new Promise((resolve, reject) => {
    const check = async () => {
      if (State._stopSignal || !State.taskRunning) {
        reject(Object.assign(new Error('TASK_STOPPED'), { code: 'TASK_STOPPED' }));
        return;
      }
      checkRound++;
      const elapsedMs = Date.now() - startTime;
      const elapsed   = Math.round(elapsedMs / 1000);

      if (elapsedMs > timeout) {
        if (lastResult.urls.length > 0) {
          log('等待生图', `超时但有${lastResult.urls.length}张新图(${lastResult.source})，继续处理`, 'warn');
          resolve(lastResult);
        } else {
          log('等待生图', `超时且无新图`, 'error');
          reject(new Error(`等待图片生成超时(${elapsed}秒)，未检测到任何新图片`));
        }
        return;
      }

      try {
        let newUrls  = [];
        let source   = 'dom';
        let isLoading = false;

        // ── 优先：API 拦截器（直接从 API 响应获取无水印原图URL） ──
        if (hasInterceptor) {
          const intercepted = await getInterceptedImageUrls(tabId, siteId);
          const newIntercepted = intercepted.filter(u => !beforeData.intercepted.has(u));
          if (newIntercepted.length > 0) {
            newUrls = newIntercepted;
            source  = 'interceptor';
          }
        }

        // ── 错误弹窗/Toast 早期检测（每 ~6s 轮询，且还没抓到任何 CDN 响应时才检查） ──
        // 命中则直接抛错，触发上层批次重试 / 刷新续跑，无需等到整体超时
        if (newUrls.length === 0 && checkRound % 3 === 0) {
          const errText = await detectErrorDialog(tabId);
          if (errText) {
            log('等待生图', `检测到页面错误: ${errText.slice(0, 120)}`, 'error');
            reject(new Error(`页面出现错误提示，终止等待: ${errText.slice(0, 80)}`));
            return;
          }
        }

        // ── 兜底：DOM 扫描（配置区域 + 定期全页面） ──
        if (newUrls.length === 0) {
          const [areaUrls, fullUrls, loading] = await Promise.all([
            getPageImageUrls(tabId, cfg),
            checkRound % 3 === 0 ? getPageImageUrls(tabId, {}) : Promise.resolve([]),
            checkPageLoading(tabId, cfg)
          ]);
          isLoading = loading;
          const combined = new Set([...areaUrls, ...fullUrls]);
          newUrls = [...combined].filter(u => !beforeData.dom.has(u));
          source  = 'dom';
        }

        // ── 防误报：全部候选都是 blob: URL 且拦截器从未抓到任何 CDN 响应 ──
        // 豆包等走 CDN 的站点，真正的生成结果必然经过 API 拦截器（byteimg.com 之类）。
        // 若只有 blob: URL 出现（且没有任何 CDN 响应），极可能是：
        //   1) 用户消息连同上传参考图被回显到对话区（最常见）
        //   2) 页面卡在上传预览/错误弹窗阶段，消息实际未发出去
        // 这种情况下把 blob URL 下载下来的，就是"上传的参考图"而非生图结果。
        let blobGuardTriggered = false;
        if (
          source === 'dom' &&
          hasInterceptor &&
          newUrls.length > 0 &&
          newUrls.every(u => typeof u === 'string' && u.startsWith('blob:'))
        ) {
          const interceptedNow = await getInterceptedImageUrls(tabId, siteId);
          const newCdnCount = interceptedNow.filter(u => !beforeData.intercepted.has(u)).length;
          if (newCdnCount === 0) {
            blobGuardTriggered = true;
            if (checkRound % 5 === 1) {
              log('等待生图',
                `忽略${newUrls.length}张可疑blob候选（均为站内blob且无CDN响应，疑似上传回显/未发送成功）`,
                'warn');
            }
            newUrls = [];
          }
        }

        // ── 连续命中 blob 守卫 + 页面静默 → 判定消息实际未发送成功，快失败 ──
        // 让上层能清掉 _promptSentBatches[i] 并立即触发重发，避免熬满 300 秒×3 次
        //
        // 关键保险：必须同时满足 isLoading === false 才计入 streak
        //   - 正常生图：豆包"思考中"/按钮禁用 → isLoading=true → streak 不累加，不会误杀
        //   - 真没发出去：页面静默、发送按钮可点 → isLoading=false → streak 累加，快失败生效
        // 这样即便豆包 80 秒才出第一张 CDN 也不会误命中
        if (blobGuardTriggered && isLoading === false) {
          blobGuardStreak++;
          if (elapsedMs >= MIN_WAIT_MS && blobGuardStreak >= BLOB_GUARD_FAST_FAIL) {
            log('等待生图',
              `连续${blobGuardStreak}轮仅见站内blob、无CDN响应、页面静默（${elapsed}秒），判定消息未发送成功，快失败`,
              'error');
            const err = new Error('消息未发送成功：连续仅检测到上传参考图回显，且页面未在生成');
            err.code = 'MESSAGE_NOT_SENT';
            reject(err);
            return;
          }
        } else {
          // 页面仍在 loading 或拿到过 CDN → 重置计数，保护正常慢生图
          blobGuardStreak = 0;
        }

        const newCount = newUrls.length;

        if (checkRound % 5 === 1) {
          log('等待生图', `[${elapsed}秒] 来源=${source}, 新图=${newCount}, loading=${isLoading}, stable=${stableCounter}`);
        }

        broadcastToPopup({
          type: 'IMAGE_GEN_PROGRESS',
          data: { newImages: newCount, source, isLoading }
        });

        if (newCount > 0 && newCount === lastNewCount) {
          // 核心判定逻辑：
          // 1) 页面仍在 loading → 不计入稳定计数，继续等待
          // 2) 还在最短等待时间内 → 不结束，避免把加载占位图当成结果
          // 3) DOM 路径但拦截器可用且拦截器还没结果 → 不轻易用 DOM 结果结束
          // 4) 数量远低于预期 → 提高稳定要求

          if (source === 'dom' && isLoading) {
            // 页面仍在加载，不累加稳定计数
          } else {
            stableCounter++;
          }

          let requiredStable;
          if (source === 'interceptor') {
            requiredStable = 2;
          } else {
            requiredStable = 3;
          }

          // DOM 结果但拦截器还没数据 → 可能只是 UI 杂图，大幅提高门槛
          if (source === 'dom' && hasInterceptor) {
            const interceptedNow = await getInterceptedImageUrls(tabId, siteId);
            const newInterceptedCount = interceptedNow.filter(u => !beforeData.intercepted.has(u)).length;
            if (newInterceptedCount === 0) {
              requiredStable = Math.max(requiredStable, 10);
            }
          }

          // 数量远低于预期 → 提高稳定要求
          if (expectedCount > 0 && newCount < expectedCount * 0.5) {
            requiredStable = Math.max(requiredStable, 8);
          }

          const canResolve = elapsedMs >= MIN_WAIT_MS && stableCounter >= requiredStable;

          if (canResolve) {
            log('等待生图', `检测完成(${source}): ${newCount}张新图片 (${elapsed}秒)`);
            resolve({ urls: newUrls, source });
            return;
          }
        } else {
          if (newCount !== lastNewCount) stableCounter = 0;
          lastNewCount = newCount;
          lastResult   = { urls: newUrls, source };
        }
      } catch (e) {
        log('等待生图', `检查异常(第${checkRound}轮): ${e.message}`, 'warn');
      }

      setTimeout(check, 2000);
    };

    setTimeout(check, 3000);
  });
}

// ═══════════════════════════════════════════
// 豆包 API 拦截器（无水印原图 URL 获取）
// ═══════════════════════════════════════════

/**
 * 确保豆包页面已安装 JSON.parse 拦截器
 * manifest 中声明的 MAIN world 脚本会自动注入，此函数用于页面已加载后的补充注入
 */
async function ensureInterceptorInstalled(tabId, siteId) {
  try {
    // Always ensure generic interceptor is present
    await ensureGenericInterceptorInstalled(tabId);

    // Inject site-specific interceptor config if the site has one
    const site = (State.config?.sites || []).find(s => s.id === siteId);
    if (site?.interceptorConfig) {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (id, cfg) => {
          if (!window.__gi_config) window.__gi_config = { sites: {} };
          window.__gi_config.sites[id] = cfg;
        },
        args: [siteId, site.interceptorConfig]
      });
    }

    // Legacy doubao interceptor fallback
    const isDoubao = siteId === 'site_doubao' || (site?.url || '').includes('doubao');
    if (isDoubao) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => !!window.__dd_hookInstalled
      });
      if (!results[0]?.result) {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          files: ['content/doubao-interceptor.js']
        });
        log('拦截器', '已动态注入豆包API拦截器（legacy）');
      }
    }

    return true;
  } catch (e) {
    log('拦截器', `注入失败: ${e.message}`, 'warn');
    return false;
  }
}

async function resetInterceptorUrls(tabId, siteId) {
  try {
    const _sid = siteId || 'doubao';
    await resetGenericInterceptorBucket(tabId, _sid);

    // Legacy doubao reset
    const site = (State.config?.sites || []).find(s => s.id === siteId);
    const isDoubao = _sid === 'site_doubao' || _sid === 'doubao' || (site?.url || '').includes('doubao');
    if (isDoubao) {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          if (window.__dd_originalUrls) window.__dd_originalUrls = [];
          if (window.__dd_urlMap) window.__dd_urlMap.clear();
        }
      });
    }
    log('拦截器', `已重置拦截器URL缓存（siteId=${_sid}）`);
  } catch {}
}

async function getInterceptedImageUrls(tabId, siteId) {
  const _sid = siteId || 'doubao';
  try {
    // Primary: generic interceptor bucket
    const genericUrls = await getGenericInterceptedUrls(tabId, _sid);
    if (genericUrls.length > 0) return genericUrls;

    // Fallback: legacy doubao interceptor
    const site = (State.config?.sites || []).find(s => s.id === siteId);
    const isDoubao = _sid === 'site_doubao' || _sid === 'doubao' || (site?.url || '').includes('doubao');
    if (isDoubao) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => window.__dd_originalUrls || []
      });
      return results[0]?.result || [];
    }
    return genericUrls;
  } catch {
    return [];
  }
}

async function resolveViaInterceptor(tabId, thumbUrls, siteId) {
  const _sid = siteId || 'doubao';
  try {
    // Primary: generic interceptor bucket
    const genericResult = await resolveViaGenericInterceptor(tabId, thumbUrls, _sid);
    if (genericResult) return genericResult;

    // Fallback: legacy doubao interceptor
    const site = (State.config?.sites || []).find(s => s.id === siteId);
    const isDoubao = _sid === 'site_doubao' || _sid === 'doubao' || (site?.url || '').includes('doubao');
    if (isDoubao) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (urls) => {
          const map = window.__dd_urlMap;
          if (!map || map.size === 0) return null;
          return urls.map(u => map.get(u) || u);
        },
        args: [thumbUrls]
      });
      return results[0]?.result || null;
    }
    return genericResult;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════
// 通用 JSON 拦截器（双轨第二轨，不改下载行为，仅用于对比日志）
// ═══════════════════════════════════════════

/**
 * 确保通用拦截器已安装（和 doubao-interceptor.js 并行存在）
 */
async function ensureGenericInterceptorInstalled(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => !!window.__gi_hookInstalled
    });
    if (results[0]?.result) return true;

    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['content/generic-interceptor.js']
    });
    return true;
  } catch (e) {
    log('通用拦截器', `注入失败: ${e.message}`, 'warn');
    return false;
  }
}

async function resetGenericInterceptorBucket(tabId, siteId = 'doubao') {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (id) => { if (typeof window.__gi_reset === 'function') window.__gi_reset(id); },
      args: [siteId]
    });
  } catch {}
}

async function getGenericInterceptedUrls(tabId, siteId = 'doubao') {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (id) => (window.__gi_buckets && window.__gi_buckets[id]?.urls) || [],
      args: [siteId]
    });
    return results[0]?.result || [];
  } catch {
    return [];
  }
}

async function resolveViaGenericInterceptor(tabId, urls, siteId = 'doubao') {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (id, thumbs) => {
        const bucket = window.__gi_buckets && window.__gi_buckets[id];
        if (!bucket || !bucket.map || bucket.map.size === 0) return null;
        return thumbs.map(u => bucket.map.get(u) || u);
      },
      args: [siteId, urls]
    });
    return results[0]?.result || null;
  } catch {
    return null;
  }
}

/**
 * 对比新老拦截器结果并写入日志（phase 1 诊断专用）
 * 只在 advancedConfig.debugCompareInterceptors === true 时输出
 */
function compareInterceptorResults(label, oldArr, newArr) {
  if (State.config?.advancedConfig?.debugCompareInterceptors !== true) return;
  try {
    const a = Array.isArray(oldArr) ? oldArr : [];
    const b = Array.isArray(newArr) ? newArr : [];
    const aSet = new Set(a);
    const bSet = new Set(b);
    const onlyA = a.filter(u => !bSet.has(u));
    const onlyB = b.filter(u => !aSet.has(u));
    const eq = (onlyA.length === 0 && onlyB.length === 0 && a.length === b.length);
    if (eq) {
      log('拦截器对比', `${label}: ✅ 等价（共${a.length}条）`);
    } else {
      log('拦截器对比',
        `${label}: ⚠️ 不一致 老=${a.length} 新=${b.length} | 仅老有${onlyA.length} | 仅新有${onlyB.length}`,
        'warn');
      if (onlyA[0]) log('拦截器对比', `  仅老示例: ${onlyA[0].slice(0, 80)}...`, 'warn');
      if (onlyB[0]) log('拦截器对比', `  仅新示例: ${onlyB[0].slice(0, 80)}...`, 'warn');
    }
  } catch {}
}

// ═══════════════════════════════════════════
// 页面图片扫描（DOM 方式，作为拦截器的兜底）
// ═══════════════════════════════════════════

async function getPageImageUrls(tabId, cfg) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (imageAreaSel, imageAreaFeatures) => {
      const pickRoot = () => {
        const selectors = [
          imageAreaSel,
          imageAreaFeatures?.selector,
          ...(imageAreaFeatures?.candidateSelectors || [])
        ].filter(Boolean);
        for (const sel of selectors) {
          try {
            const el = document.querySelector(sel);
            if (el) return el;
          } catch {}
        }
        return document;
      };
      const root = pickRoot();
      const urls = [];
      const seen = new Set();

      const addUrl = (url) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        urls.push(url);
      };

      const MIN_SIZE = 150;
      const isLargeEnough = (w, h) => (w === 0 && h === 0) || (w > MIN_SIZE && h > MIN_SIZE);

      const isStaticAsset = (url) => {
        const lower = url.toLowerCase();
        return lower.endsWith('.svg') || lower.includes('/icon') ||
               lower.includes('/emoji') || lower.includes('/avatar') ||
               lower.includes('/logo') || lower.includes('favicon');
      };

      // 1) <img> 标签
      root.querySelectorAll('img').forEach(img => {
        const url = img.src || img.getAttribute('data-src') || '';
        if (!url || url === 'about:blank') return;
        if (isStaticAsset(url)) return;
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!isLargeEnough(w, h)) return;
        if (url.startsWith('http') || url.startsWith('blob:') || url.startsWith('data:image')) {
          addUrl(url);
        }
      });

      // 2) <picture> > <source> 标签
      root.querySelectorAll('picture source').forEach(source => {
        const srcset = source.getAttribute('srcset') || '';
        const firstUrl = srcset.split(',')[0]?.trim().split(/\s+/)[0];
        if (firstUrl && (firstUrl.startsWith('http') || firstUrl.startsWith('blob:'))) {
          addUrl(firstUrl);
        }
      });

      // 3) background-image 样式中的图片（只检查直接子元素和常见容器）
      root.querySelectorAll('[style*="background-image"]').forEach(el => {
        const bg = getComputedStyle(el).backgroundImage;
        const match = bg?.match(/url\(["']?(https?:\/\/[^"')]+|blob:[^"')]+)["']?\)/);
        if (match?.[1]) {
          const rect = el.getBoundingClientRect();
          if (isLargeEnough(rect.width, rect.height)) {
            addUrl(match[1]);
          }
        }
      });

      return { urls, rootFound: root !== document, rootTag: root?.tagName || 'document' };
    },
    args: [cfg.imageAreaSelector || cfg.imageAreaFeatures?.selector || '', cfg.imageAreaFeatures || null]
  });

  const data = results[0]?.result;
  if (!data) return [];
  log('图片扫描', `root=${data.rootTag}(${data.rootFound ? '已定位' : '全页面'}), 找到 ${data.urls.length} 张`);
  return data.urls;
}

function guessImageExt(url) {
  if (url.startsWith('data:image/png')) return 'png';
  if (url.startsWith('data:image/webp')) return 'webp';
  if (url.startsWith('data:image/gif')) return 'gif';
  const lower = url.toLowerCase();
  if (lower.includes('.png') && !lower.includes('.png~')) return 'png';
  if (lower.includes('.webp')) return 'webp';
  if (lower.includes('.gif') && !lower.includes('.gif~')) return 'gif';
  if (lower.includes('~noop.image')) return 'png';
  return 'jpg';
}

async function convertToDataUrl(tabId, blobOrDataUrl) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (url) => {
        try {
          const resp = await fetch(url);
          const blob = await resp.blob();
          return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject('读取失败');
            reader.readAsDataURL(blob);
          });
        } catch (e) {
          return null;
        }
      },
      args: [blobOrDataUrl]
    });
    return results[0]?.result || null;
  } catch {
    return null;
  }
}

/**
 * 将缩略图URL转换为原图URL
 * 对每个缩略图URL，在页面上找到对应的<img>元素，
 * 尝试获取 data 属性中的原图地址或通过CDN URL模式推导原图
 */
async function resolveOriginalUrls(tabId, thumbUrls) {
  if (!thumbUrls.length) return [];

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (urls) => {
        const imgMap = new Map();
        document.querySelectorAll('img').forEach(img => {
          const src = img.src || '';
          if (src && urls.includes(src)) {
            imgMap.set(src, img);
          }
        });

        return urls.map(thumbUrl => {
          const img = imgMap.get(thumbUrl);

          // 1) 检查 data 属性中的原图URL
          if (img) {
            const dataAttrs = [
              'data-origin-src', 'data-original-src', 'data-raw-src',
              'data-origin', 'data-original', 'data-full-src',
              'data-high-res-src', 'data-src-original', 'data-zoom-src',
              'data-large-src', 'data-hd-src'
            ];
            for (const attr of dataAttrs) {
              const val = img.getAttribute(attr);
              if (val && val.startsWith('http')) return val;
            }

            // 2) 检查父级<a>标签是否链接到原图
            const parentA = img.closest('a[href]');
            if (parentA) {
              const href = parentA.getAttribute('href') || '';
              if (href.startsWith('http') && /\.(jpe?g|png|webp|gif|bmp|image)/i.test(href)) {
                return href;
              }
            }
          }

          // 3) ByteDance CDN URL 模式转换（去掉缩放模板获取原图）
          //    格式: https://pX-xxx.byteimg.com/.../hash~tplv-xxxx-xxx.suffix?params
          //    原图: 把 ~tplv-xxxx-xxx.suffix 替换为 ~noop.image
          if (thumbUrl.includes('byteimg.com') || thumbUrl.includes('bytetos.com') ||
              thumbUrl.includes('bytecdn.cn') || thumbUrl.includes('douyinpic.com')) {
            const tildeIdx = thumbUrl.indexOf('~');
            const queryIdx = thumbUrl.indexOf('?');
            if (tildeIdx > 0) {
              const base = thumbUrl.substring(0, tildeIdx);
              const query = queryIdx > 0 ? thumbUrl.substring(queryIdx) : '';
              return base + '~noop.image' + query;
            }
          }

          // 4) 通用：去掉常见缩放/质量查询参数
          try {
            const u = new URL(thumbUrl);
            let changed = false;
            for (const key of ['w', 'h', 'width', 'height', 'size', 'quality',
                               'q', 'resize', 'thumbnail', 'thumb', 'x-image-process']) {
              if (u.searchParams.has(key)) {
                u.searchParams.delete(key);
                changed = true;
              }
            }
            if (changed) return u.toString();
          } catch {}

          return thumbUrl;
        });
      },
      args: [thumbUrls]
    });

    const resolved = results[0]?.result || thumbUrls;
    const changedCount = resolved.filter((u, i) => u !== thumbUrls[i]).length;
    if (changedCount > 0) {
      log('原图解析', `${resolved.length}个URL中有${changedCount}个已转换为原图`);
    }
    return resolved;
  } catch (e) {
    log('原图解析', `解析失败: ${e.message}，使用缩略图URL`, 'warn');
    return thumbUrls;
  }
}

async function checkPageLoading(tabId, cfg) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (loadingSel, sendFeatures) => {
      const isVisible = el => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };

      const hasLoading = (() => {
        if (loadingSel) {
          try {
            if (isVisible(document.querySelector(loadingSel))) return true;
          } catch {}
        }
        try {
          if (isVisible(document.querySelector('[role="progressbar"]'))) return true;
        } catch {}
        const spinners = document.querySelectorAll('.spinner, .loading-spinner, [class*="spinner"], [class*="Spinner"]');
        for (const s of spinners) {
          if (isVisible(s)) return true;
        }
        return false;
      })();

      // 检查发送按钮状态
      const sendSelectors = [
        sendFeatures?.selector,
        ...(sendFeatures?.candidateSelectors || []),
        sendFeatures?.attrs?.ariaLabel
          ? `[aria-label="${sendFeatures.attrs.ariaLabel}"]`
          : null,
        'button[type="submit"]'
      ].filter(Boolean);

      let sendDisabled = false;
      for (const sel of sendSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            sendDisabled = el.disabled ||
                           el.hasAttribute('disabled') ||
                           el.getAttribute('aria-disabled') === 'true';
            break;
          }
        } catch {}
      }

      return hasLoading || sendDisabled;
    },
    args: [cfg.loadingSelector || cfg.loadingFeatures?.selector || '', cfg.sendFeatures]
  });

  return results[0]?.result ?? false;
}

// ═══════════════════════════════════════════
// BgUploader（background上下文的上传器）
// ═══════════════════════════════════════════

class BgUploader {
  constructor(config, tabId) {
    this.config = config;
    this.tabId  = tabId;
  }

  async uploadAndVerify(filesData) {
    const expectedCount = filesData.length;
    let lastErr = null;
    let lastResult = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const uploadMeta = await Promise.race([
          this._doUpload(filesData),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('上传动作超时（20秒）')), 20000);
          })
        ]);
        if (uploadMeta?.elInfo) {
          log('上传注入', `目标元素: ${uploadMeta.elInfo.tag} accept="${uploadMeta.elInfo.accept}" name="${uploadMeta.elInfo.name}" method=${uploadMeta.method}`);
        }
        const result = await this._waitAndVerify(expectedCount);
        lastResult = result;

        if (result.success) {
          await sleep(1000);
          return result;
        }

        // 宽松模式: 文件已注入但预览计数不足时允许继续
        if (this.config.verifyMode !== 'strict' && uploadMeta?.accepted === true) {
          if ((result.successCount || 0) === 0) {
            log('上传宽松兜底', '检测到文件已注入，但预览计数为0，按宽松策略继续');
            return {
              success: true,
              successCount: expectedCount,
              failCount: 0,
              fallback: true
            };
          }
          if (result.successCount > 0 && result.successCount < expectedCount) {
            log('上传宽松兜底',
              `文件已注入，预览${result.successCount}/${expectedCount}，` +
              `可能因网站附件上限或预览检测不完整，按宽松策略继续`);
            return {
              success: true,
              successCount: result.successCount,
              failCount: expectedCount - result.successCount,
              fallback: true
            };
          }
        }

        if (attempt < 3) {
          await this._clearUploaded();
          await sleep(2000);
        }
      } catch (err) {
        lastErr = err;
        log('上传错误', `第${attempt}次：${err.message}`);
        if (attempt === 3) throw err;
        await sleep(2000);
      }
    }

    const detail = lastErr?.message ||
      (lastResult
        ? `验证未通过：成功${lastResult.successCount || 0}/${expectedCount}`
        : '未知原因');
    throw new Error(
      `图片上传失败，已重试3次。${detail}。` +
      `若浏览器顶部出现“将文件上传到此网站？”弹窗，请手动点击“上传”。`
    );
  }

  async _doUpload(filesData) {
    const result = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: async (filesData, uploadFeatures) => {
        const normalizeBinary = (raw) => {
          if (!raw) return new Uint8Array(0);
          if (typeof raw === 'string' && raw.length > 0) {
            try {
              const bstr = atob(raw);
              const arr = new Uint8Array(bstr.length);
              for (let i = 0; i < bstr.length; i++) arr[i] = bstr.charCodeAt(i);
              return arr;
            } catch { return new Uint8Array(0); }
          }
          if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
          if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
          if (raw.data && Array.isArray(raw.data)) return new Uint8Array(raw.data);
          if (Array.isArray(raw)) return new Uint8Array(raw);
          return new Uint8Array(0);
        };

        const inferMimeType = (name, givenType) => {
          if (givenType && String(givenType).startsWith('image/')) return givenType;
          const ext = String(name || '').split('.').pop().toLowerCase();
          const map = {
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            png: 'image/png',
            webp: 'image/webp',
            gif: 'image/gif',
            bmp: 'image/bmp'
          };
          return map[ext] || 'application/octet-stream';
        };

        const findEl = (features) => {
          if (!features) return null;
          const selectors = [
            features.selector,
            ...(features.candidateSelectors || []),
            features.attrs?.id ? `#${features.attrs.id}` : null,
            features.attrs?.ariaLabel ? `[aria-label="${features.attrs.ariaLabel}"]` : null,
            features.attrs?.dataTestId ? `[data-testid="${features.attrs.dataTestId}"]` : null,
            features.attrs?.name ? `[name="${features.attrs.name}"]` : null,
            'input[type="file"]',
            'button'
          ].filter(Boolean);
          const pool = new Set();
          selectors.forEach(sel => {
            try { document.querySelectorAll(sel).forEach(el => pool.add(el)); } catch {}
          });
          let best = null;
          let bestScore = -1;
          pool.forEach(el => {
            let s = 0;
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) s += 8;
            selectors.forEach((sel, idx) => {
              try { if (el.matches(sel)) s += idx === 0 ? 24 : 10; } catch {}
            });
            const type = (el.getAttribute('type') || '').toLowerCase();
            const txt = `${el.innerText || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
            if (type === 'file') s += 14;
            if (txt.includes('上传') || txt.includes('upload')) s += 10;
            if (s > bestScore) { best = el; bestScore = s; }
          });
          return bestScore >= 16 ? best : null;
        };

        const uploadEl = findEl(uploadFeatures);
        if (!uploadEl) return { ok: false, error: '找不到上传按钮' };

        const _elInfo = {
          tag: uploadEl.tagName,
          type: uploadEl.type || '',
          accept: uploadEl.accept || '',
          name: uploadEl.name || ''
        };

        const files = filesData.map(f => {
          const bytes = normalizeBinary(f.buffer);
          return new File(
            [bytes],
            f.name,
            {
              type: inferMimeType(f.name, f.type),
              lastModified: Date.now()
            }
          );
        }).filter(f => f.size > 0);

        if (!files.length) {
          return { ok: false, error: '图片二进制为空（size=0），无法上传。请重新选择商品文件夹后重试' };
        }

        const isFileInput = uploadEl.tagName === 'INPUT' && uploadEl.type === 'file';

        if (isFileInput) {
          const dt = new DataTransfer();
          files.forEach(f => dt.items.add(f));
          uploadEl.files = dt.files;
          uploadEl.dispatchEvent(new Event('input', { bubbles: true }));
          uploadEl.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, accepted: true, method: 'file-input-direct', elInfo: _elInfo };
        } else {
          // 先尝试：很多站点的 file input 是预先存在的隐藏元素，不会在点击后新增
          const pickExistingFileInput = () => {
            const localCandidates = [];
            const pushIfInput = (node) => {
              if (!node) return;
              if (node.tagName === 'INPUT' && node.type === 'file') localCandidates.push(node);
              try {
                node.querySelectorAll?.('input[type="file"]').forEach(n => localCandidates.push(n));
              } catch {}
            };

            pushIfInput(uploadEl);
            pushIfInput(uploadEl.parentElement);
            pushIfInput(uploadEl.closest?.('form'));
            pushIfInput(document);

            // 去重 + 过滤不可用
            const uniq = [];
            const seen = new Set();
            for (const el of localCandidates) {
              if (!el || seen.has(el)) continue;
              seen.add(el);
              if (el.disabled) continue;
              uniq.push(el);
            }

            // 优先：与上传按钮距离最近的
            let best = null;
            let bestDist = Number.POSITIVE_INFINITY;
            const br = uploadEl.getBoundingClientRect();
            for (const fi of uniq) {
              const fr = fi.getBoundingClientRect();
              const dist = Math.abs(fr.left - br.left) + Math.abs(fr.top - br.top);
              if (dist < bestDist) {
                best = fi;
                bestDist = dist;
              }
            }
            return best;
          };

          const existingInput = pickExistingFileInput();
          if (existingInput) {
            const dt = new DataTransfer();
            files.forEach(f => dt.items.add(f));
            existingInput.files = dt.files;
            existingInput.dispatchEvent(new Event('input', { bubbles: true }));
            existingInput.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, accepted: true, method: 'file-input-existing' };
          }

          // 尝试拖拽投放（适配 drag/drop 上传区域）
          try {
            const dt = new DataTransfer();
            files.forEach(f => dt.items.add(f));
            const dragEnter = new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt });
            const dragOver  = new DragEvent('dragover',  { bubbles: true, cancelable: true, dataTransfer: dt });
            const drop      = new DragEvent('drop',      { bubbles: true, cancelable: true, dataTransfer: dt });
            uploadEl.dispatchEvent(dragEnter);
            uploadEl.dispatchEvent(dragOver);
            uploadEl.dispatchEvent(drop);
            return { ok: true, accepted: true, method: 'drag-drop' };
          } catch {}

          // 再回退：点击上传按钮并监听新增的 file input
          return await new Promise(resolve => {
            const observer = new MutationObserver(mutations => {
              for (const m of mutations) {
                for (const node of m.addedNodes) {
                  if (node.nodeType !== 1) continue;
                  const input = (node.tagName === 'INPUT' && node.type === 'file')
                    ? node : node.querySelector?.('input[type="file"]');
                  if (input) {
                    const dt = new DataTransfer();
                    files.forEach(f => dt.items.add(f));
                    input.files = dt.files;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    observer.disconnect();
                    clearTimeout(t);
                    resolve({ ok: true, accepted: true, method: 'click-then-input' });
                    return;
                  }
                }
              }
            });
            const t = setTimeout(() => {
              observer.disconnect();
              resolve({
                ok: false,
                error: '未出现可用文件输入框（3秒超时，可能被浏览器安全策略拦截）'
              });
            }, 3000);
            observer.observe(document.body, { childList: true, subtree: true });
            uploadEl.click();
          });
        }
      },
      args: [filesData, this.config.uploadFeatures]
    });

    const r = result[0]?.result;
    if (!r?.ok) throw new Error(r?.error || '上传操作执行失败');
    return r;
  }

  async _waitAndVerify(expectedCount) {
    const TIMEOUT         = this.config.uploadTimeout || 120000;
    const STABLE_REQUIRED = 3;
    const startTime       = Date.now();
    let stableCounter     = 0;
    let lastPreviewCount  = -1;

    return new Promise((resolve, reject) => {
      const check = async () => {
        if (State._stopSignal || !State.taskRunning) {
          reject(Object.assign(new Error('TASK_STOPPED'), { code: 'TASK_STOPPED' }));
          return;
        }
        if (Date.now() - startTime > TIMEOUT) {
          reject(new Error('上传验证超时'));
          return;
        }

        let status;
        try {
          const cfgWithExtra = {
            ...this.config,
            _expectedCount: expectedCount,
            inputSelector: this.config.inputFeatures?.selector || ''
          };
          const r = await chrome.scripting.executeScript({
            target: { tabId: this.tabId },
            func: (cfg) => {
              const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
              const check = (sels) => sels.filter(Boolean).some(sel => {
                try { return isVisible(document.querySelector(sel)); } catch { return false; }
              });

              const isLoading = check([
                cfg.uploadLoadingSelector,
                '[class*="upload"][class*="loading"]',
                '[class*="uploading"]',
                '.upload-progress'
              ]);

              const previewSels = [
                cfg.uploadPreviewSelector,
                '[class*="upload"][class*="preview"] img',
                '[class*="uploaded"] img',
                '[class*="attachment"] img',
                'img[class*="thumb"]',
                'img[class*="preview"]',
                '[class*="file-list"] img',
                '[class*="image-list"] img',
                '[class*="attach"] img',
                'form img[src]:not([src=""])',
                '[role="img"]'
              ].filter(Boolean);

              let previewCount = 0;
              for (const sel of previewSels) {
                try {
                  const els = document.querySelectorAll(sel);
                  const visCount = Array.from(els).filter(
                    el => el.offsetWidth > 0 && el.offsetHeight > 0
                  ).length;
                  if (visCount > previewCount) previewCount = visCount;
                } catch {}
              }

              // Arena.ai 等网站: 输入区域附近的小图作为附件预览
              if (previewCount === 0 || previewCount < (cfg._expectedCount || 0)) {
                try {
                  const inputArea = document.querySelector(
                    cfg.inputSelector || '[contenteditable="true"]'
                  );
                  if (inputArea) {
                    const container = inputArea.closest('form') || inputArea.parentElement?.parentElement;
                    if (container) {
                      const imgs = container.querySelectorAll('img[src]:not([src=""])');
                      const visImgs = Array.from(imgs).filter(
                        el => el.offsetWidth > 10 && el.offsetHeight > 10
                      ).length;
                      if (visImgs > previewCount) previewCount = visImgs;
                    }
                  }
                } catch {}
              }

              const hasError = check([
                cfg.uploadErrorSelector,
                '[class*="upload"][class*="error"]',
                '[class*="upload-fail"]'
              ]);

              return { isLoading, previewCount, hasError };
            },
            args: [cfgWithExtra]
          });
          status = r[0]?.result ?? { isLoading: false, previewCount: 0, hasError: false };
        } catch {
          setTimeout(check, 1000);
          return;
        }

        if (status.hasError) {
          reject(new Error('图片上传出现错误提示'));
          return;
        }

        broadcastToPopup({
          type: 'UPLOAD_PROGRESS',
          data: {
            previewCount:  status.previewCount,
            expectedCount,
            isLoading:     status.isLoading,
            elapsed:       Math.round((Date.now() - startTime) / 1000)
          }
        });

        if (!status.isLoading && status.previewCount === lastPreviewCount) {
          stableCounter++;
          if (stableCounter >= STABLE_REQUIRED) {
            const threshold = this.config.verifyMode === 'strict'
              ? expectedCount
              : Math.floor(expectedCount * 0.8);

            resolve({
              success:      status.previewCount >= threshold,
              successCount: status.previewCount,
              failCount:    Math.max(0, expectedCount - status.previewCount)
            });
            return;
          }
        } else {
          stableCounter    = 0;
          lastPreviewCount = status.previewCount;
        }

        setTimeout(check, 1000);
      };

      setTimeout(check, 1000);
    });
  }

  async _clearUploaded() {
    await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: (cfg) => {
        [
          cfg.uploadDeleteSelector,
          '[class*="upload"] [class*="delete"]',
          '[class*="upload"] [class*="remove"]',
          '[class*="attachment"] [class*="close"]',
          '[class*="uploaded"] [class*="del"]'
        ].filter(Boolean).forEach(sel => {
          try { document.querySelectorAll(sel).forEach(b => b.click()); } catch {}
        });
      },
      args: [this.config]
    });
    await sleep(1200);
  }
}

// ═══════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════

function buildAnalysisMessage(product, config) {
  const activeTemplate = getActiveTemplate(config);
  const selectedCols = activeTemplate?.selectedColumns || config.selectedColumns || [];

  const templateContent = activeTemplate?.content || config.messageTemplate || '';
  let finalTemplate = templateContent;

  const referencedCols = new Set();
  selectedCols.forEach(col => {
    const placeholder = `{{${col}}}`;
    if (!templateContent.includes(placeholder)) return;
    referencedCols.add(col);
    const val = String(product.fields?.[col] ?? '');
    // 独占一行 → 替换为「列名：值」；嵌入在其他文字中 → 只替换为值
    const standaloneRe = new RegExp(`^([ \\t]*)\\{\\{${col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}[ \\t]*$`, 'gm');
    if (standaloneRe.test(finalTemplate)) {
      finalTemplate = finalTemplate.replace(
        new RegExp(`^([ \\t]*)\\{\\{${col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}[ \\t]*$`, 'gm'),
        `$1${col}：${val}`
      );
    } else {
      finalTemplate = finalTemplate.replaceAll(placeholder, val);
    }
  });

  const parts = [];

  // 只列出模板中未引用的字段（避免重复）
  selectedCols.forEach(col => {
    if (referencedCols.has(col)) return;
    const val = product.fields?.[col];
    if (val !== undefined && val !== '') {
      parts.push(`${col}：${val}`);
    }
  });

  if (finalTemplate.trim()) {
    if (parts.length > 0) parts.push('');
    parts.push(finalTemplate.trim());
  }

  if (parts.length === 0) {
    throw new Error('分析消息为空，请检查Excel列配置和消息模板');
  }

  return parts.join('\n');
}

function getActiveTemplate(config) {
  const templates = config?.messageTemplates || [];
  if (!templates.length) return null;
  const activeId = config?.activeTemplateId;
  const matched = templates.find(t => t.id === activeId);
  return matched || templates[0];
}

function extractPrompts(replyText, extractConfig) {
  if (!extractConfig || extractConfig.mode === 'full') {
    const prompts = parseNumberedPrompts(replyText, extractConfig);
    return {
      promptText:      replyText,
      prompts,
      extractedLength: replyText.length,
      count:           prompts.length
    };
  }

  const rawMarker = extractConfig.startMarker;
  const startMarker = (rawMarker && rawMarker !== 'undefined' ? rawMarker : '').trim();
  if (!startMarker) {
    const prompts = parseNumberedPrompts(replyText, extractConfig);
    return {
      promptText:      replyText,
      prompts,
      extractedLength: replyText.length,
      count:           prompts.length
    };
  }

  // 转义正则元字符，并加负向先行查找：标记后不能紧跟数字
  // 例如 "Prompt 1" 不会匹配 "Prompt 10"、"Prompt 11"，只匹配真正的 "Prompt 1"
  const _escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const _markerEndsWithDigit = /\d$/.test(startMarker);
  const startRe = new RegExp(_escapeRe(startMarker) + (_markerEndsWithDigit ? '(?!\\d)' : ''));
  const startMatch = startRe.exec(replyText);
  const startIndex = startMatch ? startMatch.index : -1;
  const startMatchLen = startMatch ? startMatch[0].length : startMarker.length;
  if (startIndex === -1) {
    const fallbackPrompts = parseNumberedPrompts(replyText, extractConfig);
    if (fallbackPrompts.length > 0) {
      log('提取', `未找到标记"${startMarker}"，已通过分条规则直接提取到 ${fallbackPrompts.length} 条`);
      return {
        promptText:      replyText,
        prompts:         fallbackPrompts,
        extractedLength: replyText.length,
        count:           fallbackPrompts.length
      };
    }
    throw new Error(
      `回复中未找到提取标记："${startMarker}"\n` +
      `请在设置页面的"提取测试"中验证标记是否正确`
    );
  }

  let extractStart;
  if (extractConfig.includeMarker !== false) {
    extractStart = startIndex;
  } else {
    const nl = replyText.indexOf('\n', startIndex + startMatchLen);
    extractStart = nl !== -1 ? nl + 1 : startIndex + startMatchLen;
  }

  let extractEnd = replyText.length;
  const rawEnd = extractConfig.endMarker;
  const endMarker = (rawEnd && rawEnd !== 'undefined' ? rawEnd : '').trim();
  if (endMarker) {
    const endTail = replyText.slice(extractStart);
    const endMarkerEndsWithDigit = /\d$/.test(endMarker);
    const endRe = new RegExp(_escapeRe(endMarker) + (endMarkerEndsWithDigit ? '(?!\\d)' : ''));
    const endMatch = endRe.exec(endTail);
    if (endMatch) extractEnd = extractStart + endMatch.index;
  }

  const promptText = replyText.slice(extractStart, extractEnd).trim();
  if (!promptText) {
    throw new Error('提取到的内容为空，请检查提取标记位置');
  }

  const prompts = parseNumberedPrompts(promptText, extractConfig);

  return {
    promptText,
    prompts,
    startPosition:   startIndex,
    extractedLength: promptText.length,
    count:           prompts.length
  };
}

/**
 * 行首标题关键词（英文）：Claude 输出的分条常见开头词
 * 用 \b 词边界避免误匹配 "Shotgun" 这种前缀场景
 */
const ENGLISH_PROMPT_KEYWORDS = 'Shot|Prompt|Image|Scene|Frame|Pic|Picture|Photo|Camera|Cut|Angle|View';

/**
 * 统一的"行首编号/标题"正则，识别以下任一形式：
 *   1.  / 1、 / 1)  / 1:           （阿拉伯数字 + 分隔符）
 *   一、 / 一.                      （中文数字 + 分隔符）
 *   Shot 1  / Shot 1:  / Shot 1 - / Shot1. 等（英文关键词 + 数字）
 * 末尾可选的 [\.、\)\-:：\s] 用于吸收"Shot 1 -"这种分隔符
 */
function _buildPromptHeaderRegex(flags = '') {
  return new RegExp(
    '^\\s*(?:' +
      '(?:' + ENGLISH_PROMPT_KEYWORDS + ')\\s*\\d+\\s*[\\-\\.、\\)\\:：]?\\s*' +
      '|' +
      '\\d+\\s*[\\.、\\)\\:：]\\s*' +
      '|' +
      '[一二三四五六七八九十百千]+\\s*[、\\.]\\s*' +
    ')',
    flags
  );
}

/**
 * 按行首编号/关键词拆提示词
 * 支持：1. / 1、/ 1) / 1: / 一、/ Shot 1 / Prompt 2 / Image 3 等
 */
function parseNumberedPromptsByLines(text) {
  if (!text) return [];
  const pattern = _buildPromptHeaderRegex('i');
  const lines   = text.split('\n');
  const prompts = [];
  let cur       = '';

  lines.forEach(line => {
    const t = line.trim();
    if (!t) return;
    if (pattern.test(t)) {
      if (cur.trim()) prompts.push(cur.trim());
      cur = t;
    } else if (cur) {
      cur += '\n' + t;
    }
  });

  if (cur.trim()) prompts.push(cur.trim());
  return prompts.filter(p => p.length > 5);
}

/**
 * 同一行内出现「空格 + 数字 + .、) + 空格」形式的下一条（如 "…end. 2. Side …"）
 * 同时支持 "Shot 1 …" / "Prompt 2 …" 等英文关键词分段
 */
function parseNumberedPromptsInlineDigits(text) {
  if (!text) return [];
  const hasDigit = /\d+[\.、\)]\s/.test(text);
  const kwRe = new RegExp('(?:' + ENGLISH_PROMPT_KEYWORDS + ')\\s*\\d+', 'i');
  const hasKw = kwRe.test(text);
  if (!hasDigit && !hasKw) return [];

  // 先尝试按英文关键词切：每次遇到 "Shot/Prompt/... N" 作为新起点
  if (hasKw) {
    const kwSplit = new RegExp(
      '(?<=[^\\w])(?=(?:' + ENGLISH_PROMPT_KEYWORDS + ')\\s*\\d+)',
      'i'
    );
    const parts = text.split(kwSplit);
    if (parts.length > 1) {
      return parts.map(s => s.trim()).filter(p => p.length > 5);
    }
  }

  // 再按阿拉伯数字序号切
  const parts = text.split(/(?<=[^\d.])(?=\d{1,3}[\.、\)]\s+)/);
  if (parts.length <= 1) return [];
  return parts.map(s => s.trim()).filter(p => p.length > 5);
}

function parsePromptsByCustomPattern(text, patternStr) {
  if (!text || !patternStr) return [];
  try {
    const parts = patternStr.split('\n').map(l => l.trim()).filter(Boolean);
    if (!parts.length) return [];
    const combined = parts.map(p => '(?:' + p + ')').join('|');
    // 只匹配行首，不锚定行尾，允许标题行后有额外文字（如 "Image 1 — Title"）
    const re = new RegExp('^\\s*(?:' + combined + ')', 'im');
    const lines = text.split('\n');
    const prompts = [];
    let cur = '';

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (re.test(line)) {
        if (cur.trim()) prompts.push(cur.trim());
        cur = t;  // 标题行保留为新提示词的首行
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

/** 若 imagePrompts 仅一项却是多段编号长文，拆成多条 */
function normalizeImagePromptsArray(imagePrompts, extractConfig) {
  if (!Array.isArray(imagePrompts) || imagePrompts.length !== 1) return imagePrompts;
  const only = String(imagePrompts[0] || '').trim();
  if (only.length < 20) return imagePrompts;
  const split = parseNumberedPrompts(only, extractConfig);
  return split.length > 1 ? split : imagePrompts;
}

function splitIntoBatches(prompts, batchSize) {
  if (!prompts?.length) return [];
  batchSize = Math.max(1, batchSize || 10);

  const batches = [];
  const total   = Math.ceil(prompts.length / batchSize);

  for (let i = 0; i < prompts.length; i += batchSize) {
    batches.push({
      index:          Math.floor(i / batchSize) + 1,
      total,
      prompts:        prompts.slice(i, i + batchSize),
      startNum:       i + 1,
      endNum:         Math.min(i + batchSize, prompts.length),
      status:         'pending',
      downloadedCount: 0,
      retryCount:     0
    });
  }

  return batches;
}

function buildBatchMessage(batch, productName, igCfg) {
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

  const promptsText = batch.prompts.join('\n\n');
  if (prefix) {
    return prefix + '\n\n' + promptsText;
  }
  return promptsText;
}

async function markProductSkipped(product) {
  product.status = '已跳过';
  await saveProgress();
  broadcastToPopup({
    type: 'PRODUCT_STATUS_CHANGED',
    data: { index: product.index, status: '已跳过' }
  });
}

// ═══════════════════════════════════════════
// 进度持久化
// ═══════════════════════════════════════════

async function saveProgress() {
  const progress = State.products.map(p => ({
    index:            p.index,
    folderName:       p.folderName,
    name:             p.name,
    status:           p.status,
    analysisResult:   p.analysisResult   || '',
    imagePrompts:     p.imagePrompts     || [],
    promptText:       p.promptText       || '',
    totalSavedCount:  p.totalSavedCount  || 0,
    savedImages:      p.savedImages      || [],
    errorMessage:     p.errorMessage     || '',
    currentBatchIndex: p.currentBatchIndex || 0,
    _referenceImagesUploaded: !!p._referenceImagesUploaded,
    _promptSentBatches:         p._promptSentBatches || null,
    _waitBaselineByBatch:       p._waitBaselineByBatch || null,
    _batchCompleted:            p._batchCompleted      || null
  }));

  try {
    await chrome.storage.local.set({ taskProgress: progress });
  } catch (err) {
    log('保存进度失败', err.message);
  }
}

async function writeErrorLog(entry) {
  try {
    const result = await chrome.storage.local.get('errorLogs');
    const logs   = result.errorLogs || [];
    logs.push({
      time: new Date().toLocaleString('zh-CN'),
      ...entry
    });
    await chrome.storage.local.set({ errorLogs: logs.slice(-100) });
  } catch {}
}

// ═══════════════════════════════════════════
// 通信工具
// ═══════════════════════════════════════════

function broadcastProgress(pipeline, data) {
  broadcastToPopup({ type: 'PROGRESS_UPDATE', pipeline, data });
}

function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // popup 可能未打开，忽略
  });
}

/**
 * 广播给所有扩展页面（settings.html 等）
 */
function broadcastToExtensionPages(msg) {
  // 通过 runtime.sendMessage 广播
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ═══════════════════════════════════════════
// 流程控制工具
// ═══════════════════════════════════════════

async function waitWhilePaused() {
  while (State.taskPaused && !State._stopSignal && State.taskRunning) {
    await sleep(500);
  }
}

function checkAllComplete() {
  if (!State.products.length) return;
  if (!State.taskRunning) return;

  const pm = State.config.pipelineMode || 'both';
  if (pm !== 'analysis_only') {
    if (State.doubaoRunning) return;
    if (State.doubaoQueue.length > 0) return;
  }

  const terminalStatuses = ['完成', '失败', '已跳过'];
  if (pm === 'analysis_only') terminalStatuses.push('分析完成');

  const allSettled = State.products.every(p =>
    terminalStatuses.includes(p.status)
  );

  if (allSettled) {
    State.taskRunning = false;
    broadcastToPopup({ type: 'COMPLETE' });
    log('任务完成', '全部商品处理完毕');
  }
}

// ═══════════════════════════════════════════
// 前置步骤序列执行器
// ═══════════════════════════════════════════

/**
 * 在目标标签页上按顺序执行前置步骤序列。
 * @param {number} tabId    标签页ID
 * @param {Array}  preSteps 步骤数组 [{name, operationType, selector, successSelector, timeout, onFailure, maxRetries, delayMin, delayMax}]
 * @param {string} siteName 网站名（日志用）
 * @returns {Promise<{ok: boolean, failedStep?: string}>}
 */
async function executePreSteps(tabId, preSteps, siteName) {
  if (!Array.isArray(preSteps) || !preSteps.length) return { ok: true };

  log('前置步骤', `[${siteName}] 共 ${preSteps.length} 步`);

  for (let si = 0; si < preSteps.length; si++) {
    assertTaskRunning();
    const step = preSteps[si];
    const stepLabel = step.name || `步骤${si + 1}`;
    const maxRetries = step.maxRetries || 3;
    const opType = (step.operationType || 'CLICK').toUpperCase();
    let success = false;

    // 智能检测：对 CLICK / INPUT 等需要元素的操作，先检查元素是否存在
    if (opType !== 'WAIT_SECONDS' && step.selector) {
      const probeResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector) => {
          const el = document.querySelector(selector);
          if (!el) return { exists: false };
          const rect = el.getBoundingClientRect();
          return { exists: true, visible: rect.width > 0 && rect.height > 0 };
        },
        args: [step.selector]
      });
      const probe = probeResult[0]?.result;
      if (!probe?.exists) {
        const onFailure = step.onFailure || 'RETRY';
        if (onFailure === 'STOP') {
          log('前置步骤', `[${siteName}] ${stepLabel} 元素不存在，且策略为STOP`);
          return { ok: false, failedStep: stepLabel };
        }
        log('前置步骤', `[${siteName}] ${stepLabel} 元素不存在，已处于目标状态，跳过`);
        broadcastToPopup({
          type: 'LOG',
          data: {
            time: new Date().toLocaleTimeString(),
            site: siteName,
            level: 'info',
            message: `${stepLabel} 已处于目标状态，跳过`
          }
        });
        continue;
      }
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        broadcastToPopup({
          type: 'LOG',
          data: {
            time: new Date().toLocaleTimeString(),
            site: siteName,
            level: 'info',
            message: `执行前置步骤：${stepLabel}（第${attempt}次）`
          }
        });

        const execResult = await executeOneStep(tabId, step);

        if (!execResult.ok) {
          throw new Error(execResult.error || '操作执行失败');
        }

        if (step.successSelector) {
          const verified = await waitForStepSuccess(
            tabId,
            step.successSelector,
            step.successType || 'WAIT_APPEAR',
            step.timeout || 5000
          );
          if (!verified) {
            throw new Error(`成功标志未出现：${step.successSelector}`);
          }
        }

        success = true;
        log('前置步骤', `[${siteName}] ${stepLabel} ✅`);
        broadcastToPopup({
          type: 'LOG',
          data: {
            time: new Date().toLocaleTimeString(),
            site: siteName,
            level: 'info',
            message: `前置步骤 ${stepLabel} ✅ 完成`
          }
        });
        break;

      } catch (err) {
        log('前置步骤失败', `[${siteName}] ${stepLabel} 第${attempt}次: ${err.message}`);
        if (attempt >= maxRetries) {
          const onFailure = step.onFailure || 'RETRY';
          if (onFailure === 'STOP') {
            broadcastToPopup({
              type: 'LOG',
              data: {
                time: new Date().toLocaleTimeString(),
                site: siteName,
                level: 'error',
                message: `前置步骤 ${stepLabel} 失败（已重试${maxRetries}次），任务暂停`
              }
            });
            return { ok: false, failedStep: stepLabel };
          }
          log('前置步骤', `[${siteName}] ${stepLabel} 超过重试上限，按策略跳过`);
          broadcastToPopup({
            type: 'LOG',
            data: {
              time: new Date().toLocaleTimeString(),
              site: siteName,
              level: 'warn',
              message: `前置步骤 ${stepLabel} 失败已跳过`
            }
          });
        } else {
          assertTaskRunning();
          await sleep(1000);
        }
      }
    }

    if (success) {
      const delayMin = step.delayMin || 400;
      const delayMax = step.delayMax || 700;
      await sleep(delayMin + Math.random() * (delayMax - delayMin));
    }
  }

  return { ok: true };
}

async function executeOneStep(tabId, step) {
  const opType = (step.operationType || 'CLICK').toUpperCase();

  if (opType === 'WAIT_SECONDS') {
    const total = step.timeout || 3000;
    const end = Date.now() + total;
    while (Date.now() < end) {
      assertTaskRunning();
      await sleep(Math.min(400, end - Date.now()));
    }
    return { ok: true };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector, opType, inputValue) => {
      const el = document.querySelector(selector);
      if (!el) return { ok: false, error: `元素未找到: ${selector}` };

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return { ok: false, error: `元素不可见: ${selector}` };
      }

      switch (opType) {
        case 'CLICK':
          el.click();
          return { ok: true };

        case 'INPUT': {
          const tag = el.tagName.toUpperCase();
          const nativeTASetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          const nativeISetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (tag === 'TEXTAREA' && nativeTASetter) {
            nativeTASetter.call(el, inputValue || '');
          } else if (tag === 'INPUT' && nativeISetter) {
            nativeISetter.call(el, inputValue || '');
          } else if (el.hasAttribute('contenteditable')) {
            el.focus();
            el.textContent = inputValue || '';
          } else {
            el.value = inputValue || '';
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        }

        case 'VERIFY_TEXT': {
          const text = (el.innerText || el.textContent || '').trim();
          if (!text) return { ok: false, error: '元素文字为空' };
          return { ok: true, text };
        }

        case 'VERIFY_CLASS': {
          return { ok: true, className: el.className };
        }

        default:
          el.click();
          return { ok: true };
      }
    },
    args: [step.selector, opType, step.inputValue || '']
  });

  return results[0]?.result || { ok: false, error: '脚本执行无返回' };
}

async function waitForStepSuccess(tabId, selector, successType, timeout) {
  const waitType = (successType || 'WAIT_APPEAR').toUpperCase();
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (State._stopSignal || !State.taskRunning) return false;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel, type) => {
          const el = document.querySelector(sel);
          if (type === 'WAIT_DISAPPEAR') {
            return !el || el.getBoundingClientRect().width === 0;
          }
          return !!el && el.getBoundingClientRect().width > 0;
        },
        args: [selector, waitType]
      });
      if (results[0]?.result === true) return true;
    } catch {}
    await sleep(500);
  }

  return false;
}

// ═══════════════════════════════════════════
// 基础工具
// ═══════════════════════════════════════════

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(tag, msg, level = 'info') {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}][${tag}]`, msg);
  broadcastToPopup({
    type: 'LOG',
    data: { time, site: tag, level, message: String(msg) }
  });
}