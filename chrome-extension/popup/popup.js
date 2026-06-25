// popup/popup.js
'use strict';

// ═══════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════

let excelData   = null;   // [{folderName, ...columns}]
let folderMap   = {};     // {folderName: File[]}
let products    = [];     // 完整商品对象数组
let userConfig  = null;
let taskRunning = false;
let taskPaused  = false;

const _isSidePanel = window.location.pathname.includes('sidepanel');
let _folderChunks  = [];

// ═══════════════════════════════════════════
// DOM 引用
// ═══════════════════════════════════════════

const $ = id => document.getElementById(id);

// ═══════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════

async function init() {
  // ── 商业版：初始化会员状态条 ──
  AuthUI.createStatusBar(document.getElementById('authStatusBar'));
  const user = await AuthUI.refreshUserInfo();
  await AuthUI.updateStatusBar(user);

  userConfig = await loadConfig();
  renderPipelineMode();
  updateSiteConfigStatus();
  renderTplSwitcher();
  await tryRestoreProgress();
  bindEvents();
  checkStartButton();
}

// ═══════════════════════════════════════════
// 事件绑定
// ═══════════════════════════════════════════

function bindEvents() {
  $('btnSettings').addEventListener('click', openSettings);
  $('btnSelectExcel').addEventListener('click', () => $('inputExcel').click());

  if (_isSidePanel) {
    $('btnSelectFolder').addEventListener('click', openFolderPickerWindow);
    initFolderPickerChannel();
  } else {
    $('btnSelectFolder').addEventListener('click', () => $('inputFolder').click());
  }

  $('inputExcel').addEventListener('change', handleExcelSelect);
  $('inputFolder').addEventListener('change', handleFolderSelect);
  $('btnStart').addEventListener('click', handleStart);
  $('btnPause').addEventListener('click', handlePause);
  $('btnReset').addEventListener('click', handleReset);
  $('btnSkip').addEventListener('click', handleSkip);
  $('btnStop').addEventListener('click', handleStop);
  $('btnExport').addEventListener('click', exportResults);
  $('btnPrecheck')?.addEventListener('click', () => runPrecheckAndShow(true));
  $('alertClose').addEventListener('click', hideAlert);
  $('alertAction').addEventListener('click', handleAlertAction);

  // 自动化流程选择
  document.querySelectorAll('[name="pipelineMode"]').forEach(radio => {
    radio.addEventListener('change', handlePipelineModeChange);
  });

  // 模板切换
  $('tplSwitcher')?.addEventListener('change', handleTplSwitch);

  // 日志面板
  $('btnCopyLog')?.addEventListener('click', copyLogPanel);
  $('btnClearLog')?.addEventListener('click', clearLogPanel);
  $('btnToggleLog')?.addEventListener('click', toggleLogPanel);

  chrome.runtime.onMessage.addListener(handleMessage);

  // ── 商业版：监听认证状态变化 ──
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'AUTH_STATE_CHANGED') {
      AuthUI.updateStatusBar(msg.user);
    }
  });
}

function openSettings() {
  chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
}

// ═══════════════════════════════════════════
// Excel 处理
// ═══════════════════════════════════════════

function handleExcelSelect(e) {
  const file = e.target.files[0];
  if (!file) return;

  setFileStatus('statusExcel', '读取中...', '');

  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const wb   = XLSX.read(ev.target.result, { type: 'array' });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

      if (!rows.length) throw new Error('Excel文件为空');

      // 验证必须有"文件夹名"列
      const firstRow = rows[0];
      if (!Object.prototype.hasOwnProperty.call(firstRow, '文件夹名')) {
        throw new Error('Excel文件必须包含"文件夹名"列');
      }

      excelData = rows;
      setFileStatus(
        'statusExcel',
        `✅ ${file.name}（${rows.length}条商品数据）`,
        'ok'
      );

      // 新表格上传 → 清除旧进度，避免续传旧任务的批次状态
      window._savedProgress = null;
      chrome.storage.local.remove('taskProgress');

      // 提示用户可勾选的列（更新设置中的列列表）
      syncColumnsToConfig(rows);

      tryBuildProducts();
    } catch (err) {
      setFileStatus('statusExcel', `❌ 读取失败：${err.message}`, 'err');
      excelData = null;
    }
  };
  reader.onerror = () => {
    setFileStatus('statusExcel', '❌ 文件读取失败', 'err');
  };
  reader.readAsArrayBuffer(file);
}

function isSystemCol(c) {
  const ec = userConfig?.exportColumnConfig || {};
  const cols = ec.columns || [];
  const exportColNames = new Set(cols.map(r => r.name));
  // 旧格式兼容列名 + 所有导出规则中定义的列名
  const base = new Set(['文件夹名', '分析结果', '状态', '错误信息']);
  cols.forEach(r => { if (r.name) base.add(r.name); });
  return base.has(c) ||
    /^分析结果_\d+$/.test(c) ||
    exportColNames.has(c);
}

function syncColumnsToConfig(rows) {
  if (!userConfig) return;
  const availableCols = Object.keys(rows[0]).filter(c => !isSystemCol(c));

  // 如果用户还没配置列，自动预选所有可用列
  if (!userConfig.selectedColumns?.length) {
    userConfig.selectedColumns = availableCols;
    const activeTpl = getActiveTemplate(userConfig);
    if (activeTpl && !(activeTpl.selectedColumns || []).length) {
      activeTpl.selectedColumns = [...availableCols];
    }
    chrome.storage.local.set({ userConfig });
  }
}

// ═══════════════════════════════════════════
// 文件夹处理
// ═══════════════════════════════════════════

function handleFolderSelect(e) {
  const files = Array.from(e.target.files);
  processSelectedFiles(files);
}

function processSelectedFiles(files) {
  if (!files.length) return;

  setFileStatus('statusFolder', '扫描中...', '');

  const ALLOWED = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);
  const map = {};

  files.forEach(file => {
    const parts = file.webkitRelativePath.split('/');
    if (parts.length < 2) return;

    // 跳过AI生成图目录
    if (parts.some(p => p === 'AI生成图')) return;

    const subFolder = parts[1];
    const ext = parts[parts.length - 1].split('.').pop().toLowerCase();
    if (!ALLOWED.has(ext)) return;

    if (!map[subFolder]) map[subFolder] = [];
    map[subFolder].push(file);
  });

  folderMap = map;
  const folderCount = Object.keys(map).length;
  const imgCount    = files.filter(f => {
    const ext = f.name.split('.').pop().toLowerCase();
    return ALLOWED.has(ext) &&
           !f.webkitRelativePath.split('/').some(p => p === 'AI生成图');
  }).length;

  setFileStatus(
    'statusFolder',
    `✅ ${folderCount}个商品文件夹，共${imgCount}张图片`,
    'ok'
  );

  tryBuildProducts();
}

// ═══════════════════════════════════════════
// Side Panel 文件夹选择（通过弹出窗口避免崩溃）
// ═══════════════════════════════════════════

function openFolderPickerWindow() {
  _folderChunks = [];
  setFileStatus('statusFolder', '请在弹出窗口中选择文件夹...', '');
  chrome.windows.create({
    url:     chrome.runtime.getURL('popup/folder-picker.html'),
    type:    'popup',
    width:   480,
    height:  300,
    focused: true
  });
}

function initFolderPickerChannel() {
  const bc = new BroadcastChannel('folder-picker-channel');
  bc.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'FOLDER_CHUNK') {
      _folderChunks.push(...msg.files);
    } else if (msg.type === 'FOLDER_DONE') {
      reconstructAndProcessFiles(_folderChunks);
      _folderChunks = [];
    }
  };
}

function reconstructAndProcessFiles(fileDataList) {
  if (!fileDataList.length) return;

  const files = fileDataList.map(fd => {
    const file = new File([fd.buffer], fd.name, {
      type:         fd.type,
      lastModified: fd.lastModified
    });
    try {
      Object.defineProperty(file, 'webkitRelativePath', {
        value:        fd.path,
        writable:     false,
        enumerable:   true,
        configurable: true
      });
    } catch {
      file._relativePath = fd.path;
    }
    return file;
  });

  processSelectedFiles(files);
}

// ═══════════════════════════════════════════
// 构建商品列表
// ═══════════════════════════════════════════

function mergeAnalysisColumns(row) {
  const ec = userConfig?.exportColumnConfig || {};
  const cols = ec.columns || [];

  const parts = [];

  // 按导出列规则读取（先 analysis 后 prompts，保持原文顺序）
  const analysisCols = cols.filter(c => c.type === 'analysis');
  const promptCols   = cols.filter(c => c.type === 'prompts').sort((a, b) => (a.from || 0) - (b.from || 0));

  for (const col of analysisCols) {
    const t = String(row[col.name] || '').trim();
    if (t) parts.push(t);
  }
  for (const col of promptCols) {
    const t = String(row[col.name] || '').trim();
    if (t) parts.push(t);
  }

  // 兼容旧格式：分析结果, 分析结果_N, 提示词_N
  if (!parts.length) {
    const legacy = String(row['分析结果'] || '').trim();
    if (legacy) parts.push(legacy);
    for (let i = 2; i <= 10; i++) {
      const t = String(row[`分析结果_${i}`] || '').trim();
      if (t) parts.push(t);
    }
    for (let i = 1; i <= 20; i++) {
      const t = String(row[`提示词_${i}`] || '').trim();
      if (t) parts.push(t);
    }
  }

  return parts.join('\n\n');
}

function extractPromptsFromExcelRow(row) {
  const ec = userConfig?.exportColumnConfig || {};
  const cols = (ec.columns || []).filter(c => c.type === 'prompts' && c.useForImagegen !== false)
    .sort((a, b) => (a.from || 0) - (b.from || 0));

  if (!cols.length) return [];

  const allPrompts = [];
  for (const col of cols) {
    const text = String(row[col.name] || '').trim();
    if (!text) continue;
    const split = _splitPromptsFromText(text);
    if (split.length > 0) {
      allPrompts.push(...split);
    } else if (text.length > 10) {
      allPrompts.push(text);
    }
  }

  // 兼容旧格式列 提示词_N
  if (!allPrompts.length) {
    for (let i = 1; i <= 20; i++) {
      const text = String(row[`提示词_${i}`] || '').trim();
      if (!text) continue;
      const split = _splitPromptsFromText(text);
      if (split.length > 0) {
        allPrompts.push(...split);
      } else if (text.length > 10) {
        allPrompts.push(text);
      }
    }
  }

  return allPrompts;
}

function tryBuildProducts() {
  if (!excelData || !Object.keys(folderMap).length) return;

  const newProducts = [];

  excelData.forEach((row, idx) => {
    const folderName = String(row['文件夹名'] || '').trim();
    if (!folderName) return;

    const images   = folderMap[folderName] || [];
    const imgCount = images.length;

    const fields = {};
    Object.keys(row).forEach(col => {
      if (!isSystemCol(col)) {
        fields[col] = String(row[col] ?? '');
      }
    });

    let _icon = '⏸️', _warn = '';
    if (imgCount === 0) {
      _icon = '❌'; _warn = '无图片';
    } else if (imgCount < 5) {
      _icon = '⚠️'; _warn = `仅${imgCount}张`;
    }

    const excelStatus = String(row['状态'] || '待处理').trim();
    const excelPrompts = extractPromptsFromExcelRow(row);

    newProducts.push({
      index:            idx,
      name:             folderName,
      folderName,
      fields,
      images,
      imagesData:       [],
      imageCount:       imgCount,
      analysisResult:   mergeAnalysisColumns(row),
      promptText:       '',
      imagePrompts:     excelPrompts,
      totalSavedCount:  0,
      savedImages:      [],
      batches:          [],
      currentBatchIndex: 0,
      status:           excelStatus,
      errorMessage:     String(row['错误信息'] || ''),
      retryCount:       0,
      startTime:        null,
      endTime:          null,
      _icon,
      _warn
    });
  });

  products = newProducts;

  // 自动合并 storage 中保存的续传进度
  if (window._savedProgress?.length) {
    mergeProgress(window._savedProgress);
    window._savedProgress = null;
  }

  renderProductList();
  checkStartButton();
  checkResumePrompt();
}

// ═══════════════════════════════════════════
// 断点续传：恢复 storage 中的进度
// ═══════════════════════════════════════════

async function tryRestoreProgress() {
  return new Promise(resolve => {
    chrome.storage.local.get('taskProgress', result => {
      if (!result.taskProgress?.length) { resolve(); return; }

      const saved = result.taskProgress;
      // 如果products已构建，合并进度
      if (products.length > 0) {
        mergeProgress(saved);
      }
      // 否则等 tryBuildProducts 调用后由 mergeProgress 处理
      // 存储供后续使用
      window._savedProgress = saved;
      resolve();
    });
  });
}

function mergeProgress(savedProgress) {
  if (!savedProgress?.length) return;

  const MERGEABLE = new Set([
    '完成', '失败', '已跳过', '分析完成', '生图中', '分析中'
  ]);

  savedProgress.forEach(saved => {
    const p = products.find(x => x.folderName === saved.folderName);
    if (!p) return;
    if (!MERGEABLE.has(saved.status)) return;

    p.status            = saved.status;
    p.analysisResult    = saved.analysisResult    || p.analysisResult;
    p.imagePrompts      = saved.imagePrompts      || p.imagePrompts;
    p.promptText        = saved.promptText        || p.promptText;
    p.totalSavedCount   = saved.totalSavedCount   || p.totalSavedCount;
    p.savedImages       = saved.savedImages       || p.savedImages;
    p.errorMessage      = saved.errorMessage      || p.errorMessage;
    p.currentBatchIndex = saved.currentBatchIndex  || p.currentBatchIndex;
    if (saved._referenceImagesUploaded) {
      p._referenceImagesUploaded = true;
    }
    if (saved._promptSentBatches && typeof saved._promptSentBatches === 'object') {
      p._promptSentBatches = { ...p._promptSentBatches, ...saved._promptSentBatches };
    }
    if (saved._waitBaselineByBatch && typeof saved._waitBaselineByBatch === 'object') {
      p._waitBaselineByBatch = { ...p._waitBaselineByBatch, ...saved._waitBaselineByBatch };
    }
  });

  renderProductList();
}

// ═══════════════════════════════════════════
// 渲染商品列表
// ═══════════════════════════════════════════

const STATUS_STYLE = {
  '待处理':   { icon: '⏸️', cls: '' },
  '分析中':   { icon: '🔄', cls: 'status-processing' },
  '上传中':   { icon: '⬆️', cls: 'status-processing' },
  '分析完成': { icon: '✅', cls: 'status-done' },
  '生图中':   { icon: '🔄', cls: 'status-processing' },
  '完成':     { icon: '✅', cls: 'status-done' },
  '失败':     { icon: '❌', cls: 'status-failed' },
  '已跳过':   { icon: '⏭️', cls: 'status-skipped' }
};

function renderProductList() {
  const listEl   = $('productList');
  const summaryEl = $('productSummary');

  if (!products.length) {
    listEl.innerHTML = '<div class="empty-hint">请先选择Excel总表和商品文件夹</div>';
    summaryEl.style.display = 'none';
    return;
  }

  let warnCount = 0, errCount = 0;
  let html = '';

  products.forEach(p => {
    const si = STATUS_STYLE[p.status] || { icon: '⏸️', cls: '' };
    const displayIcon = p._icon !== '⏸️' ? p._icon : si.icon;
    if (p._icon === '⚠️') warnCount++;
    if (p._icon === '❌') errCount++;

    const imgText = p.imageCount === 0 ? '无图片'
      : p._warn ? p._warn
      : `✅ ${p.imageCount}张`;

    const failTip = p.status === '失败' && p.errorMessage
      ? ` title="${String(p.errorMessage).replace(/"/g, '&quot;')}"`
      : '';

    html += `
      <div class="product-item" data-index="${p.index}">
        <span class="product-icon">${displayIcon}</span>
        <span class="product-name" title="${p.folderName}">${p.folderName}</span>
        <span class="product-img-count">${imgText}</span>
        <span class="product-status-badge ${si.cls}"${failTip}>${p.status}</span>
      </div>`;
  });

  listEl.innerHTML = html;

  let summary = `共${products.length}个商品`;
  if (warnCount) summary += ` · ⚠️ ${warnCount}个图片偏少`;
  if (errCount)  summary += ` · ❌ ${errCount}个无图片`;

  const completedCount = products.filter(p => p.status === '完成').length;
  if (completedCount) summary += ` · ✅ ${completedCount}个已完成`;

  summaryEl.textContent = summary;
  summaryEl.style.display = 'block';
}

function updateProductItemStatus(productIndex, status) {
  const item = $('productList').querySelector(`[data-index="${productIndex}"]`);
  if (!item) return;

  const si = STATUS_STYLE[status] || { icon: '⏸️', cls: '' };
  const badge = item.querySelector('.product-status-badge');
  if (badge) {
    badge.textContent  = status;
    badge.className    = `product-status-badge ${si.cls}`;
  }
  const iconEl = item.querySelector('.product-icon');
  if (iconEl) iconEl.textContent = si.icon;
}

// ═══════════════════════════════════════════
// 配置相关
// ═══════════════════════════════════════════

function loadConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get('userConfig', r => {
      resolve(normalizeConfig(r.userConfig || getDefaultConfig()));
    });
  });
}

function getDefaultConfig() {
  const legacy = {
    selectedColumns: [],
    messageTemplate: '',
    extractConfig: {
      mode: 'marker',
      startMarker: 'GLOBAL FIXED CONSTRAINTS',
      endMarker: '',
      includeMarker: true
    },
    arenaConfig: {
      siteUrl: 'https://arena.ai',
      inputFeatures: null, uploadFeatures: null,
      sendFeatures: null,
      uploadLoadingSelector: '', uploadPreviewSelector: '',
      uploadErrorSelector:   '', uploadDeleteSelector:  '',
      verifyMode: 'loose', uploadTimeout: 120000, maxRetries: 3
    },
    doubaoConfig: {
      siteUrl: 'https://www.doubao.com',
      inputFeatures: null, uploadFeatures: null,
      sendFeatures: null,  imageAreaSelector: '',
      loadingSelector: '',
      uploadLoadingSelector: '', uploadPreviewSelector: '',
      uploadErrorSelector:   '', uploadDeleteSelector:  '',
      verifyMode: 'loose', uploadTimeout: 120000
    },
    imageGenConfig: {
      sendMode: 'batch', batchSize: 10,
      totalPrompts: 40, batchTimeout: 300000, maxRetries: 3
    }
  };

  return {
    ...legacy,
    version: '2.0',
    pipelineMode: 'both',
    sites: [
      { id: 'site_arena', name: 'Arena.ai', url: legacy.arenaConfig.siteUrl, role: 'analysis', enabled: true, order: 1, failAction: 'skip' },
      { id: 'site_doubao', name: '豆包', url: legacy.doubaoConfig.siteUrl, role: 'imagegen', enabled: true, order: 2, failAction: 'skip',
        imageGenConfig: { ...legacy.imageGenConfig },
        interceptorConfig: { matchKey: 'imageMeta', originalPath: 'original_urls[0]', thumbUrlPaths: ['thumb_urls[0]'], hookInPlaceReplace: false }
      }
    ],
    messageTemplates: [{
      id: 'tpl_default',
      name: '默认模板',
      selectedColumns: [],
      content: '',
      createdAt: new Date().toLocaleString('zh-CN'),
      lastModified: new Date().toLocaleString('zh-CN')
    }],
    activeTemplateId: 'tpl_default'
  };
}

function normalizeConfig(raw) {
  const base = getDefaultConfig();
  const advFromGlobal = raw?.globalConfig?.advancedConfig || {};
  const merged = {
    ...base,
    ...(raw || {}),
    arenaConfig: { ...base.arenaConfig, ...(raw?.arenaConfig || {}) },
    doubaoConfig: { ...base.doubaoConfig, ...(raw?.doubaoConfig || {}) },
    extractConfig: { ...base.extractConfig, ...(raw?.extractConfig || {}) },
    imageGenConfig: { ...base.imageGenConfig, ...(raw?.imageGenConfig || {}) },
    advancedConfig: {
      analysisFailAction: 'skip',
      imagegenFailAction: 'skip',
      claudeReplyTimeout: 180000,
      pageLoadTimeout: 30000,
      ...(raw?.advancedConfig || {}),
      ...advFromGlobal
    }
  };

  const templates = Array.isArray(merged.messageTemplates) && merged.messageTemplates.length
    ? merged.messageTemplates
    : [{
        id: 'tpl_default',
        name: '默认模板',
        selectedColumns: merged.selectedColumns || [],
        content: merged.messageTemplate || '',
        createdAt: new Date().toLocaleString('zh-CN'),
        lastModified: new Date().toLocaleString('zh-CN')
      }];

  merged.messageTemplates = templates;
  merged.activeTemplateId = merged.activeTemplateId || templates[0].id;
  const active = templates.find(t => t.id === merged.activeTemplateId) || templates[0];
  merged.selectedColumns = active.selectedColumns || merged.selectedColumns || [];
  merged.messageTemplate = active.content || merged.messageTemplate || '';
  if (!Array.isArray(merged.sites) || !merged.sites.length) {
    merged.sites = [
      { id: 'site_arena', name: 'Arena.ai', url: merged.arenaConfig?.siteUrl || 'https://arena.ai', role: 'analysis', enabled: true, order: 1 },
      { id: 'site_doubao', name: '豆包', url: merged.doubaoConfig?.siteUrl || 'https://www.doubao.com', role: 'imagegen', enabled: true, order: 2 }
    ];
  }
  // Migrate legacy features into site objects
  const featureKeys = ['inputFeatures', 'uploadFeatures', 'sendFeatures',
    'uploadLoadingFeatures', 'uploadPreviewFeatures', 'uploadDeleteFeatures',
    'imageAreaFeatures', 'loadingFeatures'];
  merged.sites.forEach(site => {
    const legacy = site.role === 'analysis' ? merged.arenaConfig
                 : site.role === 'imagegen' ? merged.doubaoConfig : null;
    if (!legacy) return;
    featureKeys.forEach(k => { if (!site[k] && legacy[k]) site[k] = legacy[k]; });
    ['verifyMode', 'uploadTimeout', 'maxRetries'].forEach(k => {
      if (site[k] === undefined && legacy[k] !== undefined) site[k] = legacy[k];
    });
    if (!site.url && legacy.siteUrl) site.url = legacy.siteUrl;
  });
  // Migrate failAction, imageGenConfig, interceptorConfig into each site
  const _failMap = merged.advancedConfig?.failActionBySite || {};
  merged.sites.forEach(site => {
    if (!site.failAction) {
      site.failAction = _failMap[site.id]
        || (site.role === 'analysis' ? (merged.advancedConfig?.analysisFailAction || 'skip')
            : site.role === 'imagegen' ? (merged.advancedConfig?.imagegenFailAction || 'skip')
            : 'skip');
    }
    if (site.role === 'imagegen') {
      if (!site.imageGenConfig) {
        site.imageGenConfig = { ...merged.imageGenConfig };
      } else {
        const igBase = { sendMode: 'batch', batchSize: 10, totalPrompts: 40, batchTimeout: 300000, maxRetries: 3 };
        site.imageGenConfig = { ...igBase, ...site.imageGenConfig };
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

  merged.globalConfig = {
    extractConfig: merged.extractConfig,
    imageGenConfig: merged.imageGenConfig,
    advancedConfig: merged.advancedConfig
  };
  return merged;
}

function getActiveTemplate(cfg) {
  const templates = cfg?.messageTemplates || [];
  if (!templates.length) return null;
  return templates.find(t => t.id === cfg.activeTemplateId) || templates[0];
}

function renderPipelineMode() {
  const mode = userConfig?.pipelineMode || 'both';
  const radio = document.querySelector(`[name="pipelineMode"][value="${mode}"]`);
  if (radio) radio.checked = true;
}

function handlePipelineModeChange() {
  const selected = document.querySelector('[name="pipelineMode"]:checked');
  if (!selected || !userConfig) return;
  userConfig.pipelineMode = selected.value;
  chrome.storage.local.set({ userConfig });
  updateSiteConfigStatus();
  checkStartButton();
}

function updateSiteConfigStatus() {
  if (!userConfig) return;
  const container = $('siteStatusList');
  if (!container) return;

  const pm = userConfig.pipelineMode || 'both';
  const needAnalysis = pm === 'both' || pm === 'analysis_only';
  const needImagegen = pm === 'both' || pm === 'imagegen_only';

  // 先清理并保证存在活动选择
  if (!userConfig.activeSiteSelection || typeof userConfig.activeSiteSelection !== 'object') {
    userConfig.activeSiteSelection = {};
  }

  const hasFeatures = (site) => {
    if (!site) return false;
    const stepsOk = Array.isArray(site.operationSteps) && site.operationSteps.length > 0 &&
      ['input', 'send'].every(t => site.operationSteps.some(s => s.type === t && s.features));
    return stepsOk || !!(site.inputFeatures && site.sendFeatures);
  };

  const allEnabled = (userConfig.sites || []).filter(s => s.enabled !== false);

  const roles = [
    { key: 'analysis', label: '📊 分析站点', needed: needAnalysis, legacy: userConfig.arenaConfig },
    { key: 'imagegen', label: '🎨 生图站点', needed: needImagegen, legacy: userConfig.doubaoConfig }
  ];

  // 归一化：若当前选中站点已被删除/禁用/换角色，自动回落到首个可用
  let dirty = false;
  roles.forEach(r => {
    const list = allEnabled.filter(s => s.role === r.key);
    const current = userConfig.activeSiteSelection[r.key];
    const stillValid = current && list.some(s => s.id === current);
    if (!stillValid) {
      const next = list[0]?.id || '';
      if (userConfig.activeSiteSelection[r.key] !== next) {
        userConfig.activeSiteSelection[r.key] = next;
        dirty = true;
      }
    }
  });
  if (dirty) chrome.storage.local.set({ userConfig });

  const html = roles.map(r => {
    if (!r.needed) {
      return `
        <div class="site-status-group">
          <div class="site-status-head">
            <span class="site-status-role">${r.label}</span>
            <span class="status-badge status-skip">⏭️ 未启用</span>
          </div>
        </div>`;
    }
    const list = allEnabled.filter(s => s.role === r.key);
    if (list.length === 0) {
      // 特殊回退：老配置可能只有 legacy.xxxConfig 没有 sites 条目
      const legacyOk = !!(r.legacy?.inputFeatures && r.legacy?.sendFeatures);
      return `
        <div class="site-status-group">
          <div class="site-status-head">
            <span class="site-status-role">${r.label}</span>
            <span class="status-badge ${legacyOk ? 'status-ok' : 'status-warn'}">
              ${legacyOk ? '✅ 已配置（旧版）' : '⚠️ 未添加'}
            </span>
          </div>
          ${legacyOk ? '' : '<div class="site-status-hint">请在设置中添加该角色的站点</div>'}
        </div>`;
    }

    const selected = userConfig.activeSiteSelection[r.key] || list[0]?.id || '';

    const rows = list.map(site => {
      const ok = hasFeatures(site);
      const disabled = !ok;
      const isChecked = site.id === selected;
      return `
        <label class="site-pick-row${disabled ? ' disabled' : ''}" title="${disabled ? '此站点尚未完成元素配置' : ''}">
          <input type="radio"
                 name="activeSite_${r.key}"
                 value="${site.id}"
                 ${isChecked ? 'checked' : ''}
                 ${disabled ? 'disabled' : ''}>
          <span class="site-pick-name">${escapeHtmlLight(site.name || site.url || site.id)}</span>
          <span class="status-badge ${ok ? 'status-ok' : 'status-warn'}">${ok ? '✅ 已配置' : '⚠️ 未配置'}</span>
        </label>`;
    }).join('');

    const hint = list.length > 1 ? '（多个已添加，点选其一用于本次任务）' : '';
    return `
      <div class="site-status-group">
        <div class="site-status-head">
          <span class="site-status-role">${r.label}</span>
          <span class="site-status-hint">${hint}</span>
        </div>
        ${rows}
      </div>`;
  }).join('');

  container.innerHTML = html;

  // 绑定单选 → 持久化
  container.querySelectorAll('input[type="radio"][name^="activeSite_"]').forEach(el => {
    el.addEventListener('change', () => {
      if (!el.checked) return;
      const role = el.name.replace('activeSite_', '');
      userConfig.activeSiteSelection = userConfig.activeSiteSelection || {};
      userConfig.activeSiteSelection[role] = el.value;
      chrome.storage.local.set({ userConfig });
      checkStartButton();
    });
  });
}

function escapeHtmlLight(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function checkStartButton() {
  const hasUsable = products.some(p =>
    p.imageCount > 0 && ['待处理', '分析中', '分析完成'].includes(p.status)
  );
  const configured = !!buildPrecheckResult().passed;

  $('btnStart').disabled = !(hasUsable && configured && !taskRunning);
}

// ═══════════════════════════════════════════
// 任务控制
// ═══════════════════════════════════════════

async function handleStart() {
  if (taskRunning) return;

  // ── 商业版：登录 + 额度检查 ──
  const loggedIn = await AuthUI.ensureLoggedIn();
  if (!loggedIn) return;

  const quotaResult = await AuthUI.checkQuota();
  if (!quotaResult.ok) return;

  const pre = runPrecheckAndShow(false);
  if (!pre.passed) return;

  // 检查配置
  const _pm = userConfig?.pipelineMode || 'both';
  const _needA = _pm === 'both' || _pm === 'analysis_only';
  const _needI = _pm === 'both' || _pm === 'imagegen_only';

  if (_needA) {
    const _aSite = pickSiteByRole('analysis');
    if (!_aSite?.inputFeatures && !userConfig?.arenaConfig?.inputFeatures) {
      showAlert('warn', '请先在设置页面完成分析网站的元素配置', {
        text: '前往设置', handler: openSettings
      });
      return;
    }
  }

  if (_needI) {
    const _iSite = pickSiteByRole('imagegen');
    if (!_iSite?.inputFeatures && !userConfig?.doubaoConfig?.inputFeatures) {
      showAlert('warn', '请先在设置页面完成生图网站的元素配置', {
        text: '前往设置', handler: openSettings
      });
      return;
    }
  }

  // 检查消息模板（分析模式需要模板）
  if (_needA) {
    const activeTpl = getActiveTemplate(userConfig);
    const hasTemplateContent = !!(activeTpl?.content?.trim() || userConfig.messageTemplate?.trim());
    const hasColumns = !!(activeTpl?.selectedColumns?.length || userConfig.selectedColumns?.length);
    if (!hasTemplateContent && !hasColumns) {
      showAlert('warn', '请先在设置页面配置Claude消息模板或选择Excel列');
      return;
    }
  }

  showAlert('info', '⏳ 正在准备图片数据，请稍候...');

  try {
    await prepareImagesData();
  } catch (err) {
    showAlert('error', '图片数据准备失败：' + err.message);
    return;
  }

  // 先验证后台服务是否就绪
  showAlert('info', '⏳ 正在连接后台服务...');
  try {
    const pong = await chrome.runtime.sendMessage({ type: 'PING' });
    if (!pong?.ok) throw new Error('后台服务未就绪');
  } catch (err) {
    showAlert('error', '无法连接后台服务，请尝试：\n1. 在扩展管理页面禁用后重新启用此扩展\n2. 刷新当前页面后重试');
    return;
  }

  const toProcess = products.filter(p =>
    p.imageCount > 0 && ['待处理', '分析中', '分析完成'].includes(p.status)
  );

  // 重新从 storage 加载最新配置（用户可能在设置页面修改过）
  userConfig = await loadConfig();

  // 发送启动消息并等待确认
  showAlert('info', '⏳ 正在启动任务...');
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'START',
      data: {
        products: toProcess.map(serializeProduct),
        config:   userConfig
      }
    });

    if (!resp?.ok) {
      throw new Error(resp?.error || '后台启动任务失败');
    }
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes('Could not serialize') || msg.includes('message length') ||
        msg.includes('Message length exceeded') || msg.includes('DataCloneError')) {
      showAlert('error', '启动失败：数据量过大无法传输。\n请尝试减少商品数量或图片数量后重试。');
    } else {
      showAlert('error', '启动失败：' + msg);
    }
    return;
  }

  hideAlert();
  taskRunning = true;
  taskPaused  = false;
  startStatsTimer();

  $('btnStart').disabled = true;
  $('btnPause').disabled = false;
  $('btnSkip').disabled  = false;
  $('btnStop').disabled  = false;
  $('progressSection').style.display = 'block';
}

function runPrecheckAndShow(showSuccess = true) {
  const result = buildPrecheckResult();
  if (!result.passed) {
    showAlert('error', `预检失败（${result.errors.length}项）\n${result.errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}`);
    return result;
  }
  if (result.warnings.length) {
    showAlert('warn', `预检通过，但有${result.warnings.length}条警告：\n${result.warnings.map((w, i) => `${i + 1}. ${w}`).join('\n')}`);
    return result;
  }
  if (showSuccess) showAlert('info', '✅ 预检通过，可以开始任务');
  return result;
}

function buildPrecheckResult() {
  const errors = [];
  const warnings = [];

  if (!excelData?.length) errors.push('未选择或未成功读取 Excel 总表');
  if (!Object.keys(folderMap || {}).length) errors.push('未选择商品文件夹');
  if (!products.length) errors.push('商品列表为空，无法启动任务');

  const activeTpl = getActiveTemplate(userConfig);
  if (!activeTpl) {
    errors.push('未找到可用的消息模板');
  } else {
    if (!activeTpl.content?.trim()) errors.push('当前消息模板内容为空');
    const headers = excelData?.[0] ? Object.keys(excelData[0]) : [];
    (activeTpl.selectedColumns || []).forEach(col => {
      if (!headers.includes(col)) warnings.push(`模板列 "${col}" 在Excel中不存在，发送时将跳过`);
    });
  }

  const pm = userConfig?.pipelineMode || 'both';
  const needAnalysis = pm === 'both' || pm === 'analysis_only';
  const needImagegen = pm === 'both' || pm === 'imagegen_only';

  const hasFeatures = (site, legacy) =>
    (site?.inputFeatures || legacy?.inputFeatures) &&
    (site?.uploadFeatures || legacy?.uploadFeatures) &&
    (site?.sendFeatures || legacy?.sendFeatures);

  if (needAnalysis) {
    const analysisSite = pickSiteByRole('analysis');
    if (!analysisSite) {
      errors.push('未配置启用的分析网站（role=analysis）');
    } else if (!hasFeatures(analysisSite, userConfig?.arenaConfig)) {
      if (!analysisSite?.inputFeatures && !userConfig?.arenaConfig?.inputFeatures) errors.push('分析网站输入框未配置');
      if (!analysisSite?.uploadFeatures && !userConfig?.arenaConfig?.uploadFeatures) errors.push('分析网站上传按钮未配置');
      if (!analysisSite?.sendFeatures && !userConfig?.arenaConfig?.sendFeatures) errors.push('分析网站发送按钮未配置');
    }
  }

  if (needImagegen) {
    const imagegenSite = pickSiteByRole('imagegen');
    if (!imagegenSite) {
      errors.push('未配置启用的生图网站（role=imagegen）');
    } else if (!hasFeatures(imagegenSite, userConfig?.doubaoConfig)) {
      if (!imagegenSite?.inputFeatures && !userConfig?.doubaoConfig?.inputFeatures) errors.push('生图网站输入框未配置');
      if (!imagegenSite?.uploadFeatures && !userConfig?.doubaoConfig?.uploadFeatures) errors.push('生图网站上传按钮未配置');
      if (!imagegenSite?.sendFeatures && !userConfig?.doubaoConfig?.sendFeatures) errors.push('生图网站发送按钮未配置');
    }
  }

  const noImageProducts = products.filter(p => p.imageCount === 0);
  const lowImageProducts = products.filter(p => p.imageCount > 0 && p.imageCount < 3);
  if (noImageProducts.length) warnings.push(`${noImageProducts.length}个商品无图片，运行时会跳过`);
  if (lowImageProducts.length) warnings.push(`${lowImageProducts.length}个商品图片较少（<3）`);

  return { passed: errors.length === 0, errors, warnings };
}

function pickSiteByRole(role) {
  const sites = (userConfig?.sites || []).filter(s => s.enabled !== false);
  sites.sort((a, b) => (a.order || 999) - (b.order || 999));
  // 优先使用用户的活动选择
  const chosenId = userConfig?.activeSiteSelection?.[role];
  if (chosenId) {
    const chosen = sites.find(s => s.role === role && s.id === chosenId);
    if (chosen) return chosen;
  }
  return sites.find(s => s.role === role) || null;
}

async function prepareImagesData() {
  const inferMimeType = (file) => {
    if (file.type && file.type.startsWith('image/')) return file.type;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
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

  for (const p of products) {
    if (!p.images?.length) { p.imagesData = []; continue; }
    if (p.imagesData?.length) continue;  // 已转换，跳过

    p.imagesData = await Promise.all(
      p.images.map(async f => {
        const ab = await f.arrayBuffer();
        return {
          buffer: new Uint8Array(ab),
          name:   f.name,
          type:   inferMimeType(f)
        };
      })
    );
  }
}

function serializeProduct(p) {
  return {
    index:            p.index,
    name:             p.name,
    folderName:       p.folderName,
    fields:           p.fields,
    imagesData:       (p.imagesData || []).map(img => ({
      buffer: uint8ToBase64(img.buffer),
      name:   img.name,
      type:   img.type
    })),
    imageCount:       p.imageCount,
    analysisResult:   p.analysisResult,
    promptText:       p.promptText,
    imagePrompts:     p.imagePrompts,
    totalSavedCount:  p.totalSavedCount,
    savedImages:      p.savedImages,
    batches:          p.batches,
    currentBatchIndex: p.currentBatchIndex,
    status:           p.status,
    errorMessage:     p.errorMessage,
    retryCount:       p.retryCount,
    _referenceImagesUploaded: p._referenceImagesUploaded || false,
    _promptSentBatches:       p._promptSentBatches || null,
    _waitBaselineByBatch:     p._waitBaselineByBatch || null
  };
}

function uint8ToBase64(uint8) {
  if (!uint8 || !uint8.length) return '';
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < uint8.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, uint8.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function handlePause() {
  if (!taskRunning) return;

  if (taskPaused) {
    taskPaused = false;
    $('btnPause').textContent = '⏸️ 暂停';
    chrome.runtime.sendMessage({ type: 'RESUME' });
  } else {
    taskPaused = true;
    $('btnPause').textContent = '▶️ 继续';
    chrome.runtime.sendMessage({ type: 'PAUSE' });
  }
}

function handleSkip() {
  chrome.runtime.sendMessage({ type: 'SKIP' });
  showAlert('info', '已发送跳过指令，当前操作完成后跳过');
}

function handleStop() {
  if (!confirm('确定要停止任务吗？进度已自动保存，下次可继续。')) return;

  taskRunning = false;
  taskPaused  = false;

  $('btnStart').disabled = false;
  $('btnPause').disabled = true;
  $('btnSkip').disabled  = true;
  $('btnStop').disabled  = true;
  $('btnPause').textContent = '⏸️ 暂停';

  chrome.runtime.sendMessage({ type: 'STOP' }, () => {
    stopStatsTimer();
    updateExportBarVisibility();
    if (chrome.runtime.lastError) {
      showAlert('warn', '停止指令可能未送达后台，若任务仍在运行请再点一次停止或刷新侧栏后重试');
      return;
    }
    showAlert('info', '✅ 任务已停止，进度已保存');
  });
}

function handleReset() {
  if (!confirm('确定要重置任务吗？所有进度将被清除，商品状态恢复为"待处理"。')) return;

  if (taskRunning) {
    taskRunning = false;
    taskPaused  = false;
    chrome.runtime.sendMessage({ type: 'STOP' });
  }

  $('btnStart').disabled = false;
  $('btnPause').disabled = true;
  $('btnSkip').disabled  = true;
  $('btnStop').disabled  = true;
  $('btnPause').textContent = '⏸️ 暂停';
  stopStatsTimer();

  chrome.storage.local.remove('taskProgress');
  window._savedProgress = null;

  products.forEach(p => {
    p.status = '待处理';
    delete p.currentBatchIndex;
    delete p._referenceImagesUploaded;
    delete p._promptSentBatches;
    delete p._waitBaselineByBatch;
    delete p.batches;
    p.totalSavedCount = 0;
    p.savedImages     = [];
    delete p.analysisResult;
    delete p.extractedPrompts;
  });

  renderProductList();
  checkStartButton();
  updateExportBarVisibility();
  showAlert('info', '✅ 任务已重置，所有商品恢复为待处理状态');
}

// ═══════════════════════════════════════════
// 消息处理
// ═══════════════════════════════════════════

function handleMessage(msg) {
  if (!msg?.type) return;

  switch (msg.type) {

    case 'PROGRESS_UPDATE':
      handleProgressUpdate(msg);
      break;

    case 'UPLOAD_PROGRESS':
      handleUploadProgress(msg.data);
      break;

    case 'IMAGE_GEN_PROGRESS':
      handleImageGenProgress(msg.data);
      break;

    case 'ERROR':
      handleError(msg);
      break;

    case 'NEED_ACTION':
      handleNeedAction(msg.data);
      break;

    case 'COMPLETE':
      handleComplete();
      break;

    case 'PRODUCT_STATUS_CHANGED': {
      const d = msg.data || {};
      const p = products.find(x => x.index === d.index);
      if (p) {
        p.status = d.status;
        if (d.analysisResult)       p.analysisResult = d.analysisResult;
        if (d.imagePrompts?.length) p.imagePrompts   = d.imagePrompts;
        if (d.promptText)           p.promptText     = d.promptText;
        if (d.errorMessage)         p.errorMessage   = d.errorMessage;
      }
      updateProductItemStatus(d.index, d.status);
      updateExportBarVisibility();
      updateStats();
      break;
    }

    case 'PIPELINE_A_DONE':
      setStageText('arenaStageText', '分析完成，等待豆包生图...');
      break;

    case 'LOG':
      if (msg.data) appendLog(msg.data);
      break;

    case 'TASK_STOPPED':
      taskRunning = false;
      taskPaused  = false;
      $('btnStart').disabled = false;
      $('btnPause').disabled = true;
      $('btnSkip').disabled  = true;
      $('btnStop').disabled  = true;
      $('btnPause').textContent = '⏸️ 暂停';
      stopStatsTimer();
      updateExportBarVisibility();
      checkStartButton();
      break;
  }
}

function handleProgressUpdate(msg) {
  const { pipeline, data } = msg;

  if (pipeline === 'analysis') {
    const stageLabels = {
      switching:  '切换标签页...',
      uploading:  '上传图片...',
      sending:    '发送分析请求...',
      waiting:    '等待Claude回复...',
      extracting: '提取提示词...',
      saving:     '保存数据...',
      done:       '完成'
    };

    setStageText(
      'arenaStageText',
      `${data.productName}（${data.productIndex + 1}/${data.total}）${stageLabels[data.stage] || ''}`
    );

    const pct = data.total > 0
      ? Math.round((data.productIndex / data.total) * 100) : 0;
    setProgressBar('arenaTotalFill', pct);
    setTextContent('arenaTotalText', `${data.productIndex}/${data.total}`);

    // 上传阶段显示上传进度条
    const uploadWrap = $('arenaUploadWrap');
    if (uploadWrap) {
      uploadWrap.style.display = data.stage === 'uploading' ? 'flex' : 'none';
    }
  }

  if (pipeline === 'image') {
    const stageLabels = {
      uploading:   '上传参考图...',
      sending:     '发送提示词...',
      generating:  '生成中...',
      downloading: '下载保存...',
      done:        '本批完成'
    };

    setStageText(
      'doubaoStageText',
      `${data.productName} 第${data.batchCurrent}/${data.batchTotal}批 ${stageLabels[data.stage] || ''}`
    );

    const pct = data.promptsTotal > 0
      ? Math.round((data.imagesSaved / data.promptsTotal) * 100) : 0;
    setProgressBar('doubaoImageFill', pct);
    setTextContent('doubaoImageText', `${data.imagesSaved}/${data.promptsTotal}张`);
  }
}

function handleUploadProgress(data) {
  if (!data) return;
  const pct = data.expectedCount > 0
    ? Math.round((data.previewCount / data.expectedCount) * 100) : 0;
  setProgressBar('arenaUploadFill', pct);
  setTextContent('arenaUploadText', `${data.previewCount}/${data.expectedCount}张`);
}

function handleImageGenProgress(data) {
  if (!data) return;
  // 豆包实时生成进度（补充更新）
  const pct = data.newImages > 0 ? Math.min(100, data.newImages * 2.5) : 0;
  setProgressBar('doubaoImageFill', pct);
}

function handleError(msg) {
  const { pipeline, data } = msg;
  const site = pipeline === 'analysis' ? 'Arena.ai'
    : pipeline === 'image' ? '豆包'
    : '系统';
  showAlert('error',
    `[${site}] ${data?.productName || ''}：${data?.message || '未知错误'}`
  );
}

function handleNeedAction(data) {
  showAlert('warn', data.message, {
    text: '前往设置',
    handler: openSettings
  });
}

function handleComplete() {
  taskRunning = false;
  taskPaused  = false;
  stopStatsTimer();

  $('btnStart').disabled = false;
  $('btnPause').disabled = true;
  $('btnSkip').disabled  = true;
  $('btnStop').disabled  = true;
  $('btnPause').textContent = '⏸️ 暂停';

  setStageText('arenaStageText', '✅ 全部完成');
  setStageText('doubaoStageText', '✅ 全部完成');
  setProgressBar('arenaTotalFill', 100);
  setProgressBar('doubaoImageFill', 100);

  updateExportBarVisibility();

  // 自动导出 Excel
  const hasResults = products.some(p => p.analysisResult);
  if (hasResults && excelData?.length) {
    showAlert('info', '🎉 全部商品处理完成！正在自动导出Excel...');
    setTimeout(() => {
      try {
        exportResults();
      } catch (e) {
        showAlert('error', '自动导出失败：' + e.message + '，请手动点击导出按钮');
      }
    }, 500);
  } else {
    showAlert('info', '🎉 全部商品处理完成！点击下方"导出结果到Excel"保存分析结果');
  }
}

// ═══════════════════════════════════════════
// Excel导出
// ═══════════════════════════════════════════

function updateExportBarVisibility() {
  const bar = $('exportBar');
  if (!bar) return;
  const hasResults = products.some(p =>
    p.analysisResult || ['完成', '分析完成', '失败', '已跳过'].includes(p.status)
  );
  bar.style.display = hasResults ? 'flex' : 'none';
}

/** 按「每行一个正则」拆成多条（与设置页 / 后台 extract 逻辑一致） */
function _splitByCustomPatternLines(text, patternMultiline) {
  if (!text || !patternMultiline?.trim()) return [];
  const parts = patternMultiline.split('\n').map(l => l.trim()).filter(Boolean);
  if (!parts.length) return [];
  const combined = parts.map(p => '(?:' + p + ')').join('|');
  let re;
  try {
    re = new RegExp('^\\s*(?:' + combined + ')', 'im');
  } catch (_) {
    return [];
  }
  const lines = text.split('\n');
  const prompts = [];
  let cur = '';
  for (const line of lines) {
    if (re.test(line)) {
      if (cur.trim()) prompts.push(cur.trim());
      cur = line.trim();  // 标题行保留为新提示词的首行
    } else {
      cur += (cur ? '\n' : '') + line.trim();
    }
  }
  if (cur.trim()) prompts.push(cur.trim());
  return prompts.filter(p => p.length > 5);
}

/** 自动识别：Shot/Prompt/Image/Scene/Frame/... + 数字/中文序号等 */
function _splitPromptsByAutoHeaders(text) {
  if (!text) return [];
  // 保持与 background/content 里的识别规则一致：
  //   1. / 1、/ 1) / 1:  |  一、/ 一.  |  Shot 1 / Prompt 2 / Image 3 / Scene N / Frame N / ...
  const kw = 'Shot|Prompt|Image|Scene|Frame|Pic|Picture|Photo|Camera|Cut|Angle|View';
  const headerRe = new RegExp(
    '^\\s*(?:' +
      '(?:' + kw + ')\\s*\\d+\\s*[\\-\\.、\\)\\:：]?\\s*' +
      '|' +
      '\\d{1,3}\\s*[\\.、\\)\\:：]\\s' +
      '|' +
      '[一二三四五六七八九十百千]+\\s*[、\\.]\\s*' +
    ')',
    'im'
  );
  const lines = text.split('\n');
  const prompts = [];
  let cur = '';
  for (const line of lines) {
    if (headerRe.test(line) && cur.trim()) {
      prompts.push(cur.trim());
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur.trim()) prompts.push(cur.trim());
  return prompts.filter(p => p.length > 10);
}

/**
 * 本地提示词拆分：使用通用分条规则将文本拆分为独立提示词。
 * 优先使用 extractConfig 中的自定义规则，兜底自动识别。
 */
function _splitPromptsFromText(text) {
  if (!text) return [];

  const ec = userConfig?.extractConfig || {};
  if (ec.promptSplitMode === 'custom' && ec.promptSplitPattern?.trim()) {
    const out = _splitByCustomPatternLines(text, ec.promptSplitPattern);
    if (out.length > 1) return out;
  }

  return _splitPromptsByAutoHeaders(text);
}

function exportResults() {
  if (!excelData?.length || !products?.length) {
    showAlert('warn', '没有可导出的数据，请先选择Excel并运行任务');
    return;
  }

  // ── 商业版：导出功能需要 Pro ──
  AuthUI.checkFeature('canExport').then((allowed) => {
    if (allowed) doExportResults();
  });
}

function doExportResults() {
  if (!excelData?.length || !products?.length) return;

  try {
    const EXCEL_CELL_LIMIT = 32000;
    const ec = userConfig?.exportColumnConfig || {};
    const sectionMarker = ec.sectionMarker || '第二部分';
    const colRules = ec.columns || [];

    const updatedRows = excelData.map(row => {
      const folderName = String(row['文件夹名'] || '').trim();
      const product = products.find(p => p.folderName === folderName);
      const newRow = { ...row };

      // 清理所有规则定义的列 + 旧格式列
      delete newRow['分析结果'];
      for (let c = 2; c <= 10; c++) delete newRow[`分析结果_${c}`];
      colRules.forEach(r => delete newRow[r.name]);

      if (product) {
        const fullText = product.analysisResult || '';
        let prompts    = product.imagePrompts   || [];

        // 按分段标记拆分两部分
        let analysisPart = fullText;
        let promptsPart  = '';
        if (sectionMarker && fullText.includes(sectionMarker)) {
          const idx = fullText.indexOf(sectionMarker);
          analysisPart = fullText.slice(0, idx).trim();
          promptsPart  = fullText.slice(idx).trim();
          // 去除提示词部分的标题行（如"第二部分：40条生图提示词"）
          const titleEnd = promptsPart.indexOf('\n');
          if (titleEnd !== -1) promptsPart = promptsPart.slice(titleEnd + 1).trim();
        }

        // 如果提示词未拆分（为空或只有1项大块文本），尝试本地重新解析
        const needResplit = !prompts.length ||
          (prompts.length === 1 && prompts[0].length > 500);
        if (needResplit) {
          const textToSplit = promptsPart || (prompts.length === 1 ? prompts[0] : '');
          if (textToSplit) {
            const reSplit = _splitPromptsFromText(textToSplit);
            if (reSplit.length > 1) prompts = reSplit;
          }
        }

        // 按列规则逐一填充
        for (const rule of colRules) {
          if (rule.type === 'analysis') {
            const text = analysisPart || '';
            newRow[rule.name] = text.length <= EXCEL_CELL_LIMIT
              ? text
              : text.slice(0, EXCEL_CELL_LIMIT);
          } else if (rule.type === 'prompts') {
            const from = (rule.from || 1) - 1;
            const to   = rule.to || 10;
            if (prompts.length > 0) {
              const chunk = prompts.slice(from, to);
              newRow[rule.name] = chunk.join('\n\n');
            }
          }
        }

        newRow['状态']     = product.status       || row['状态']     || '';
        newRow['错误信息'] = product.errorMessage  || row['错误信息'] || '';
      }
      return newRow;
    });

    // 安全截断：确保所有单元格不超过 Excel 32767 字符限制
    const HARD_LIMIT = 32767;
    for (const row of updatedRows) {
      for (const key of Object.keys(row)) {
        if (typeof row[key] === 'string' && row[key].length > HARD_LIMIT) {
          row[key] = row[key].slice(0, HARD_LIMIT - 3) + '...';
        }
      }
    }

    const ws = XLSX.utils.json_to_sheet(updatedRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });

    const blob = new Blob([wbout], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    const url = URL.createObjectURL(blob);

    const ts = new Date().toISOString().slice(0, 10);
    const a  = document.createElement('a');
    a.href     = url;
    a.download = `商品信息总表_结果_${ts}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    showAlert('info', '✅ Excel导出成功');
  } catch (err) {
    showAlert('error', '导出失败：' + err.message);
  }
}

// ═══════════════════════════════════════════
// UI 工具函数
// ═══════════════════════════════════════════

function setFileStatus(id, text, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = `file-status${cls ? ' ' + cls : ''}`;
}

function setStageText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setTextContent(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setProgressBar(id, pct) {
  const el = $(id);
  if (el) el.style.width = Math.min(100, Math.max(0, pct)) + '%';
}

let _alertActionCb = null;

function showAlert(type, message, action = null) {
  const box     = $('alertBox');
  const content = $('alertContent');
  const btn     = $('alertAction');

  box.className = `alert-box${type === 'error' ? ' error' : ''}`;
  content.textContent = message;
  box.style.display = 'flex';

  _alertActionCb = null;
  if (action) {
    btn.textContent   = action.text;
    btn.style.display = 'inline-block';
    _alertActionCb    = action.handler;
  } else {
    btn.style.display = 'none';
  }
}

function hideAlert() {
  $('alertBox').style.display = 'none';
}

function handleAlertAction() {
  if (_alertActionCb) _alertActionCb();
}

// ═══════════════════════════════════════════
// 任务统计
// ═══════════════════════════════════════════

let taskStartTime = null;
let statsTimerId  = null;

function updateStats() {
  if (!products.length) {
    const sec = $('statsSection');
    if (sec) sec.style.display = 'none';
    return;
  }

  const sec = $('statsSection');
  if (sec) sec.style.display = 'block';

  const total   = products.length;
  const done    = products.filter(p => p.status === '完成').length;
  const failed  = products.filter(p => p.status === '失败').length;
  const skipped = products.filter(p => p.status === '已跳过').length;
  const pending = total - done - failed - skipped;

  setTextContent('statTotal', String(total));
  setTextContent('statDone', String(done));
  setTextContent('statFailed', String(failed));
  setTextContent('statSkipped', String(skipped));
  setTextContent('statPending', String(pending));

  if (taskStartTime) {
    const elapsed = Date.now() - taskStartTime;
    setTextContent('statElapsed', formatElapsed(elapsed));
  }

  const pctDone = total ? (done / total * 100) : 0;
  const pctFail = total ? (failed / total * 100) : 0;
  const pctSkip = total ? (skipped / total * 100) : 0;

  const barDone = $('statsBarDone');
  const barFail = $('statsBarFail');
  const barSkip = $('statsBarSkip');
  if (barDone) barDone.style.width = pctDone + '%';
  if (barFail) barFail.style.width = pctFail + '%';
  if (barSkip) barSkip.style.width = pctSkip + '%';
}

function formatElapsed(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}分${remSec}秒`;
  const hr = Math.floor(min / 60);
  return `${hr}时${min % 60}分`;
}

function startStatsTimer() {
  taskStartTime = Date.now();
  stopStatsTimer();
  statsTimerId = setInterval(updateStats, 2000);
  updateStats();
}

function stopStatsTimer() {
  if (statsTimerId) {
    clearInterval(statsTimerId);
    statsTimerId = null;
  }
  updateStats();
}

// ═══════════════════════════════════════════
// 模板快速切换
// ═══════════════════════════════════════════

function renderTplSwitcher() {
  const sel = $('tplSwitcher');
  const info = $('tplInfo');
  if (!sel || !userConfig) return;

  const templates = userConfig.messageTemplates || [];
  if (!templates.length) {
    sel.innerHTML = '<option value="">无模板</option>';
    if (info) info.textContent = '';
    return;
  }

  const activeId = userConfig.activeTemplateId || templates[0].id;
  sel.innerHTML = templates.map(t =>
    `<option value="${t.id}" ${t.id === activeId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
  ).join('');

  const active = templates.find(t => t.id === activeId) || templates[0];
  const colCount = (active.selectedColumns || []).length;
  const hasContent = !!(active.content?.trim());
  if (info) {
    info.textContent = `${colCount}列${hasContent ? ' · 有内容' : ' · 空模板'}`;
  }
}

function handleTplSwitch(e) {
  const tplId = e.target.value;
  if (!tplId || !userConfig) return;

  const tpl = (userConfig.messageTemplates || []).find(t => t.id === tplId);
  if (!tpl) return;

  userConfig.activeTemplateId = tpl.id;
  userConfig.selectedColumns = tpl.selectedColumns || [];
  userConfig.messageTemplate = tpl.content || '';

  chrome.storage.local.set({ userConfig });
  renderTplSwitcher();
  checkStartButton();
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ═══════════════════════════════════════════
// 断点续传恢复提示
// ═══════════════════════════════════════════

function checkResumePrompt() {
  if (!products.length) return;

  const done   = products.filter(p => p.status === '完成').length;
  const failed = products.filter(p => p.status === '失败').length;
  const skip   = products.filter(p => p.status === '已跳过').length;
  const inProg = products.filter(p =>
    ['分析中', '分析完成', '生图中'].includes(p.status)
  ).length;
  const settled = done + failed + skip;

  if (settled === 0 && inProg === 0) return;
  if (settled === products.length) return;

  const remaining = products.length - settled;
  const parts = [];
  if (done)   parts.push(`${done}个已完成`);
  if (failed) parts.push(`${failed}个失败`);
  if (skip)   parts.push(`${skip}个已跳过`);
  if (inProg) parts.push(`${inProg}个处理中被中断`);

  showAlert('info',
    `检测到上次任务进度：${parts.join('、')}，剩余${remaining}个待处理。\n选择文件后可点击"开始"继续处理。`,
    { text: '清除进度', handler: clearSavedProgress }
  );
}

function clearSavedProgress() {
  chrome.storage.local.remove('taskProgress', () => {
    products.forEach(p => {
      if (['分析中', '分析完成', '生图中'].includes(p.status)) {
        p.status = '待处理';
      }
      delete p.currentBatchIndex;
      delete p._referenceImagesUploaded;
      delete p._promptSentBatches;
      delete p._waitBaselineByBatch;
      delete p.batches;
      p.totalSavedCount = 0;
      p.savedImages     = [];
    });
    renderProductList();
    hideAlert();
    checkStartButton();
  });
}

// ═══════════════════════════════════════════
// 操作日志面板
// ═══════════════════════════════════════════

const MAX_LOG_ENTRIES = 200;
let logCollapsed = false;

function appendLog(entry) {
  const list = $('logList');
  if (!list) return;

  const levelCls = {
    info: 'log-info',
    warn: 'log-warn',
    error: 'log-error'
  }[entry.level] || 'log-info';

  const levelIcon = {
    info: 'ℹ️',
    warn: '⚠️',
    error: '❌'
  }[entry.level] || 'ℹ️';

  const div = document.createElement('div');
  div.className = `log-entry ${levelCls}`;
  div.innerHTML =
    `<span class="log-time">${escapeHtml(entry.time || '')}</span>` +
    `<span class="log-icon">${levelIcon}</span>` +
    (entry.site ? `<span class="log-site">[${escapeHtml(entry.site)}]</span>` : '') +
    `<span class="log-msg">${escapeHtml(entry.message || '')}</span>`;

  list.appendChild(div);

  while (list.children.length > MAX_LOG_ENTRIES) {
    list.removeChild(list.firstChild);
  }

  list.scrollTop = list.scrollHeight;
}

function clearLogPanel() {
  const list = $('logList');
  if (list) list.innerHTML = '';
}

function copyLogPanel() {
  const list = $('logList');
  if (!list || !list.children.length) {
    showAlert('info', '当前没有日志可复制');
    return;
  }
  const lines = [];
  list.querySelectorAll('.log-entry').forEach(el => {
    const t = el.querySelector('.log-time')?.textContent?.trim() || '';
    const s = el.querySelector('.log-site')?.textContent?.trim() || '';
    const m = el.querySelector('.log-msg')?.textContent?.trim() || '';
    const line = [t, s, m].filter(Boolean).join(' ');
    if (line) lines.push(line);
  });
  const text = lines.join('\n');
  const done = () => showAlert('info', '✅ 日志已复制到剪贴板（共 ' + lines.length + ' 行）');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopyText(text, done));
  } else {
    fallbackCopyText(text, done);
  }
}

function fallbackCopyText(text, onOk) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    onOk();
  } catch {
    showAlert('warn', '复制失败，请手动全选日志后 Ctrl+C');
  }
  document.body.removeChild(ta);
}

function toggleLogPanel() {
  const list = $('logList');
  const btn = $('btnToggleLog');
  if (!list || !btn) return;

  logCollapsed = !logCollapsed;
  list.style.display = logCollapsed ? 'none' : 'block';
  btn.textContent = logCollapsed ? '展开' : '收起';
}

// ═══════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════

init();