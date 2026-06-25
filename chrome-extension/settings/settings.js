// settings/settings.js
'use strict';

// ═══════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════

let config = {};
let pendingPickKey = null;

// ═══════════════════════════════════════════
// 操作步骤类型（动作步骤，可增删改排序）
// ═══════════════════════════════════════════
const STEP_TYPE_DEFS = {
  upload:         { label: '上传图片',    needsFeatures: true,  featureIntent: 'upload', icon: '📤' },
  input:          { label: '输入文字',    needsFeatures: true,  featureIntent: 'input',  icon: '⌨️' },
  send:           { label: '发送消息',    needsFeatures: true,  featureIntent: 'send',   icon: '📨' },
  click:          { label: '点击元素',    needsFeatures: true,  featureIntent: 'click',  icon: '🖱️' },
  wait:           { label: '等待（秒）',  needsFeatures: false, icon: '⏳' },
  waitForElement: { label: '等待元素出现/消失', needsFeatures: true, featureIntent: 'wait', icon: '👀' },
  delete:         { label: '点击删除按钮', needsFeatures: true,  featureIntent: 'click',  icon: '🗑️' }
};

// 辅助验证元素（非操作步骤，用于页面状态判定）
const AUX_COMMON = [
  { cfgKey: 'uploadLoadingFeatures', label: '上传loading动画' },
  { cfgKey: 'uploadPreviewFeatures', label: '上传图片预览' },
  { cfgKey: 'uploadDeleteFeatures',  label: '图片删除按钮（页面上已上传图片的删除）' },
  { cfgKey: 'replyFeatures',         label: '回复内容区域（AI回复的文本容器）' },
  { cfgKey: 'copyButtonFeatures',    label: '复制按钮（AI回复底部的复制图标，用于获取完整回复）' }
];
const AUX_IMAGEGEN = [
  { cfgKey: 'imageAreaFeatures', label: '生成图片区域' },
  { cfgKey: 'loadingFeatures',   label: '生成中loading' }
];

function getAuxElementsForSite(site) {
  const items = [...AUX_COMMON];
  if (site.role === 'imagegen') items.push(...AUX_IMAGEGEN);
  return items;
}

function _genStepId() {
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 把老结构（inputFeatures/uploadFeatures/sendFeatures）迁移为 operationSteps。
 * 已存在 operationSteps 则不动。
 */
function migrateSiteToOperationSteps(site) {
  if (!site) return;
  if (Array.isArray(site.operationSteps) && site.operationSteps.length > 0) return;
  const steps = [];
  if (site.uploadFeatures) steps.push({ id: _genStepId(), type: 'upload', features: site.uploadFeatures });
  if (site.inputFeatures)  steps.push({ id: _genStepId(), type: 'input',  features: site.inputFeatures });
  if (site.sendFeatures)   steps.push({ id: _genStepId(), type: 'send',   features: site.sendFeatures });
  site.operationSteps = steps;
}

/**
 * 保存前：从 operationSteps 中首个匹配类型派生老字段，
 * 供 popup.js、content/player.js、background.js 中未改造的读取逻辑继续使用。
 */
function deriveLegacyFeaturesFromSteps(site) {
  if (!site || !Array.isArray(site.operationSteps)) return;
  const firstOf = (type) => {
    const st = site.operationSteps.find(s => s.type === type);
    return st?.features || null;
  };
  site.uploadFeatures = firstOf('upload') || site.uploadFeatures || null;
  site.inputFeatures  = firstOf('input')  || site.inputFeatures  || null;
  site.sendFeatures   = firstOf('send')   || site.sendFeatures   || null;
}

// ═══════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════

async function init() {
  // ── 商业版：初始化会员状态条 ──
  AuthUI.createStatusBar(document.getElementById('authStatusBar'));
  const user = await AuthUI.refreshUserInfo();
  await AuthUI.updateStatusBar(user);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'AUTH_STATE_CHANGED') {
      AuthUI.updateStatusBar(msg.user);
    }
  });

  config = await loadConfig();
  await loadPresets();
  renderAll();
  bindEvents();
}

async function loadConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get('userConfig', r => {
      resolve(normalizeConfig(r.userConfig || defaultConfig()));
    });
  });
}

function defaultConfig() {
  const legacy = {
    selectedColumns: [],
    messageTemplate: '',
    extractConfig: {
      mode: 'marker',
      startMarker: 'GLOBAL FIXED CONSTRAINTS',
      endMarker: '',
      includeMarker: true,
      promptSplitMode: 'auto',
      promptSplitPattern: ''
    },
    arenaConfig: {
      siteUrl: 'https://arena.ai',
      inputFeatures: null, uploadFeatures: null,
      sendFeatures: null,  uploadLoadingFeatures: null,
      uploadPreviewFeatures: null, uploadDeleteFeatures: null,
      uploadLoadingSelector: '', uploadPreviewSelector: '',
      uploadErrorSelector: '',   uploadDeleteSelector: '',
      verifyMode: 'loose', uploadTimeout: 120000, maxRetries: 3
    },
    doubaoConfig: {
      siteUrl: 'https://www.doubao.com',
      inputFeatures: null, uploadFeatures: null,
      sendFeatures: null,  imageAreaFeatures: null,
      loadingFeatures: null, uploadPreviewFeatures: null,
      uploadDeleteFeatures: null,
      imageAreaSelector: '',     loadingSelector: '',
      uploadLoadingSelector: '', uploadPreviewSelector: '',
      uploadErrorSelector: '',   uploadDeleteSelector: '',
      verifyMode: 'loose', uploadTimeout: 120000
    },
    imageGenConfig: {
      sendMode: 'batch', batchSize: 10,
      totalPrompts: 40, batchTimeout: 300000, maxRetries: 3,
      batchPrefixFirst: '这是商品"{productName}"的生图任务\n请按以下{promptCount}条提示词依次生成图片，每条1张：',
      batchPrefixContinue: '继续第{batchIndex}批（共{batchTotal}批）：'
    },
    exportColumnConfig: {
      sectionMarker: '第二部分',
      exportPromptSplitSource: 'extract',
      exportPromptSplitPattern: '',
      columns: [
        { name: '商品详情', type: 'analysis' },
        { name: '提示词_1', type: 'prompts', from: 1,  to: 10 },
        { name: '提示词_2', type: 'prompts', from: 11, to: 20 },
        { name: '提示词_3', type: 'prompts', from: 21, to: 30 },
        { name: '提示词_4', type: 'prompts', from: 31, to: 40 }
      ]
    }
  };

  const tpl = {
    id: 'tpl_default',
    name: '默认模板',
    selectedColumns: [],
    content: '',
    createdAt: new Date().toLocaleString('zh-CN'),
    lastModified: new Date().toLocaleString('zh-CN')
  };

  return {
    ...legacy,
    version: '2.0',
    exportTime: '',
    pipelineMode: 'both',
    sites: [
      {
        id: 'site_arena',
        name: 'Arena.ai',
        url: legacy.arenaConfig.siteUrl,
        role: 'analysis',
        enabled: true,
        order: 1,
        failAction: 'skip'
      },
      {
        id: 'site_doubao',
        name: '豆包',
        url: legacy.doubaoConfig.siteUrl,
        role: 'imagegen',
        enabled: true,
        order: 2,
        failAction: 'skip',
        imageGenConfig: { ...legacy.imageGenConfig },
        interceptorConfig: {
          matchKey: 'imageMeta',
          originalPath: 'original_urls[0]',
          thumbUrlPaths: ['thumb_urls[0]'],
          hookInPlaceReplace: false
        }
      }
    ],
    globalConfig: {
      extractConfig: legacy.extractConfig,
      imageGenConfig: legacy.imageGenConfig
    },
    messageTemplates: [tpl],
    activeTemplateId: tpl.id
  };
}

function normalizeConfig(raw) {
  const base = defaultConfig();
  const extractFromGlobal = raw?.globalConfig?.extractConfig || {};
  const imageFromGlobal = raw?.globalConfig?.imageGenConfig || {};
  const advFromGlobal = raw?.globalConfig?.advancedConfig || {};
  const merged = {
    ...base,
    ...(raw || {}),
    arenaConfig: { ...base.arenaConfig, ...(raw?.arenaConfig || {}) },
    doubaoConfig: { ...base.doubaoConfig, ...(raw?.doubaoConfig || {}) },
    extractConfig: { ...base.extractConfig, ...(raw?.extractConfig || {}), ...extractFromGlobal },
    imageGenConfig: { ...base.imageGenConfig, ...(raw?.imageGenConfig || {}), ...imageFromGlobal },
    advancedConfig: {
      analysisFailAction: 'skip',
      imagegenFailAction: 'skip',
      claudeReplyTimeout: 300000,
      pageLoadTimeout: 30000,
      ...(raw?.advancedConfig || {}),
      ...advFromGlobal
    }
  };

  const templates = Array.isArray(raw?.messageTemplates) && raw.messageTemplates.length
    ? raw.messageTemplates
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
  merged.version = merged.version || '2.0';
  if (!merged.pipelineMode) merged.pipelineMode = 'both';
  if (!Array.isArray(merged.sites) || !merged.sites.length) {
    merged.sites = [
      { id: 'site_arena', name: 'Arena.ai', url: merged.arenaConfig?.siteUrl || 'https://arena.ai', role: 'analysis', enabled: true, order: 1 },
      { id: 'site_doubao', name: '豆包', url: merged.doubaoConfig?.siteUrl || 'https://www.doubao.com', role: 'imagegen', enabled: true, order: 2 }
    ];
  }

  // Migrate legacy arenaConfig/doubaoConfig features into site objects
  const featureKeys = ['inputFeatures', 'uploadFeatures', 'sendFeatures',
    'uploadLoadingFeatures', 'uploadPreviewFeatures', 'uploadDeleteFeatures',
    'imageAreaFeatures', 'loadingFeatures'];
  const settingKeys = ['verifyMode', 'uploadTimeout', 'maxRetries'];

  merged.sites.forEach(site => {
    const legacy = site.role === 'analysis' ? merged.arenaConfig
                 : site.role === 'imagegen' ? merged.doubaoConfig
                 : null;
    if (!legacy) return;
    featureKeys.forEach(k => {
      if (!site[k] && legacy[k]) site[k] = legacy[k];
    });
    settingKeys.forEach(k => {
      if (site[k] === undefined && legacy[k] !== undefined) site[k] = legacy[k];
    });
    if (!site.url && legacy.siteUrl) site.url = legacy.siteUrl;
  });

  // Migrate old fixed-slot features into dynamic operationSteps
  merged.sites.forEach(site => migrateSiteToOperationSteps(site));

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
        const igBase = defaultConfig().imageGenConfig;
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

  const active = templates.find(t => t.id === merged.activeTemplateId) || templates[0];
  merged.selectedColumns = active.selectedColumns || merged.selectedColumns || [];
  merged.messageTemplate = active.content || merged.messageTemplate || '';
  // Migrate old exportColumnConfig format to new columns-based format
  const rawEc = raw?.exportColumnConfig || raw?.globalConfig?.exportColumnConfig || {};
  const _ecSplit = {
    exportPromptSplitSource: rawEc.exportPromptSplitSource || 'extract',
    exportPromptSplitPattern: rawEc.exportPromptSplitPattern || ''
  };
  if (rawEc.columns) {
    merged.exportColumnConfig = {
      sectionMarker: rawEc.sectionMarker || '第二部分',
      columns: rawEc.columns,
      ..._ecSplit
    };
  } else if (rawEc.analysisColumnName || rawEc.promptColumnPrefix) {
    const acn = rawEc.analysisColumnName || '商品详情';
    const pcp = rawEc.promptColumnPrefix || '提示词';
    const ppc = rawEc.promptsPerColumn   || 10;
    const total = merged.imageGenConfig?.totalPrompts || 40;
    const cols = [{ name: acn, type: 'analysis' }];
    for (let i = 0; i < Math.ceil(total / ppc); i++) {
      cols.push({ name: `${pcp}_${i + 1}`, type: 'prompts', from: i * ppc + 1, to: (i + 1) * ppc });
    }
    merged.exportColumnConfig = {
      sectionMarker: rawEc.sectionMarker || '第二部分',
      columns: cols,
      ..._ecSplit
    };
  } else {
    merged.exportColumnConfig = { ...base.exportColumnConfig, ..._ecSplit };
  }

  merged.globalConfig = {
    extractConfig: merged.extractConfig,
    imageGenConfig: merged.imageGenConfig,
    advancedConfig: merged.advancedConfig,
    exportColumnConfig: merged.exportColumnConfig
  };

  return merged;
}

// ═══════════════════════════════════════════
// 渲染
// ═══════════════════════════════════════════

function renderAll() {
  renderColumns();
  renderExtractConfig();
  renderExportColumnConfig();
  renderSitesConfig();
  renderAdvancedConfig();
  renderPresets();
}

function renderColumns() {
  renderColumnList();
  renderTemplateManager();
}

function renderColumnList() {
  const container = document.getElementById('columnList');
  if (!container) return;

  const cols = config.selectedColumns || [];
  if (!cols.length) {
    container.innerHTML =
      '<div class="empty-hint">暂无列配置，请手动添加</div>';
    return;
  }

  container.innerHTML = cols.map(col => `
    <div class="column-item">
      <input type="checkbox" id="col_${col}" value="${col}" checked>
      <label for="col_${col}">${col}</label>
      <button class="btn-sm btn-del-col" data-col="${col}">删除</button>
    </div>
  `).join('');

  container.querySelectorAll('.btn-del-col').forEach(btn => {
    btn.addEventListener('click', () => {
      config.selectedColumns = (config.selectedColumns || [])
        .filter(c => c !== btn.dataset.col);
      renderColumnList();
      renderTplVarTags();
    });
  });
}

// ═══════════════════════════════════════════
// 多模板管理
// ═══════════════════════════════════════════

function ensureTemplates() {
  if (!Array.isArray(config.messageTemplates) || !config.messageTemplates.length) {
    config.messageTemplates = [{
      id: 'tpl_default',
      name: '默认模板',
      selectedColumns: config.selectedColumns || [],
      content: config.messageTemplate || '',
      createdAt: new Date().toLocaleString('zh-CN'),
      lastModified: new Date().toLocaleString('zh-CN')
    }];
  }
  if (!config.activeTemplateId) {
    config.activeTemplateId = config.messageTemplates[0].id;
  }
}

function getActiveTpl() {
  ensureTemplates();
  return config.messageTemplates.find(t => t.id === config.activeTemplateId)
    || config.messageTemplates[0];
}

function renderTemplateManager() {
  ensureTemplates();

  const selector = document.getElementById('tplSelector');
  if (!selector) return;

  const active = getActiveTpl();

  selector.innerHTML = config.messageTemplates.map(t =>
    `<option value="${t.id}" ${t.id === active.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
  ).join('');

  const nameEl = document.getElementById('tplName');
  if (nameEl) nameEl.value = active.name || '';

  const tplEl = document.getElementById('messageTemplate');
  if (tplEl) tplEl.value = active.content || '';

  config.messageTemplate = active.content || '';
  config.selectedColumns = active.selectedColumns || config.selectedColumns || [];

  renderTplVarTags();
  updateTplHighlight();

  const delBtn = document.getElementById('btnDelTpl');
  if (delBtn) delBtn.disabled = config.messageTemplates.length <= 1;
}

function renderTplVarTags() {
  const container = document.getElementById('tplVarTags');
  if (!container) return;

  const cols = config.selectedColumns || [];
  if (!cols.length) {
    container.innerHTML = '<span class="hint">请先在上方添加列</span>';
    return;
  }

  container.innerHTML = cols.map(col =>
    `<button class="preset-tag tpl-var-tag" data-var="${escapeHtml(col)}">{{${escapeHtml(col)}}}</button>`
  ).join('');

  container.querySelectorAll('.tpl-var-tag').forEach(btn => {
    btn.addEventListener('click', () => insertVarAtCursor(btn.dataset.var));
  });
}

function insertVarAtCursor(varName) {
  const tplEl = document.getElementById('messageTemplate');
  if (!tplEl) return;

  const text = `{{${varName}}}`;
  const start = tplEl.selectionStart;
  const end = tplEl.selectionEnd;
  const val = tplEl.value;

  tplEl.value = val.substring(0, start) + text + val.substring(end);
  tplEl.selectionStart = tplEl.selectionEnd = start + text.length;
  tplEl.focus();

  syncTplContent();
}

function syncTplContent() {
  const tplEl = document.getElementById('messageTemplate');
  if (!tplEl) return;

  const active = getActiveTpl();
  active.content = tplEl.value;
  active.lastModified = new Date().toLocaleString('zh-CN');
  config.messageTemplate = tplEl.value;

  updateTplHighlight();
}

function updateTplHighlight() {
  const tplEl = document.getElementById('messageTemplate');
  const hlEl = document.getElementById('tplHighlight');
  if (!tplEl || !hlEl) return;

  const raw = tplEl.value || '';
  const escaped = escapeHtml(raw)
    .replace(/\{\{([^}]+)\}\}/g, '<mark class="tpl-var-mark">{{$1}}</mark>');

  hlEl.innerHTML = escaped + '\n';
}

function switchTemplate(tplId) {
  ensureTemplates();
  const tpl = config.messageTemplates.find(t => t.id === tplId);
  if (!tpl) return;

  config.activeTemplateId = tpl.id;
  config.selectedColumns = tpl.selectedColumns || [];
  config.messageTemplate = tpl.content || '';

  renderColumnList();
  renderTemplateManager();
}

function addTemplate() {
  ensureTemplates();
  const id = `tpl_${Date.now()}`;
  const now = new Date().toLocaleString('zh-CN');

  config.messageTemplates.push({
    id,
    name: `模板${config.messageTemplates.length + 1}`,
    selectedColumns: [],
    content: '',
    createdAt: now,
    lastModified: now
  });

  config.activeTemplateId = id;
  renderTemplateManager();
  renderColumnList();
}

function duplicateTemplate() {
  const src = getActiveTpl();
  const id = `tpl_${Date.now()}`;
  const now = new Date().toLocaleString('zh-CN');

  config.messageTemplates.push({
    id,
    name: `${src.name}（副本）`,
    selectedColumns: [...(src.selectedColumns || [])],
    content: src.content || '',
    createdAt: now,
    lastModified: now
  });

  config.activeTemplateId = id;
  renderTemplateManager();
  renderColumnList();
}

function deleteTemplate() {
  ensureTemplates();
  if (config.messageTemplates.length <= 1) {
    alert('至少保留一个模板');
    return;
  }
  if (!confirm(`确定删除模板"${getActiveTpl().name}"？`)) return;

  config.messageTemplates = config.messageTemplates.filter(
    t => t.id !== config.activeTemplateId
  );
  config.activeTemplateId = config.messageTemplates[0].id;

  const active = getActiveTpl();
  config.selectedColumns = active.selectedColumns || [];
  config.messageTemplate = active.content || '';

  renderColumnList();
  renderTemplateManager();
}

function renderExtractConfig() {
  const ec = config.extractConfig || {};

  const modeEl = document.querySelector(
    `[name="extractMode"][value="${ec.mode || 'marker'}"]`
  );
  if (modeEl) modeEl.checked = true;

  const startEl = document.getElementById('startMarker');
  if (startEl) startEl.value = ec.startMarker || '';

  const endEl = document.getElementById('endMarker');
  if (endEl) endEl.value = ec.endMarker || '';

  const inclVal = String(ec.includeMarker !== false);
  const inclEl = document.querySelector(`[name="includeMarker"][value="${inclVal}"]`);
  if (inclEl) inclEl.checked = true;

  toggleMarkerSettings((ec.mode || 'marker') === 'marker');

  const splitMode = ec.promptSplitMode || 'auto';
  const splitModeEl = document.querySelector(`[name="promptSplitMode"][value="${splitMode}"]`);
  if (splitModeEl) splitModeEl.checked = true;

  const splitPatEl = document.getElementById('promptSplitPattern');
  if (splitPatEl) splitPatEl.value = ec.promptSplitPattern || '';

  toggleCustomSplitSettings(splitMode === 'custom');
}

function toggleCustomSplitSettings(show) {
  const el = document.getElementById('customSplitSettings');
  if (el) el.style.display = show ? '' : 'none';
}

// ═══════════════════════════════════════════
// 导出列规则 - 动态UI
// ═══════════════════════════════════════════

function renderExportColumnRules(columns) {
  const container = document.getElementById('exportColumnRules');
  if (!container) return;
  container.innerHTML = '';
  (columns || []).forEach((col, idx) => {
    container.appendChild(createExportRuleRow(col, idx));
  });
  updateDocExtractSourceDisplay();
}

function createExportRuleRow(col, idx) {
  const row = document.createElement('div');
  row.className = 'export-rule-row';
  row.dataset.idx = idx;

  const isPrompts = col.type === 'prompts';
  const useForImg = col.useForImagegen !== false;

  row.innerHTML = `
    <span class="rule-index">${idx + 1}</span>
    <span class="rule-label">列名</span>
    <input type="text" class="ec-name" value="${col.name || ''}" placeholder="列名">
    <span class="rule-label">类型</span>
    <select class="ec-type">
      <option value="analysis" ${!isPrompts ? 'selected' : ''}>分析详情</option>
      <option value="prompts"  ${isPrompts  ? 'selected' : ''}>提示词范围</option>
    </select>
    <span class="export-rule-range ${isPrompts ? '' : 'export-rule-range-hidden'}">
      <span class="rule-label">第</span>
      <input type="number" class="ec-from" value="${col.from || 1}" min="1" max="200">
      <span class="rule-label">~</span>
      <input type="number" class="ec-to" value="${col.to || 10}" min="1" max="200">
      <span class="rule-label">条</span>
      <label class="ec-imggen-label" title="勾选后该列提示词将用于生图任务">
        <input type="checkbox" class="ec-useforimg" ${useForImg ? 'checked' : ''}> 用于生图
      </label>
    </span>
    <button class="btn-del-rule" title="删除此列">&times;</button>
  `;

  row.querySelector('.ec-type').addEventListener('change', (e) => {
    const rangeEl = row.querySelector('.export-rule-range');
    if (e.target.value === 'prompts') {
      rangeEl.classList.remove('export-rule-range-hidden');
    } else {
      rangeEl.classList.add('export-rule-range-hidden');
    }
    updateDocExtractSourceDisplay();
  });

  const imgCb = row.querySelector('.ec-useforimg');
  if (imgCb) imgCb.addEventListener('change', () => updateDocExtractSourceDisplay());

  row.querySelector('.btn-del-rule').addEventListener('click', () => {
    row.remove();
    reindexExportRules();
    updateDocExtractSourceDisplay();
  });

  return row;
}

function reindexExportRules() {
  const rows = document.querySelectorAll('#exportColumnRules .export-rule-row');
  rows.forEach((r, i) => {
    r.dataset.idx = i;
    r.querySelector('.rule-index').textContent = i + 1;
  });
}

function readExportColumnRules() {
  const marker = document.getElementById('sectionMarker')?.value || '第二部分';
  const rows = document.querySelectorAll('#exportColumnRules .export-rule-row');
  const columns = [];
  rows.forEach(r => {
    const name = r.querySelector('.ec-name')?.value?.trim();
    const type = r.querySelector('.ec-type')?.value || 'analysis';
    if (!name) return;
    const col = { name, type };
    if (type === 'prompts') {
      col.from = parseInt(r.querySelector('.ec-from')?.value) || 1;
      col.to   = parseInt(r.querySelector('.ec-to')?.value)   || 10;
      col.useForImagegen = r.querySelector('.ec-useforimg')?.checked !== false;
    }
    columns.push(col);
  });
  return {
    sectionMarker: marker,
    exportPromptSplitSource: 'extract',
    exportPromptSplitPattern: '',
    columns
  };
}

function initExportColumnEvents() {
  const btn = document.getElementById('btnAddExportCol');
  if (btn) {
    btn.addEventListener('click', () => {
      const container = document.getElementById('exportColumnRules');
      const rows = container.querySelectorAll('.export-rule-row');
      const nextIdx = rows.length;

      let lastTo = 0;
      rows.forEach(r => {
        if (r.querySelector('.ec-type')?.value === 'prompts') {
          const to = parseInt(r.querySelector('.ec-to')?.value) || 0;
          if (to > lastTo) lastTo = to;
        }
      });

      const newFrom = lastTo + 1;
      const newTo   = lastTo + 10;
      const newCol = {
        name: `提示词_${nextIdx}`,
        type: 'prompts',
        from: newFrom,
        to:   newTo
      };
      container.appendChild(createExportRuleRow(newCol, nextIdx));
      updateDocExtractSourceDisplay();
    });
  }
}

function updateDocExtractSourceDisplay() {
  const el = document.getElementById('docExtractSourceCols');
  if (!el) return;
  const rows = document.querySelectorAll('#exportColumnRules .export-rule-row');
  const activeCols = [];
  const inactiveCols = [];
  rows.forEach(r => {
    if (r.querySelector('.ec-type')?.value === 'prompts') {
      const name = r.querySelector('.ec-name')?.value?.trim();
      const from = r.querySelector('.ec-from')?.value || '?';
      const to   = r.querySelector('.ec-to')?.value || '?';
      const useForImg = r.querySelector('.ec-useforimg')?.checked !== false;
      if (!name) return;
      const label = `<b>${name}</b>（第${from}~${to}条）`;
      if (useForImg) activeCols.push(label);
      else inactiveCols.push(label);
    }
  });
  let html = '';
  if (activeCols.length) {
    html = '将从以下列读取提示词：' + activeCols.join('、');
    if (inactiveCols.length) html += '<br><span style="color:#999">未勾选（不参与生图）：' + inactiveCols.join('、') + '</span>';
  } else if (inactiveCols.length) {
    html = '<span style="color:#e67700">有提示词列但均未勾选「用于生图」，仅生图模式将无法读取提示词</span>';
  } else {
    html = '<span style="color:#999">未定义提示词范围列，请在下方添加类型为「提示词范围」的列</span>';
  }
  el.innerHTML = html;
}

// ═══════════════════════════════════════════

function renderExportColumnConfig() {
  const ec = config.exportColumnConfig || {};
  const smEl = document.getElementById('sectionMarker');
  if (smEl) smEl.value = ec.sectionMarker ?? '第二部分';
  renderExportColumnRules(ec.columns || defaultConfig().exportColumnConfig.columns);
}

// ═══════════════════════════════════════════
// 事件绑定
// ═══════════════════════════════════════════

function bindEvents() {
  // 标签切换
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const tabEl = document.getElementById(`tab-${btn.dataset.tab}`);
      if (tabEl) tabEl.classList.add('active');
    });
  });

  // 保存
  document.getElementById('btnSave')?.addEventListener('click', () => saveConfig(false));
  document.getElementById('btnExportConfig')?.addEventListener('click', exportConfigFile);
  document.getElementById('btnImportConfig')?.addEventListener('click', () => {
    document.getElementById('importConfigInput')?.click();
  });
  document.getElementById('importConfigInput')?.addEventListener('change', importConfigFile);
  document.getElementById('btnAddSite')?.addEventListener('click', addSite);

  // 模板管理
  document.getElementById('tplSelector')?.addEventListener('change', e => switchTemplate(e.target.value));
  document.getElementById('btnAddTpl')?.addEventListener('click', addTemplate);
  document.getElementById('btnDupTpl')?.addEventListener('click', duplicateTemplate);
  document.getElementById('btnDelTpl')?.addEventListener('click', deleteTemplate);
  document.getElementById('tplName')?.addEventListener('input', e => {
    const tpl = getActiveTpl();
    tpl.name = e.target.value.trim() || '未命名模板';
    const opt = document.querySelector(`#tplSelector option[value="${tpl.id}"]`);
    if (opt) opt.textContent = tpl.name;
  });
  document.getElementById('messageTemplate')?.addEventListener('input', () => syncTplContent());
  document.getElementById('messageTemplate')?.addEventListener('scroll', () => {
    const tplEl = document.getElementById('messageTemplate');
    const hlEl = document.getElementById('tplHighlight');
    if (tplEl && hlEl) {
      hlEl.scrollTop = tplEl.scrollTop;
      hlEl.scrollLeft = tplEl.scrollLeft;
    }
  });

  // 预设方案
  document.getElementById('btnSavePreset')?.addEventListener('click', saveAsPreset);
  document.getElementById('btnLoadPreset')?.addEventListener('click', loadPreset);
  document.getElementById('btnDelPreset')?.addEventListener('click', deletePreset);

  // 错误日志
  document.getElementById('btnRefreshErrors')?.addEventListener('click', refreshErrorLogs);
  document.getElementById('btnClearErrors')?.addEventListener('click', clearErrorLogs);

  // 导出列规则
  initExportColumnEvents();

  // 列添加
  document.getElementById('btnAddColumn')?.addEventListener('click', addColumn);
  document.getElementById('newColumnInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') addColumn();
  });

  // 提取模式
  document.querySelectorAll('[name="extractMode"]').forEach(r => {
    r.addEventListener('change', () => toggleMarkerSettings(r.value === 'marker'));
  });

  // 分条模式
  document.querySelectorAll('[name="promptSplitMode"]').forEach(r => {
    r.addEventListener('change', () => toggleCustomSplitSettings(r.value === 'custom'));
  });
  document.querySelectorAll('.split-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const patEl = document.getElementById('promptSplitPattern');
      if (!patEl) return;
      const pattern = btn.dataset.pattern || '';
      const existing = patEl.value.split('\n').map(l => l.trim()).filter(Boolean);
      if (!existing.includes(pattern)) {
        patEl.value = existing.length ? existing.join('\n') + '\n' + pattern : pattern;
      }
    });
  });
  document.getElementById('btnClearSplitPattern')?.addEventListener('click', () => {
    const patEl = document.getElementById('promptSplitPattern');
    if (patEl) patEl.value = '';
  });

  // 预设标记
  document.querySelectorAll('.preset-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = document.getElementById('startMarker');
      if (el) el.value = btn.dataset.marker;
    });
  });

  // 提取测试
  document.getElementById('btnTestExtract')?.addEventListener('click', doTestExtract);

  // 监听来自background的消息（ELEMENT_PICKED）
  chrome.runtime.onMessage.addListener(onMessage);
}

function ensureSites() {
  if (!Array.isArray(config.sites)) config.sites = [];
  if (!config.sites.length) {
    config.sites = [
      { id: 'site_arena', name: 'Arena.ai', url: config.arenaConfig?.siteUrl || 'https://arena.ai', role: 'analysis', enabled: true, order: 1 },
      { id: 'site_doubao', name: '豆包', url: config.doubaoConfig?.siteUrl || 'https://www.doubao.com', role: 'imagegen', enabled: true, order: 2 }
    ];
  }
  config.sites = config.sites
    .sort((a, b) => (a.order || 999) - (b.order || 999))
    .map((s, i) => ({ ...s, order: i + 1 }));
}

function renderPipelineMode() {
  const mode = config.pipelineMode || 'both';
  const el = document.querySelector(`[name="pipelineMode"][value="${mode}"]`);
  if (el) el.checked = true;
}

function renderSiteFailActionSection(site) {
  const fa = site.failAction || 'skip';
  const gn = `failAction_${site.id}`;

  let replyBlock = '';
  if (site.role === 'analysis') {
    const adv = config.advancedConfig || {};
    const globalReplyMin = Math.round((adv.claudeReplyTimeout || 300000) / 60000);
    const globalStallSec = Math.round(((adv.replyStallTimeout ?? 45000) || 0) / 1000);
    const rtMin = Number.isFinite(site.replyTimeoutMs)
      ? Math.max(1, Math.round(site.replyTimeoutMs / 60000))
      : globalReplyMin;
    const stSec = Number.isFinite(site.replyStallTimeoutMs)
      ? Math.max(0, Math.round(site.replyStallTimeoutMs / 1000))
      : globalStallSec;
    replyBlock = `
      <div class="form-row" style="margin-top:8px;">
        <div class="form-group">
          <label>回复等待超时（分钟）：</label>
          <input type="number" class="input-xs site-reply-timeout" data-site-id="${site.id}" min="1" max="30" value="${rtMin}">
        </div>
        <div class="form-group">
          <label>回复停滞判失败（秒）：</label>
          <input type="number" class="input-xs site-reply-stall" data-site-id="${site.id}" min="0" max="600" value="${stSec}">
          <span class="hint-inline">0 = 关闭</span>
        </div>
      </div>`;
  }

  return `
    <div class="site-settings-section">
      <h4>🛡️ 错误处理策略</h4>
      <div class="form-group">
        <div class="radio-group">
          <label class="radio-label"><input type="radio" name="${gn}" value="skip" ${fa === 'skip' ? 'checked' : ''}>跳过并继续下一个商品（推荐）</label>
          <label class="radio-label"><input type="radio" name="${gn}" value="pause" ${fa === 'pause' ? 'checked' : ''}>暂停任务，等待用户手动处理</label>
          <label class="radio-label"><input type="radio" name="${gn}" value="stop" ${fa === 'stop' ? 'checked' : ''}>立即停止整个任务</label>
        </div>
      </div>
      ${replyBlock}
    </div>`;
}

function renderSiteImageGenSection(site) {
  const ig = site.imageGenConfig || {};
  const sm = ig.sendMode || 'batch';
  const bs = ig.batchSize || 10;
  const pfx = `ig_${site.id}`;
  const defaultFirst = '这是商品"{productName}"的生图任务\n请按以下{promptCount}条提示词依次生成图片，每条1张：';
  const defaultCont  = '继续第{batchIndex}批（共{batchTotal}批）：';

  return `
    <div class="site-settings-section site-ig-section" data-site-id="${site.id}">
      <h4>🖼️ 生图参数</h4>
      <div class="form-group">
        <label>提示词发送方式：</label>
        <div class="radio-group">
          <label class="radio-label"><input type="radio" name="${pfx}_sendMode" value="batch" ${sm === 'batch' ? 'checked' : ''}>分批发送（推荐）</label>
          <label class="radio-label"><input type="radio" name="${pfx}_sendMode" value="all" ${sm === 'all' ? 'checked' : ''}>一次性全部发送</label>
        </div>
      </div>
      <div class="form-group site-ig-batch-settings" data-site-id="${site.id}" style="${sm !== 'batch' ? 'display:none' : ''}">
        <label>每批发送数量：</label>
        <div class="radio-group">
          <label class="radio-label"><input type="radio" name="${pfx}_batchSize" value="5" ${bs === 5 ? 'checked' : ''}>5条/批</label>
          <label class="radio-label"><input type="radio" name="${pfx}_batchSize" value="10" ${bs === 10 ? 'checked' : ''}>10条/批（推荐）</label>
          <label class="radio-label"><input type="radio" name="${pfx}_batchSize" value="custom" ${bs !== 5 && bs !== 10 ? 'checked' : ''}>自定义：<input type="number" class="input-xs site-ig-custom-batch" data-site-id="${site.id}" value="${bs !== 5 && bs !== 10 ? bs : 8}" min="1" max="40"> 条/批</label>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>总提示词数量：</label>
          <input type="number" class="input-xs site-ig-field" data-site-id="${site.id}" data-ig-field="totalPrompts" value="${ig.totalPrompts || 40}" min="1" max="200">
        </div>
        <div class="form-group">
          <label>单批超时（分钟）：</label>
          <input type="number" class="input-xs site-ig-field" data-site-id="${site.id}" data-ig-field="batchTimeout" value="${Math.round((ig.batchTimeout || 300000) / 60000)}" min="1" max="30">
        </div>
        <div class="form-group">
          <label>失败重试次数：</label>
          <input type="number" class="input-xs site-ig-field" data-site-id="${site.id}" data-ig-field="maxRetries" value="${ig.maxRetries || 3}" min="1" max="5">
        </div>
      </div>
      <div class="form-group" style="margin-top:8px;">
        <label>批次消息前缀：</label>
        <div style="margin-top:4px;">
          <label style="font-weight:500;font-size:12px;">首批前缀：</label>
          <textarea class="textarea-sm site-ig-prefix-first" data-site-id="${site.id}" rows="2" style="width:100%;font-size:12px;padding:6px;border:1px solid #ddd;border-radius:4px;resize:vertical;" placeholder="留空则不添加前缀">${escapeHtml(ig.batchPrefixFirst ?? defaultFirst)}</textarea>
          <span class="hint-inline" style="font-size:11px;">变量：<code>{productName}</code> <code>{promptCount}</code> <code>{batchIndex}</code> <code>{batchTotal}</code></span>
        </div>
        <div style="margin-top:6px;">
          <label style="font-weight:500;font-size:12px;">后续批次前缀：</label>
          <textarea class="textarea-sm site-ig-prefix-continue" data-site-id="${site.id}" rows="1" style="width:100%;font-size:12px;padding:6px;border:1px solid #ddd;border-radius:4px;resize:vertical;" placeholder="留空则不添加前缀">${escapeHtml(ig.batchPrefixContinue ?? defaultCont)}</textarea>
        </div>
      </div>
    </div>`;
}

function renderSiteInterceptorSection(site) {
  const ic = site.interceptorConfig || {};
  const pfx = `ic_${site.id}`;
  return `
    <div class="site-settings-section site-ic-section" data-site-id="${site.id}">
      <h4>🔗 API拦截器配置（无水印图片）</h4>
      <p class="hint">配置 JSON.parse 拦截规则，自动捕获无水印原图URL</p>
      <div class="form-row">
        <div class="form-group">
          <label>匹配Key：</label>
          <input type="text" class="input-sm site-ic-field" data-site-id="${site.id}" data-ic-field="matchKey" value="${escapeHtml(ic.matchKey || '')}" placeholder="如 imageMeta">
        </div>
        <div class="form-group">
          <label>原图路径：</label>
          <input type="text" class="input-sm site-ic-field" data-site-id="${site.id}" data-ic-field="originalPath" value="${escapeHtml(ic.originalPath || '')}" placeholder="如 original_urls[0]">
        </div>
      </div>
      <div class="form-group">
        <label>缩略图路径（逗号分隔）：</label>
        <input type="text" class="input-md site-ic-field" data-site-id="${site.id}" data-ic-field="thumbUrlPaths" value="${escapeHtml((ic.thumbUrlPaths || []).join(', '))}" placeholder="如 thumb_urls[0]">
      </div>
      <div class="form-group">
        <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" class="site-ic-field" data-site-id="${site.id}" data-ic-field="hookInPlaceReplace" ${ic.hookInPlaceReplace ? 'checked' : ''}>
          <span>Hook后就地替换（将缩略图URL直接替换为原图URL）</span>
        </label>
      </div>
    </div>`;
}

function renderSitesConfig() {
  renderPipelineMode();
  ensureSites();
  const list = document.getElementById('sitesList');
  if (!list) return;

  list.innerHTML = config.sites.map((s, i) => {
    if (!Array.isArray(s.operationSteps)) s.operationSteps = [];
    const steps    = s.operationSteps;
    const auxItems = getAuxElementsForSite(s);

    const hasUpload = steps.some(st => st.type === 'upload' && st.features);
    const hasInput  = steps.some(st => st.type === 'input'  && st.features);
    const hasSend   = steps.some(st => st.type === 'send'   && st.features);
    const essentialOk = hasInput && hasSend; // upload 不再视为必填（纯文生图可不需要）
    const statusText  = essentialOk
      ? `✅ ${steps.length} 个步骤`
      : `⚠️ 缺失关键步骤（文字输入 / 发送）`;

    return `
    <div class="site-card" data-id="${s.id}">
      <div class="site-card-header">
        <div class="site-card-info">
          <input class="input-site-name" data-field="name" value="${escapeHtml(s.name || '')}" placeholder="网站名称">
          <input class="input-site-url" data-field="url" value="${escapeHtml(s.url || '')}" placeholder="https://example.com">
          <select data-field="role">
            <option value="analysis" ${s.role === 'analysis' ? 'selected' : ''}>分析网站</option>
            <option value="imagegen" ${s.role === 'imagegen' ? 'selected' : ''}>生图网站</option>
          </select>
          <label class="site-enabled-label"><input type="checkbox" data-field="enabled" ${s.enabled !== false ? 'checked' : ''}>启用</label>
        </div>
        <div class="site-card-actions">
          <span class="site-config-badge">${statusText}</span>
          <button class="btn-sm" data-act="export-site" title="导出此站点配置">📤</button>
          <button class="btn-sm" data-act="import-site" title="导入站点配置">📥</button>
          <button class="btn-sm" data-act="toggle" title="展开/收起配置">⚙️ 配置</button>
          <button class="btn-sm" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn-sm" data-act="down" ${i === config.sites.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn-sm btn-sm-danger" data-act="del">删除</button>
        </div>
      </div>
      <div class="site-card-body" id="siteBody_${s.id}" style="display:none">
        <div class="site-opsteps-section">
          <h4>操作步骤</h4>
          <p class="hint">按顺序执行的页面动作。可添加/删除/拖动排序。需求示例：上传图片 → 输入文字 → 发送消息</p>
          <div class="opstep-list" id="opSteps_${s.id}">
            ${steps.map((st, idx) => renderOpStepRow(s, st, idx, steps.length)).join('')}
            ${steps.length === 0 ? '<div class="empty-hint">还没有步骤，点击下方按钮添加</div>' : ''}
          </div>
          <div class="opstep-add-bar">
            <select class="opstep-new-type" data-site-id="${s.id}">
              ${Object.entries(STEP_TYPE_DEFS).map(([k, v]) =>
                `<option value="${k}">${v.icon} ${v.label}</option>`).join('')}
            </select>
            <button class="btn-sm btn-add-opstep" data-site-id="${s.id}">+ 添加步骤</button>
          </div>
        </div>
        <div class="site-elements-section">
          <h4>辅助验证元素</h4>
          <p class="hint">不参与操作步骤，仅供系统做页面状态判定（例如上传是否完成、生成是否结束）</p>
          <div class="element-config-list">
            ${auxItems.map(el => {
              const hasIt = !!s[el.cfgKey];
              const auxSel = s[el.cfgKey]?.selector || '';
              const auxCands = (s[el.cfgKey]?.candidateSelectors || []).join(', ');
              return `
              <div class="element-config-item" style="flex-direction:column;align-items:stretch;">
                <div style="display:flex;align-items:center;justify-content:space-between;">
                  <div class="element-config-info">
                    <span class="element-config-name">${el.label}</span>
                    <span class="element-config-status${hasIt ? ' ok' : ''}">${hasIt ? '✅ 已配置' : '⚠️ 未配置'}</span>
                  </div>
                  <div style="display:flex;gap:6px;">
                    <button class="btn-config" data-site-id="${s.id}" data-cfg-key="${el.cfgKey}">🖱️ 点击配置</button>
                    <button class="btn-verify" data-site-id="${s.id}" data-cfg-key="${el.cfgKey}">✅ 验证</button>
                  </div>
                </div>
                <div class="aux-selector-row">
                  <label class="selector-label">选择器：</label>
                  <input type="text" class="input-selector aux-selector-main"
                         data-site-id="${s.id}" data-cfg-key="${el.cfgKey}"
                         value="${escapeHtml(auxSel)}"
                         placeholder="CSS选择器（可选，手动填写或由元素选择器自动填入）">
                  <label class="selector-label" style="margin-left:8px;">备选：</label>
                  <input type="text" class="input-selector aux-selector-candidates"
                         data-site-id="${s.id}" data-cfg-key="${el.cfgKey}"
                         value="${escapeHtml(auxCands)}"
                         placeholder="备选选择器（逗号分隔，可选）">
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>
        <div class="site-settings-section">
          <h4>上传设置</h4>
          <div class="form-group">
            <label>验证策略：</label>
            <div class="radio-group">
              <label class="radio-label"><input type="radio" name="verifyMode_${s.id}" value="loose" ${(s.verifyMode || 'loose') === 'loose' ? 'checked' : ''}>宽松模式（推荐）</label>
              <label class="radio-label"><input type="radio" name="verifyMode_${s.id}" value="strict" ${s.verifyMode === 'strict' ? 'checked' : ''}>严格模式</label>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>上传超时（分钟）：</label>
              <input type="number" class="input-xs site-setting" data-field="uploadTimeout" value="${Math.round((s.uploadTimeout || 120000) / 60000)}" min="1" max="10">
            </div>
            <div class="form-group">
              <label>失败重试次数：</label>
              <input type="number" class="input-xs site-setting" data-field="maxRetries" value="${s.maxRetries || 3}" min="1" max="5">
            </div>
          </div>
        </div>
        ${renderSiteFailActionSection(s)}
        ${s.role === 'imagegen' ? renderSiteImageGenSection(s) : ''}
        ${s.role === 'imagegen' ? renderSiteInterceptorSection(s) : ''}
        <div class="site-presteps-section">
          <h4>前置步骤</h4>
          <p class="hint">每次切换到该网站后、正式操作前，按顺序执行的自动操作</p>
          <div class="prestep-list" id="preSteps_${s.id}"></div>
          <button class="btn-sm mt-8 btn-add-prestep" data-site-id="${s.id}">+ 添加前置步骤</button>
        </div>
      </div>
    </div>`;
  }).join('');

  // Bind events for each site card
  list.querySelectorAll('.site-card').forEach(card => {
    const id = card.dataset.id;
    const site = config.sites.find(x => x.id === id);
    if (!site) return;

    // Header field changes
    card.querySelectorAll('.site-card-header [data-field]').forEach(input => {
      const field = input.dataset.field;

      input.addEventListener('change', () => {
        if (field === 'enabled') {
          site.enabled = !!input.checked;
        } else if (field === 'role') {
          site[field] = input.value.trim();
          renderSitesConfig();
        } else {
          site[field] = input.value.trim();
        }
      });

      if (field === 'name' || field === 'url') {
        input.addEventListener('input', () => {
          site[field] = input.value.trim();
        });
      }
    });

    // Action buttons
    card.querySelectorAll('.site-card-actions [data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'toggle') {
          const body = document.getElementById(`siteBody_${id}`);
          if (body) body.style.display = body.style.display === 'none' ? 'block' : 'none';
        } else if (act === 'export-site') {
          exportSiteConfig(id);
        } else if (act === 'import-site') {
          importSiteConfig(id);
        } else {
          handleSiteAction(id, act);
        }
      });
    });

    // Aux element config/verify buttons
    card.querySelectorAll('.btn-config').forEach(btn => {
      btn.addEventListener('click', () => startElementPick(btn.dataset.siteId, btn.dataset.cfgKey));
    });
    card.querySelectorAll('.btn-verify').forEach(btn => {
      btn.addEventListener('click', () => verifyElement(btn.dataset.siteId, btn.dataset.cfgKey));
    });

    card.querySelectorAll('.aux-selector-main').forEach(input => {
      input.addEventListener('change', () => {
        const cfgKey = input.dataset.cfgKey;
        if (!site[cfgKey]) site[cfgKey] = { selector: '', candidateSelectors: [] };
        site[cfgKey].selector = input.value.trim();
      });
    });
    card.querySelectorAll('.aux-selector-candidates').forEach(input => {
      input.addEventListener('change', () => {
        const cfgKey = input.dataset.cfgKey;
        if (!site[cfgKey]) site[cfgKey] = { selector: '', candidateSelectors: [] };
        site[cfgKey].candidateSelectors = input.value.split(',').map(s => s.trim()).filter(Boolean);
      });
    });

    // 操作步骤：配置/验证/删除/上下移动/修改属性
    card.querySelectorAll('.btn-opstep-config').forEach(btn => {
      btn.addEventListener('click', () => startOpStepPick(btn.dataset.siteId, btn.dataset.stepId));
    });
    card.querySelectorAll('.btn-opstep-verify').forEach(btn => {
      btn.addEventListener('click', () => verifyOpStep(btn.dataset.siteId, btn.dataset.stepId));
    });
    card.querySelectorAll('[data-opstep-act]').forEach(btn => {
      btn.addEventListener('click', () => handleOpStepAction(btn.dataset.siteId, btn.dataset.stepId, btn.dataset.opstepAct));
    });
    card.querySelectorAll('[data-opstep-field]').forEach(input => {
      input.addEventListener('change', () => {
        const val = input.type === 'checkbox' ? input.checked : input.value;
        handleOpStepFieldChange(id, input.dataset.stepId, input.dataset.opstepField, val);
      });
    });

    card.querySelectorAll('.opstep-selector-main').forEach(input => {
      input.addEventListener('change', () => {
        const stepId = input.dataset.stepId;
        const step = site.operationSteps?.find(s => s.id === stepId);
        if (!step) return;
        const def = STEP_TYPE_DEFS[step.type] || {};
        if (!step.features) step.features = { selector: '', candidateSelectors: [], intent: def.featureIntent || '' };
        step.features.selector = input.value.trim();
      });
    });
    card.querySelectorAll('.opstep-selector-candidates').forEach(input => {
      input.addEventListener('change', () => {
        const stepId = input.dataset.stepId;
        const step = site.operationSteps?.find(s => s.id === stepId);
        if (!step) return;
        const def = STEP_TYPE_DEFS[step.type] || {};
        if (!step.features) step.features = { selector: '', candidateSelectors: [], intent: def.featureIntent || '' };
        step.features.candidateSelectors = input.value.split(',').map(s => s.trim()).filter(Boolean);
      });
    });

    // 新增操作步骤
    card.querySelector('.btn-add-opstep')?.addEventListener('click', () => {
      const sel = card.querySelector('.opstep-new-type');
      addOpStepForSite(id, sel?.value || 'click');
    });

    // Site settings (verifyMode, uploadTimeout, maxRetries)
    card.querySelectorAll(`[name="verifyMode_${id}"]`).forEach(r => {
      r.addEventListener('change', () => { site.verifyMode = r.value; });
    });
    card.querySelectorAll('.site-setting').forEach(input => {
      input.addEventListener('change', () => {
        const field = input.dataset.field;
        if (field === 'uploadTimeout') {
          site.uploadTimeout = (parseInt(input.value) || 2) * 60000;
        } else if (field === 'maxRetries') {
          site.maxRetries = parseInt(input.value) || 3;
        }
      });
    });

    // failAction per-site
    card.querySelectorAll(`[name="failAction_${id}"]`).forEach(r => {
      r.addEventListener('change', () => { site.failAction = r.value; });
    });
    card.querySelectorAll('.site-reply-timeout').forEach(el => {
      if (el.dataset.siteId !== id) return;
      el.addEventListener('change', () => {
        site.replyTimeoutMs = Math.max(1, parseInt(el.value) || 3) * 60000;
      });
    });
    card.querySelectorAll('.site-reply-stall').forEach(el => {
      if (el.dataset.siteId !== id) return;
      el.addEventListener('change', () => {
        site.replyStallTimeoutMs = Math.max(0, parseInt(el.value) || 0) * 1000;
      });
    });

    // imageGenConfig per-site
    if (site.role === 'imagegen') {
      const pfx = `ig_${id}`;
      card.querySelectorAll(`[name="${pfx}_sendMode"]`).forEach(r => {
        r.addEventListener('change', () => {
          if (!site.imageGenConfig) site.imageGenConfig = {};
          site.imageGenConfig.sendMode = r.value;
          const batchBlock = card.querySelector(`.site-ig-batch-settings[data-site-id="${id}"]`);
          if (batchBlock) batchBlock.style.display = r.value === 'batch' ? '' : 'none';
        });
      });
      card.querySelectorAll(`[name="${pfx}_batchSize"]`).forEach(r => {
        r.addEventListener('change', () => {
          if (!site.imageGenConfig) site.imageGenConfig = {};
          if (r.value === 'custom') {
            const ci = card.querySelector(`.site-ig-custom-batch[data-site-id="${id}"]`);
            site.imageGenConfig.batchSize = parseInt(ci?.value) || 10;
          } else {
            site.imageGenConfig.batchSize = parseInt(r.value) || 10;
          }
        });
      });
      const customBatchInput = card.querySelector(`.site-ig-custom-batch[data-site-id="${id}"]`);
      if (customBatchInput) {
        customBatchInput.addEventListener('change', () => {
          if (!site.imageGenConfig) site.imageGenConfig = {};
          const customRadio = card.querySelector(`[name="${pfx}_batchSize"][value="custom"]`);
          if (customRadio?.checked) {
            site.imageGenConfig.batchSize = parseInt(customBatchInput.value) || 10;
          }
        });
      }
      card.querySelectorAll('.site-ig-field').forEach(el => {
        if (el.dataset.siteId !== id) return;
        el.addEventListener('change', () => {
          if (!site.imageGenConfig) site.imageGenConfig = {};
          const f = el.dataset.igField;
          if (f === 'batchTimeout') {
            site.imageGenConfig.batchTimeout = (parseInt(el.value) || 5) * 60000;
          } else {
            site.imageGenConfig[f] = parseInt(el.value) || 0;
          }
        });
      });
      const pfFirstEl = card.querySelector(`.site-ig-prefix-first[data-site-id="${id}"]`);
      if (pfFirstEl) {
        pfFirstEl.addEventListener('change', () => {
          if (!site.imageGenConfig) site.imageGenConfig = {};
          site.imageGenConfig.batchPrefixFirst = pfFirstEl.value;
        });
      }
      const pfContEl = card.querySelector(`.site-ig-prefix-continue[data-site-id="${id}"]`);
      if (pfContEl) {
        pfContEl.addEventListener('change', () => {
          if (!site.imageGenConfig) site.imageGenConfig = {};
          site.imageGenConfig.batchPrefixContinue = pfContEl.value;
        });
      }

      // interceptorConfig per-site
      card.querySelectorAll('.site-ic-field').forEach(el => {
        if (el.dataset.siteId !== id) return;
        el.addEventListener('change', () => {
          if (!site.interceptorConfig) site.interceptorConfig = {};
          const f = el.dataset.icField;
          if (f === 'hookInPlaceReplace') {
            site.interceptorConfig.hookInPlaceReplace = !!el.checked;
          } else if (f === 'thumbUrlPaths') {
            site.interceptorConfig.thumbUrlPaths = el.value.split(',').map(s => s.trim()).filter(Boolean);
          } else {
            site.interceptorConfig[f] = el.value.trim();
          }
        });
      });
    }

    // Pre-steps
    card.querySelector('.btn-add-prestep')?.addEventListener('click', () => addPreStepForSite(id));
    renderPreStepsForSite(id);
  });
}

function addSite() {
  ensureSites();
  const id = `site_${Date.now()}`;
  config.sites.push({
    id,
    name: `网站${config.sites.length + 1}`,
    url: '',
    role: 'analysis',
    enabled: true,
    order: config.sites.length + 1,
    failAction: 'skip',
    operationSteps: [
      { id: _genStepId(), type: 'upload', features: null },
      { id: _genStepId(), type: 'input',  features: null },
      { id: _genStepId(), type: 'send',   features: null }
    ]
  });
  renderSitesConfig();
}

// ═══════════════════════════════════════════
// 操作步骤 UI/交互
// ═══════════════════════════════════════════

function renderOpStepRow(site, step, idx, total) {
  const def = STEP_TYPE_DEFS[step.type] || { label: step.type, needsFeatures: false, icon: '🔧' };
  const hasFeatures = !!step.features;
  const featLabel = def.needsFeatures
    ? (hasFeatures ? '✅ 已配置' : '⚠️ 未配置')
    : '— 无需选择器';
  const featClass = def.needsFeatures ? (hasFeatures ? 'ok' : '') : 'muted';

  // 额外参数输入（wait 的秒数、waitForElement 的超时/条件）
  let extraParams = '';
  if (step.type === 'wait') {
    const sec = Math.max(0, Math.round((step.duration || 1000) / 1000));
    extraParams = `
      <label class="opstep-inline">等待
        <input type="number" class="input-xs" data-opstep-field="durationSec" data-step-id="${step.id}"
               value="${sec}" min="0" step="1"> 秒
      </label>`;
  } else if (step.type === 'waitForElement') {
    const cond    = step.condition || 'appear';
    const timeSec = Math.max(1, Math.round((step.timeout || 30000) / 1000));
    extraParams = `
      <label class="opstep-inline">条件
        <select data-opstep-field="condition" data-step-id="${step.id}">
          <option value="appear"${cond === 'appear' ? ' selected' : ''}>等待出现</option>
          <option value="disappear"${cond === 'disappear' ? ' selected' : ''}>等待消失</option>
        </select>
      </label>
      <label class="opstep-inline">超时
        <input type="number" class="input-xs" data-opstep-field="timeoutSec" data-step-id="${step.id}"
               value="${timeSec}" min="1" step="1"> 秒
      </label>`;
  } else if (step.type === 'click') {
    extraParams = `
      <label class="opstep-inline">
        <input type="checkbox" data-opstep-field="skipIfPressed" data-step-id="${step.id}"
               ${step.skipIfPressed ? 'checked' : ''}>
        切换按钮模式（已激活时跳过，防止重复点击关闭）
      </label>`;
  }

  return `
  <div class="opstep-row" data-step-id="${step.id}">
    <div class="opstep-order">
      <button class="btn-xs" data-opstep-act="up"   data-site-id="${site.id}" data-step-id="${step.id}" ${idx === 0 ? 'disabled' : ''}>↑</button>
      <span class="opstep-index">${idx + 1}</span>
      <button class="btn-xs" data-opstep-act="down" data-site-id="${site.id}" data-step-id="${step.id}" ${idx === total - 1 ? 'disabled' : ''}>↓</button>
    </div>
    <div class="opstep-body">
      <div class="opstep-line-1">
        <span class="opstep-type-badge">${def.icon} ${def.label}</span>
        <input class="opstep-label-input" placeholder="步骤备注（可选）"
               data-opstep-field="label" data-step-id="${step.id}"
               value="${escapeHtml(step.label || '')}">
        ${def.needsFeatures ? `
          <span class="opstep-feature-status ${featClass}">${featLabel}</span>
          <button class="btn-xs btn-opstep-config" data-site-id="${site.id}" data-step-id="${step.id}">🖱️ 选择元素</button>
          <button class="btn-xs btn-opstep-verify" data-site-id="${site.id}" data-step-id="${step.id}">✅ 验证</button>
        ` : `<span class="opstep-feature-status muted">${featLabel}</span>`}
        <button class="btn-xs btn-sm-danger" data-opstep-act="del"
                data-site-id="${site.id}" data-step-id="${step.id}">删除</button>
      </div>
      ${extraParams ? `<div class="opstep-line-2">${extraParams}</div>` : ''}
      ${def.needsFeatures ? `
      <div class="opstep-line-selector">
        <label class="selector-label">选择器：</label>
        <input type="text" class="input-selector opstep-selector-main"
               data-site-id="${site.id}" data-step-id="${step.id}"
               value="${escapeHtml(step.features?.selector || '')}"
               placeholder="CSS选择器，如 input[type=&quot;file&quot;][accept*=&quot;.png&quot;]">
        <label class="selector-label" style="margin-left:8px;">备选：</label>
        <input type="text" class="input-selector opstep-selector-candidates"
               data-site-id="${site.id}" data-step-id="${step.id}"
               value="${escapeHtml((step.features?.candidateSelectors || []).join(', '))}"
               placeholder="备选选择器（逗号分隔，可选）">
      </div>` : ''}
    </div>
  </div>`;
}

function addOpStepForSite(siteId, type) {
  const site = findSiteById(siteId);
  if (!site) return;
  if (!Array.isArray(site.operationSteps)) site.operationSteps = [];
  const def = STEP_TYPE_DEFS[type];
  if (!def) return;
  const newStep = { id: _genStepId(), type, features: null };
  if (type === 'wait') newStep.duration = 3000;
  if (type === 'waitForElement') {
    newStep.condition = 'appear';
    newStep.timeout   = 30000;
  }
  site.operationSteps.push(newStep);
  renderSitesConfig();
}

function handleOpStepAction(siteId, stepId, action) {
  const site = findSiteById(siteId);
  if (!site || !Array.isArray(site.operationSteps)) return;
  const idx = site.operationSteps.findIndex(s => s.id === stepId);
  if (idx < 0) return;
  if (action === 'del') {
    site.operationSteps.splice(idx, 1);
  } else if (action === 'up' && idx > 0) {
    const tmp = site.operationSteps[idx - 1];
    site.operationSteps[idx - 1] = site.operationSteps[idx];
    site.operationSteps[idx] = tmp;
  } else if (action === 'down' && idx < site.operationSteps.length - 1) {
    const tmp = site.operationSteps[idx + 1];
    site.operationSteps[idx + 1] = site.operationSteps[idx];
    site.operationSteps[idx] = tmp;
  }
  renderSitesConfig();
}

function handleOpStepFieldChange(siteId, stepId, field, value) {
  const site = findSiteById(siteId);
  if (!site || !Array.isArray(site.operationSteps)) return;
  const step = site.operationSteps.find(s => s.id === stepId);
  if (!step) return;
  if (field === 'label') {
    step.label = value;
  } else if (field === 'durationSec') {
    const n = Math.max(0, parseInt(value) || 0);
    step.duration = n * 1000;
  } else if (field === 'timeoutSec') {
    const n = Math.max(1, parseInt(value) || 30);
    step.timeout = n * 1000;
  } else if (field === 'condition') {
    step.condition = value === 'disappear' ? 'disappear' : 'appear';
  } else if (field === 'skipIfPressed') {
    step.skipIfPressed = !!value;
  }
}

async function startOpStepPick(siteId, stepId) {
  const site = findSiteById(siteId);
  if (!site) return;
  const step = site.operationSteps?.find(s => s.id === stepId);
  if (!step) return;
  const def = STEP_TYPE_DEFS[step.type];
  if (!def?.needsFeatures) return;

  const target = await findTabForSite(siteId);
  if (!target) {
    alert(`请先在浏览器中打开「${site.name || site.url}」网站，然后再点击配置按钮`);
    return;
  }

  const callbackKey = `${siteId}::opstep:${stepId}`;
  pendingPickKey = callbackKey;

  await chrome.tabs.update(target.id, { active: true });
  await chrome.windows.update(target.windowId, { focused: true });

  try {
    await chrome.tabs.sendMessage(target.id, {
      type: 'START_PICKING',
      data: { callbackKey, label: def.label }
    });
  } catch (err) {
    alert(`无法启动元素选择（${err.message}）\n请刷新「${site.name}」页面后重试`);
    pendingPickKey = null;
  }
}

async function verifyOpStep(siteId, stepId) {
  const site = findSiteById(siteId);
  if (!site) return;
  const step = site.operationSteps?.find(s => s.id === stepId);
  if (!step) { alert('步骤不存在'); return; }
  if (!step.features) {
    alert('该步骤尚未绑定元素，请先点击「选择元素」');
    return;
  }
  const target = await findTabForSite(siteId);
  if (!target) {
    alert(`请先打开「${site.name || site.url}」网站`);
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(target.id, {
      type: 'HIGHLIGHT_ELEMENT',
      data: { features: step.features }
    });
    alert(response?.found
      ? '✅ 元素验证成功，已在页面上短暂高亮显示'
      : '❌ 未找到该元素，请重新配置'
    );
  } catch {
    alert('验证失败，请刷新目标网站页面后重试');
  }
}

function handleSiteAction(id, action) {
  ensureSites();
  const idx = config.sites.findIndex(s => s.id === id);
  if (idx < 0) return;
  if (action === 'del') {
    config.sites.splice(idx, 1);
  }
  if (action === 'up' && idx > 0) {
    const tmp = config.sites[idx - 1];
    config.sites[idx - 1] = config.sites[idx];
    config.sites[idx] = tmp;
  }
  if (action === 'down' && idx < config.sites.length - 1) {
    const tmp = config.sites[idx + 1];
    config.sites[idx + 1] = config.sites[idx];
    config.sites[idx] = tmp;
  }
  config.sites = config.sites.map((s, i) => ({ ...s, order: i + 1 }));
  renderSitesConfig();
}

// ═══════════════════════════════════════════
// 前置步骤配置 UI
// ═══════════════════════════════════════════

const OP_TYPE_LABELS = {
  CLICK:        '点击元素',
  INPUT:        '输入文字',
  WAIT_SECONDS: '等待（秒）',
  VERIFY_TEXT:  '验证文字',
  VERIFY_CLASS: '验证CSS类'
};

const SUCCESS_TYPE_LABELS = {
  WAIT_APPEAR:    '等待出现',
  WAIT_DISAPPEAR: '等待消失'
};

const FAILURE_LABELS = {
  SKIP: '跳过继续',
  STOP: '暂停任务'
};

function findSiteByRole(role) {
  ensureSites();
  return config.sites.find(s =>
    s.role === role && s.enabled !== false
  ) || config.sites.find(s => s.role === role);
}

function findSiteById(siteId) {
  ensureSites();
  return config.sites.find(s => s.id === siteId);
}

function renderPreStepsForSite(siteId) {
  const list = document.getElementById(`preSteps_${siteId}`);
  if (!list) return;
  const site = findSiteById(siteId);
  if (!site) return;
  if (!Array.isArray(site.preSteps)) site.preSteps = [];

  const steps = site.preSteps;

  if (!steps.length) {
    list.innerHTML = '<p class="hint" style="margin:4px 0">暂无前置步骤</p>';
    return;
  }

  list.innerHTML = steps.map((step, i) => `
    <div class="prestep-item" data-idx="${i}">
      <div class="prestep-header">
        <span class="prestep-order">#${i + 1}</span>
        <input class="prestep-name" data-field="name" value="${escapeHtml(step.name || '')}" placeholder="步骤名称">
        <div class="prestep-actions">
          <button class="btn-xs" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn-xs" data-act="down" ${i === steps.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn-xs btn-danger" data-act="del">×</button>
        </div>
      </div>
      <div class="prestep-body">
        <div class="prestep-row">
          <label>操作类型</label>
          <select data-field="operationType">
            ${Object.entries(OP_TYPE_LABELS).map(([v, l]) =>
              `<option value="${v}" ${step.operationType === v ? 'selected' : ''}>${l}</option>`
            ).join('')}
          </select>
        </div>
        <div class="prestep-row" ${step.operationType === 'WAIT_SECONDS' ? 'style="display:none"' : ''}>
          <label>CSS 选择器</label>
          <input data-field="selector" value="${escapeHtml(step.selector || '')}" placeholder=".class 或 #id">
        </div>
        <div class="prestep-row" ${step.operationType === 'INPUT' ? '' : 'style="display:none"'}>
          <label>输入内容</label>
          <input data-field="inputValue" value="${escapeHtml(step.inputValue || '')}" placeholder="文字内容">
        </div>
        <div class="prestep-row">
          <label>成功验证选择器</label>
          <input data-field="successSelector" value="${escapeHtml(step.successSelector || '')}" placeholder="留空 = 不验证">
        </div>
        <div class="prestep-row">
          <label>验证方式</label>
          <select data-field="successType">
            ${Object.entries(SUCCESS_TYPE_LABELS).map(([v, l]) =>
              `<option value="${v}" ${step.successType === v ? 'selected' : ''}>${l}</option>`
            ).join('')}
          </select>
        </div>
        <div class="prestep-row prestep-row-inline">
          <div>
            <label>超时(ms)</label>
            <input type="number" data-field="timeout" value="${step.timeout || 5000}" min="500" max="60000" class="input-xs">
          </div>
          <div>
            <label>重试次数</label>
            <input type="number" data-field="maxRetries" value="${step.maxRetries || 3}" min="1" max="10" class="input-xs">
          </div>
          <div>
            <label>失败策略</label>
            <select data-field="onFailure">
              ${Object.entries(FAILURE_LABELS).map(([v, l]) =>
                `<option value="${v}" ${step.onFailure === v ? 'selected' : ''}>${l}</option>`
              ).join('')}
            </select>
          </div>
        </div>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.prestep-item').forEach(item => {
    const idx = parseInt(item.dataset.idx);

    item.querySelectorAll('[data-field]').forEach(input => {
      const ev = input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(ev, () => {
        const field = input.dataset.field;
        const s = steps[idx];
        if (!s) return;
        if (field === 'timeout' || field === 'maxRetries') {
          s[field] = parseInt(input.value) || 0;
        } else {
          s[field] = input.value;
        }
        if (field === 'operationType') renderPreStepsForSite(siteId);
      });
    });

    item.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => handlePreStepActionForSite(siteId, idx, btn.dataset.act));
    });
  });
}

function addPreStepForSite(siteId) {
  const site = findSiteById(siteId);
  if (!site) return;
  if (!Array.isArray(site.preSteps)) site.preSteps = [];
  site.preSteps.push({
    name: `步骤${site.preSteps.length + 1}`,
    operationType: 'CLICK',
    selector: '',
    inputValue: '',
    successSelector: '',
    successType: 'WAIT_APPEAR',
    timeout: 5000,
    maxRetries: 3,
    onFailure: 'SKIP',
    delayMin: 400,
    delayMax: 700
  });
  renderPreStepsForSite(siteId);
}

function handlePreStepActionForSite(siteId, idx, action) {
  const site = findSiteById(siteId);
  if (!site || !Array.isArray(site.preSteps)) return;
  const steps = site.preSteps;
  if (idx < 0 || idx >= steps.length) return;

  if (action === 'del') {
    steps.splice(idx, 1);
  } else if (action === 'up' && idx > 0) {
    [steps[idx - 1], steps[idx]] = [steps[idx], steps[idx - 1]];
  } else if (action === 'down' && idx < steps.length - 1) {
    [steps[idx], steps[idx + 1]] = [steps[idx + 1], steps[idx]];
  }
  renderPreStepsForSite(siteId);
}

// ═══════════════════════════════════════════
// 高级设置（错误策略 + 超时）
// ═══════════════════════════════════════════

function renderAdvancedConfig() {
  const adv = config.advancedConfig || {};

  const plEl = document.getElementById('pageLoadTimeout');
  if (plEl) plEl.value = Math.round((adv.pageLoadTimeout || 30000) / 1000);

  const isolation = adv.productIsolation || 'reopen';
  const isoEl = document.querySelector(`[name="productIsolation"][value="${isolation}"]`);
  if (isoEl) isoEl.checked = true;
  toggleIsolationContinueHint(isolation === 'continue');

  const mrEl = document.getElementById('maxRefreshRetries');
  if (mrEl) mrEl.value = adv.maxRefreshRetries || 3;

  const dciEl = document.getElementById('debugCompareInterceptors');
  if (dciEl) dciEl.checked = !!adv.debugCompareInterceptors;

  document.querySelectorAll('[name="productIsolation"]').forEach(r => {
    r.addEventListener('change', () => {
      toggleIsolationContinueHint(r.value === 'continue' && r.checked);
    });
  });

  refreshErrorLogs();
}

function toggleIsolationContinueHint(show) {
  const el = document.getElementById('isolationContinueHint');
  if (el) el.style.display = show ? '' : 'none';
}

/**
 * 按当前已启用的站点，为每个站点渲染一个失败策略组。
 * 存储结构：config.advancedConfig.failActionBySite = { [siteId]: 'skip' | 'pause' | 'stop' }
 * 同时派生 analysisFailAction / imagegenFailAction 做向后兼容。
 */
function readAdvancedConfig() {
  // failAction is now per-site — derive legacy mirrors from site objects
  const firstByRole = (role) =>
    (config.sites || []).find(s => s.enabled !== false && s.role === role);
  const analysisSite = firstByRole('analysis');
  const imagegenSite = firstByRole('imagegen');

  const failActionBySite = {};
  (config.sites || []).forEach(s => {
    if (s.failAction) failActionBySite[s.id] = s.failAction;
  });

  const legacyReplyTimeout = (analysisSite?.replyTimeoutMs)
    || config.advancedConfig?.claudeReplyTimeout || 300000;
  const legacyStallTimeout = Number.isFinite(analysisSite?.replyStallTimeoutMs)
    ? analysisSite.replyStallTimeoutMs
    : (config.advancedConfig?.replyStallTimeout ?? 45000);

  return {
    failActionBySite,
    analysisFailAction: analysisSite?.failAction || config.advancedConfig?.analysisFailAction || 'skip',
    imagegenFailAction: imagegenSite?.failAction || config.advancedConfig?.imagegenFailAction || 'skip',
    claudeReplyTimeout: legacyReplyTimeout,
    replyStallTimeout:  legacyStallTimeout,
    pageLoadTimeout:
      (parseInt(document.getElementById('pageLoadTimeout')?.value) || 30) * 1000,
    productIsolation:
      document.querySelector('[name="productIsolation"]:checked')?.value || 'reopen',
    maxRefreshRetries:
      parseInt(document.getElementById('maxRefreshRetries')?.value) || 3,
    debugCompareInterceptors:
      !!document.getElementById('debugCompareInterceptors')?.checked
  };
}

function refreshErrorLogs() {
  const list = document.getElementById('errorLogList');
  if (!list) return;

  chrome.storage.local.get('errorLogs', result => {
    const logs = result.errorLogs || [];
    if (!logs.length) {
      list.innerHTML = '<div class="empty-hint">暂无错误日志</div>';
      return;
    }

    list.innerHTML = logs.slice().reverse().map(entry => {
      const time = entry.time || '';
      const msg = escapeHtml(entry.message || entry.error || JSON.stringify(entry));
      const lvl = entry.level === 'error' ? 'log-error' : 'log-warn';
      return `<div class="log-entry ${lvl}">
        <span class="log-time">${escapeHtml(time)}</span>
        <span class="log-msg">${msg}</span>
      </div>`;
    }).join('');
  });
}

function clearErrorLogs() {
  chrome.storage.local.set({ errorLogs: [] }, () => {
    refreshErrorLogs();
    showSaveToast('✅ 错误日志已清空');
  });
}

// ═══════════════════════════════════════════
// 配置预设方案
// ═══════════════════════════════════════════

let presets = [];

function loadPresets() {
  return new Promise(resolve => {
    chrome.storage.local.get('configPresets', r => {
      presets = r.configPresets || [];
      resolve();
    });
  });
}

function savePresetsToStorage() {
  chrome.storage.local.set({ configPresets: presets });
}

function renderPresets() {
  const sel = document.getElementById('presetSelector');
  if (!sel) return;

  sel.innerHTML = '<option value="">— 选择预设 —</option>' +
    presets.map((p, i) =>
      `<option value="${i}">${escapeHtml(p.name)} (${p.savedAt || ''})</option>`
    ).join('');
}

function saveAsPreset() {
  const name = prompt('请输入预设名称：', `预设${presets.length + 1}`);
  if (!name?.trim()) return;

  presets.push({
    name: name.trim(),
    savedAt: new Date().toLocaleString('zh-CN'),
    config: JSON.parse(JSON.stringify(normalizeConfig(config)))
  });

  savePresetsToStorage();
  renderPresets();
  showSaveToast('✅ 预设已保存');
}

function loadPreset() {
  const sel = document.getElementById('presetSelector');
  const idx = parseInt(sel?.value);
  if (isNaN(idx) || !presets[idx]) {
    alert('请先选择一个预设');
    return;
  }

  if (!confirm(`确定加载预设"${presets[idx].name}"？当前未保存的配置将被覆盖。`)) return;

  config = normalizeConfig(presets[idx].config);
  renderAll();
  saveConfig(true);
  showSaveToast(`✅ 已加载预设"${presets[idx].name}"`);
}

function deletePreset() {
  const sel = document.getElementById('presetSelector');
  const idx = parseInt(sel?.value);
  if (isNaN(idx) || !presets[idx]) {
    alert('请先选择一个预设');
    return;
  }

  if (!confirm(`确定删除预设"${presets[idx].name}"？`)) return;

  presets.splice(idx, 1);
  savePresetsToStorage();
  renderPresets();
  showSaveToast('✅ 预设已删除');
}

function exportConfigFile() {
  const payload = {
    ...normalizeConfig(config),
    version: '2.0',
    exportTime: new Date().toLocaleString('zh-CN'),
    globalConfig: {
      extractConfig: config.extractConfig,
      imageGenConfig: config.imageGenConfig
    }
  };

  const blob = new Blob(
    [JSON.stringify(payload, null, 2)],
    { type: 'application/json;charset=utf-8' }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date();
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('');
  a.href = url;
  a.download = `config_v2.0_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showSaveToast('✅ 配置文件已导出');
}

function importConfigFile(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || '{}'));
      config = normalizeConfig(parsed);
      renderAll();
      saveConfig(true);
      showSaveToast('✅ 配置文件已导入');
    } catch (err) {
      alert('导入失败：' + err.message);
    } finally {
      ev.target.value = '';
    }
  };
  reader.onerror = () => {
    alert('导入失败：文件读取错误');
    ev.target.value = '';
  };
  reader.readAsText(file, 'utf-8');
}

function addColumn() {
  const input = document.getElementById('newColumnInput');
  if (!input) return;
  const col = input.value.trim();
  if (!col) return;

  if (!config.selectedColumns) config.selectedColumns = [];
  if (!config.selectedColumns.includes(col)) {
    config.selectedColumns.push(col);
    renderColumnList();
  }
  input.value = '';
}

function toggleMarkerSettings(show) {
  const el = document.getElementById('markerSettings');
  if (el) el.style.display = show ? 'block' : 'none';
}

// ═══════════════════════════════════════════
// 元素选择
// ═══════════════════════════════════════════

async function findTabForSite(siteId) {
  const site = findSiteById(siteId);
  if (!site?.url) return null;

  const getBaseDomain = (hostname) => {
    const parts = hostname.split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
  };

  let targetDomain = '';
  try {
    targetDomain = getBaseDomain(new URL(site.url).hostname.toLowerCase());
  } catch {
    try { targetDomain = getBaseDomain(new URL('https://' + site.url).hostname.toLowerCase()); }
    catch { return null; }
  }

  const tabs = await chrome.tabs.query({});
  return tabs.find(t => {
    if (!t.url || t.url.startsWith('chrome') || t.url.startsWith('edge')) return false;
    try { return getBaseDomain(new URL(t.url).hostname.toLowerCase()) === targetDomain; }
    catch { return false; }
  }) || null;
}

async function startElementPick(siteId, cfgKey) {
  const site = findSiteById(siteId);
  if (!site) { alert('未找到该网站配置'); return; }

  const elDef = getAuxElementsForSite(site).find(e => e.cfgKey === cfgKey);
  const label = elDef?.label || cfgKey;

  const target = await findTabForSite(siteId);
  if (!target) {
    alert(`请先在浏览器中打开「${site.name || site.url}」网站，然后再点击配置按钮`);
    return;
  }

  const callbackKey = `${siteId}::${cfgKey}`;
  pendingPickKey = callbackKey;

  await chrome.tabs.update(target.id, { active: true });
  await chrome.windows.update(target.windowId, { focused: true });

  try {
    await chrome.tabs.sendMessage(target.id, {
      type: 'START_PICKING',
      data: { callbackKey, label }
    });
  } catch (err) {
    alert(`无法启动元素选择（${err.message}）\n请刷新「${site.name}」页面后重试`);
    pendingPickKey = null;
  }
}

async function verifyElement(siteId, cfgKey) {
  const site = findSiteById(siteId);
  if (!site) return;

  const features = site[cfgKey];
  if (!features) {
    alert('该元素尚未配置，请先点击「点击配置」');
    return;
  }

  const target = await findTabForSite(siteId);
  if (!target) {
    alert(`请先打开「${site.name || site.url}」网站`);
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(target.id, {
      type: 'HIGHLIGHT_ELEMENT',
      data: { features }
    });
    alert(response?.found
      ? '✅ 元素验证成功，已在页面上短暂高亮显示'
      : '❌ 未找到该元素，请重新配置'
    );
  } catch {
    alert('验证失败，请刷新目标网站页面后重试');
  }
}

function onMessage(msg) {
  if (!msg?.type) return;

  if (msg.type === 'ELEMENT_PICKED') {
    const { callbackKey, features } = msg.data || {};
    if (callbackKey !== pendingPickKey) return;

    savePickedElement(callbackKey, features);
    pendingPickKey = null;
  }

  if (msg.type === 'PICKING_CANCELLED') {
    if (msg.data?.callbackKey === pendingPickKey) {
      pendingPickKey = null;
    }
  }
}

function savePickedElement(callbackKey, features) {
  const [siteId, cfgKey] = callbackKey.split('::');
  const site = findSiteById(siteId);
  if (!site || !cfgKey) return;

  // 操作步骤元素：callbackKey 形如 `siteId::opstep:stepId`
  if (cfgKey.startsWith('opstep:')) {
    const stepId = cfgKey.slice('opstep:'.length);
    const step = site.operationSteps?.find(s => s.id === stepId);
    if (!step) return;
    const def = STEP_TYPE_DEFS[step.type];
    step.features = {
      ...(features || {}),
      intent: def?.featureIntent || 'generic',
      pickedAt: Date.now()
    };
    showSaveToast(`✅ "${def?.label || step.type}" 步骤已绑定元素`);
    renderSitesConfig();
    syncSitesToLegacyConfig();
    saveConfig(true);
    return;
  }

  // 辅助验证元素：常规 cfgKey
  const intentMap = {
    imageAreaFeatures: 'imageArea',
    loadingFeatures: 'loading',
    uploadLoadingFeatures: 'loading',
    uploadPreviewFeatures: 'preview',
    uploadDeleteFeatures: 'delete'
  };

  site[cfgKey] = {
    ...(features || {}),
    intent: intentMap[cfgKey] || 'generic',
    pickedAt: Date.now()
  };

  const elDef = getAuxElementsForSite(site).find(e => e.cfgKey === cfgKey);
  showSaveToast(`✅ "${elDef?.label || cfgKey}"配置已保存`);
  renderSitesConfig();
  syncSitesToLegacyConfig();
  saveConfig(true);
}

// ═══════════════════════════════════════════
// 提取测试
// ═══════════════════════════════════════════

function doTestExtract() {
  const testText = (document.getElementById('testInput')?.value || '').trim();
  const resultEl = document.getElementById('testResult');
  if (!resultEl) return;

  if (!testText) {
    showTestResult(resultEl, false, '请先粘贴Claude的完整回复文本');
    return;
  }

  const ec = readExtractConfig();

  try {
    const result = extractPromptsLocal(testText, ec);

    const previewLines = result.prompts.slice(0, 3).map((p, i) =>
      `${i + 1}. ${p.slice(0, 100)}${p.length > 100 ? '...' : ''}`
    ).join('\n');

    showTestResult(resultEl, true, [
      `✅ 提取成功`,
      ec.mode === 'marker' ? `找到标记位置：第 ${result.startPosition} 字符处` : '',
      `提取内容长度：${result.extractedLength} 字符`,
      `解析出提示词：${result.count} 条`,
      '',
      `前 ${Math.min(3, result.prompts.length)} 条预览：`,
      previewLines
    ].filter(l => l !== undefined).join('\n'));

  } catch (err) {
    showTestResult(resultEl, false, `❌ 提取失败：\n${err.message}`);
  }
}

function showTestResult(el, success, text) {
  el.style.display = 'block';
  el.className = `test-result${success ? '' : ' error'}`;
  el.textContent = text;
}

// 本地提取函数（不依赖content script）
function extractPromptsLocal(fullText, ec) {
  if (ec.mode === 'full') {
    const prompts = parsePromptsLocal(fullText, ec);
    return {
      promptText: fullText, prompts,
      startPosition: 0, extractedLength: fullText.length, count: prompts.length
    };
  }

  const rawStart = ec.startMarker;
  const startMarker = (rawStart && rawStart !== 'undefined' ? rawStart : '').trim();
  if (!startMarker) {
    const prompts = parsePromptsLocal(fullText, ec);
    return {
      promptText: fullText, prompts,
      startPosition: 0, extractedLength: fullText.length, count: prompts.length
    };
  }

  const startIndex = fullText.indexOf(startMarker);
  if (startIndex === -1) {
    const fallback = parsePromptsLocal(fullText, ec);
    if (fallback.length > 0) {
      return {
        promptText: fullText, prompts: fallback,
        startPosition: 0, extractedLength: fullText.length, count: fallback.length
      };
    }
    throw new Error(`未找到标记："${startMarker}"`);
  }

  let extractStart;
  if (ec.includeMarker !== false) {
    extractStart = startIndex;
  } else {
    const nl = fullText.indexOf('\n', startIndex + startMarker.length);
    extractStart = nl !== -1 ? nl + 1 : startIndex + startMarker.length;
  }

  let extractEnd = fullText.length;
  const endMarker = (ec.endMarker || '').trim();
  if (endMarker) {
    const ei = fullText.indexOf(endMarker, extractStart);
    if (ei !== -1) extractEnd = ei;
  }

  const promptText = fullText.slice(extractStart, extractEnd).trim();
  if (!promptText) throw new Error('提取到的内容为空');

  const prompts = parsePromptsLocal(promptText, ec);
  return {
    promptText, prompts,
    startPosition: startIndex, extractedLength: promptText.length, count: prompts.length
  };
}

function parsePromptsLocalByLines(text) {
  if (!text) return [];
  const pattern = /^(\d+[\.、\)]\s*|[一二三四五六七八九十百千]+[、\.]\s*)/;
  const lines = text.split('\n');
  const prompts = [];
  let cur = '';

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

function parsePromptsLocalInlineDigits(text) {
  if (!text || !/\d+[\.、\)]\s/.test(text)) return [];
  const parts = text.split(/(?<=[^\d.])(?=\d{1,3}[\.、\)]\s+)/);
  if (parts.length <= 1) return [];
  return parts.map(p => p.trim()).filter(p => p.length > 5);
}

function parsePromptsLocalByCustomPattern(text, patternStr) {
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

/** 与 background.js 中 parseNumberedPrompts 行为一致，供设置页「提取测试」预览 */
function parsePromptsLocal(text, ec) {
  if (!text) return [];

  if (ec?.promptSplitMode === 'custom' && ec.promptSplitPattern) {
    const custom = parsePromptsLocalByCustomPattern(text, ec.promptSplitPattern);
    if (custom.length > 0) return custom;
  }

  const byLines = parsePromptsLocalByLines(text);
  if (byLines.length > 1) return byLines;
  const blob = (byLines.length === 1 ? byLines[0] : text).trim();
  const inline = parsePromptsLocalInlineDigits(blob);
  if (inline.length > 1) return inline;
  if (byLines.length === 1) return byLines;
  const fromRaw = parsePromptsLocalInlineDigits(text.trim());
  return fromRaw.length ? fromRaw : [];
}

// ═══════════════════════════════════════════
// 读取当前表单值
// ═══════════════════════════════════════════

function readExtractConfig() {
  return {
    mode: document.querySelector('[name="extractMode"]:checked')?.value || 'marker',
    startMarker: (document.getElementById('startMarker')?.value || '').trim(),
    endMarker:   (document.getElementById('endMarker')?.value   || '').trim(),
    includeMarker: document.querySelector('[name="includeMarker"]:checked')?.value !== 'false',
    promptSplitMode: document.querySelector('[name="promptSplitMode"]:checked')?.value || 'auto',
    promptSplitPattern: (document.getElementById('promptSplitPattern')?.value || '').trim()
  };
}

// ═══════════════════════════════════════════
// 保存配置
// ═══════════════════════════════════════════

function exportSiteConfig(siteId) {
  syncSiteFieldsFromDOM();
  const site = config.sites.find(s => s.id === siteId);
  if (!site) { alert('找不到该站点'); return; }
  const data = JSON.parse(JSON.stringify(site));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `site_${(site.name || site.id).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importSiteConfig(siteId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || typeof data !== 'object') throw new Error('无效的站点配置');
        const idx = config.sites.findIndex(s => s.id === siteId);
        if (idx === -1) { alert('找不到该站点'); return; }
        const preserveKeys = ['id', 'order'];
        preserveKeys.forEach(k => { data[k] = config.sites[idx][k]; });
        config.sites[idx] = data;
        renderSitesConfig();
        showSaveToast('✅ 站点配置已导入（请保存以生效）');
      } catch (e) {
        alert('导入失败: ' + e.message);
      }
    };
    reader.readAsText(file);
  });
  input.click();
}

function syncSiteFieldsFromDOM() {
  document.querySelectorAll('.site-card').forEach(card => {
    const id = card.dataset.id;
    const site = config.sites.find(s => s.id === id);
    if (!site) return;

    const nameInput = card.querySelector('[data-field="name"]');
    if (nameInput) site.name = nameInput.value.trim();

    const urlInput = card.querySelector('[data-field="url"]');
    if (urlInput) site.url = urlInput.value.trim();

    const roleSelect = card.querySelector('[data-field="role"]');
    if (roleSelect) site.role = roleSelect.value;

    const enabledInput = card.querySelector('[data-field="enabled"]');
    if (enabledInput) site.enabled = !!enabledInput.checked;

    // failAction
    const faRadio = document.querySelector(`[name="failAction_${id}"]:checked`);
    if (faRadio) site.failAction = faRadio.value;

    // reply timeout/stall (analysis sites)
    const rtEl = card.querySelector(`.site-reply-timeout[data-site-id="${id}"]`);
    if (rtEl) site.replyTimeoutMs = Math.max(1, parseInt(rtEl.value) || 3) * 60000;
    const rsEl = card.querySelector(`.site-reply-stall[data-site-id="${id}"]`);
    if (rsEl) site.replyStallTimeoutMs = Math.max(0, parseInt(rsEl.value) || 0) * 1000;

    // imageGenConfig (imagegen sites)
    if (site.role === 'imagegen') {
      const pfx = `ig_${id}`;
      const smRadio = document.querySelector(`[name="${pfx}_sendMode"]:checked`);
      const bsRadio = document.querySelector(`[name="${pfx}_batchSize"]:checked`);
      if (smRadio || bsRadio) {
        if (!site.imageGenConfig) site.imageGenConfig = {};
        if (smRadio) site.imageGenConfig.sendMode = smRadio.value;
        if (bsRadio) {
          if (bsRadio.value === 'custom') {
            const ci = card.querySelector(`.site-ig-custom-batch[data-site-id="${id}"]`);
            site.imageGenConfig.batchSize = parseInt(ci?.value) || 10;
          } else {
            site.imageGenConfig.batchSize = parseInt(bsRadio.value) || 10;
          }
        }
      }
      card.querySelectorAll('.site-ig-field').forEach(el => {
        if (el.dataset.siteId !== id) return;
        if (!site.imageGenConfig) site.imageGenConfig = {};
        const f = el.dataset.igField;
        if (f === 'batchTimeout') {
          site.imageGenConfig.batchTimeout = (parseInt(el.value) || 5) * 60000;
        } else {
          site.imageGenConfig[f] = parseInt(el.value) || 0;
        }
      });
      const pfFirst = card.querySelector(`.site-ig-prefix-first[data-site-id="${id}"]`);
      if (pfFirst && site.imageGenConfig) site.imageGenConfig.batchPrefixFirst = pfFirst.value;
      const pfCont = card.querySelector(`.site-ig-prefix-continue[data-site-id="${id}"]`);
      if (pfCont && site.imageGenConfig) site.imageGenConfig.batchPrefixContinue = pfCont.value;

      // interceptorConfig
      card.querySelectorAll('.site-ic-field').forEach(el => {
        if (el.dataset.siteId !== id) return;
        if (!site.interceptorConfig) site.interceptorConfig = {};
        const f = el.dataset.icField;
        if (f === 'hookInPlaceReplace') {
          site.interceptorConfig.hookInPlaceReplace = !!el.checked;
        } else if (f === 'thumbUrlPaths') {
          site.interceptorConfig.thumbUrlPaths = el.value.split(',').map(s => s.trim()).filter(Boolean);
        } else {
          site.interceptorConfig[f] = el.value.trim();
        }
      });
    }

    // aux element selectors (replyFeatures, uploadLoadingFeatures, etc.)
    card.querySelectorAll('.aux-selector-main').forEach(input => {
      const cfgKey = input.dataset.cfgKey;
      if (!cfgKey) return;
      const val = input.value.trim();
      if (val) {
        if (!site[cfgKey]) site[cfgKey] = { selector: '', candidateSelectors: [] };
        site[cfgKey].selector = val;
      }
    });
    card.querySelectorAll('.aux-selector-candidates').forEach(input => {
      const cfgKey = input.dataset.cfgKey;
      if (!cfgKey || !site[cfgKey]) return;
      site[cfgKey].candidateSelectors = input.value.split(',').map(s => s.trim()).filter(Boolean);
    });

    // operation step selectors
    card.querySelectorAll('.opstep-selector-main').forEach(input => {
      const stepId = input.dataset.stepId;
      const step = site.operationSteps?.find(s => s.id === stepId);
      if (!step) return;
      const val = input.value.trim();
      if (val) {
        const def = STEP_TYPE_DEFS[step.type] || {};
        if (!step.features) step.features = { selector: '', candidateSelectors: [], intent: def.featureIntent || '' };
        step.features.selector = val;
      }
    });
    card.querySelectorAll('.opstep-selector-candidates').forEach(input => {
      const stepId = input.dataset.stepId;
      const step = site.operationSteps?.find(s => s.id === stepId);
      if (!step?.features) return;
      step.features.candidateSelectors = input.value.split(',').map(s => s.trim()).filter(Boolean);
    });

    // click step: skipIfPressed checkbox
    card.querySelectorAll('[data-opstep-field="skipIfPressed"]').forEach(input => {
      const stepId = input.dataset.stepId;
      const step = site.operationSteps?.find(s => s.id === stepId);
      if (step) step.skipIfPressed = !!input.checked;
    });
  });
}

function saveConfig(silent = false) {
  syncSiteFieldsFromDOM();

  // 读取列配置
  config.selectedColumns = Array.from(
    document.querySelectorAll('[name="column"]:checked, #columnList input[type="checkbox"]:checked')
  ).map(cb => cb.value).filter(Boolean);

  // 如果上面没拿到（checkbox name不同），从columnList读
  if (!config.selectedColumns.length) {
    config.selectedColumns = Array.from(
      document.querySelectorAll('#columnList input[type="checkbox"]')
    ).filter(cb => cb.checked).map(cb => cb.value);
  }

  config.messageTemplate = document.getElementById('messageTemplate')?.value || '';
  config.extractConfig   = readExtractConfig();

  // 流水线模式
  config.pipelineMode = document.querySelector('[name="pipelineMode"]:checked')?.value || 'both';

  // 从 sites 同步到 legacy arenaConfig/doubaoConfig
  syncSitesToLegacyConfig();

  // imageGenConfig: derive global mirror from primary imagegen site
  const _primaryIg = (config.sites || [])
    .filter(s => s.enabled !== false && s.role === 'imagegen')
    .sort((a, b) => (a.order || 999) - (b.order || 999))[0];
  if (_primaryIg?.imageGenConfig) {
    config.imageGenConfig = { ...config.imageGenConfig, ..._primaryIg.imageGenConfig };
  }

  config.exportColumnConfig = readExportColumnRules();

  config.advancedConfig = readAdvancedConfig();

  config.globalConfig = {
    extractConfig: config.extractConfig,
    imageGenConfig: config.imageGenConfig,
    advancedConfig: config.advancedConfig,
    exportColumnConfig: config.exportColumnConfig
  };

  if (!Array.isArray(config.messageTemplates) || !config.messageTemplates.length) {
    config.messageTemplates = [{
      id: 'tpl_default',
      name: '默认模板',
      selectedColumns: [...(config.selectedColumns || [])],
      content: config.messageTemplate || '',
      createdAt: new Date().toLocaleString('zh-CN'),
      lastModified: new Date().toLocaleString('zh-CN')
    }];
    config.activeTemplateId = 'tpl_default';
  } else {
    const active = config.messageTemplates.find(t => t.id === config.activeTemplateId) || config.messageTemplates[0];
    active.selectedColumns = [...(config.selectedColumns || [])];
    active.content = config.messageTemplate || '';
    active.lastModified = new Date().toLocaleString('zh-CN');
    config.activeTemplateId = active.id;
  }

  if (!Array.isArray(config.sites) || !config.sites.length) {
    config.sites = [
      {
        id: 'site_arena',
        name: 'Arena.ai',
        url: config.arenaConfig.siteUrl || 'https://arena.ai',
        role: 'analysis',
        enabled: true,
        order: 1
      },
      {
        id: 'site_doubao',
        name: '豆包',
        url: config.doubaoConfig.siteUrl || 'https://www.doubao.com',
        role: 'imagegen',
        enabled: true,
        order: 2
      }
    ];
  }
  config.version = '2.0';

  chrome.storage.local.set({ userConfig: config }, () => {
    if (!silent) showSaveToast('✅ 设置已保存');
  });
}

function syncSitesToLegacyConfig() {
  // 先把每个站点的 operationSteps 派生回顶层老字段（inputFeatures/uploadFeatures/sendFeatures）
  // 这样 popup.js、content/player.js 以及 background.js 中未改造的读取路径（如 fillViaCDP、
  // waitForSendButtonReady、verifyInputStateForRecovery 等）仍能正常工作
  (config.sites || []).forEach(s => deriveLegacyFeaturesFromSteps(s));

  const sorted = (config.sites || []).filter(s => s.enabled !== false)
    .sort((a, b) => (a.order || 999) - (b.order || 999));
  const analysis = sorted.find(s => s.role === 'analysis');
  const imagegen = sorted.find(s => s.role === 'imagegen');

  if (!config.arenaConfig) config.arenaConfig = {};
  if (!config.doubaoConfig) config.doubaoConfig = {};

  // Sync all features from primary analysis site → arenaConfig
  if (analysis) {
    config.arenaConfig.siteUrl = analysis.url;
    const featureKeys = ['inputFeatures', 'uploadFeatures', 'sendFeatures',
      'uploadLoadingFeatures', 'uploadPreviewFeatures', 'uploadDeleteFeatures'];
    featureKeys.forEach(k => {
      if (analysis[k]) config.arenaConfig[k] = analysis[k];
    });
    if (analysis.verifyMode) config.arenaConfig.verifyMode = analysis.verifyMode;
    if (analysis.uploadTimeout) config.arenaConfig.uploadTimeout = analysis.uploadTimeout;
    if (analysis.maxRetries) config.arenaConfig.maxRetries = analysis.maxRetries;
    // Sync selector convenience fields
    if (analysis.uploadLoadingFeatures) config.arenaConfig.uploadLoadingSelector = analysis.uploadLoadingFeatures.selector || '';
    if (analysis.uploadPreviewFeatures) config.arenaConfig.uploadPreviewSelector = analysis.uploadPreviewFeatures.selector || '';
    if (analysis.uploadDeleteFeatures)  config.arenaConfig.uploadDeleteSelector  = analysis.uploadDeleteFeatures.selector || '';
  }

  // Sync all features from primary imagegen site → doubaoConfig
  if (imagegen) {
    config.doubaoConfig.siteUrl = imagegen.url;
    const featureKeys = ['inputFeatures', 'uploadFeatures', 'sendFeatures',
      'uploadLoadingFeatures', 'uploadPreviewFeatures', 'uploadDeleteFeatures',
      'imageAreaFeatures', 'loadingFeatures'];
    featureKeys.forEach(k => {
      if (imagegen[k]) config.doubaoConfig[k] = imagegen[k];
    });
    if (imagegen.verifyMode) config.doubaoConfig.verifyMode = imagegen.verifyMode;
    if (imagegen.uploadTimeout) config.doubaoConfig.uploadTimeout = imagegen.uploadTimeout;
    if (imagegen.imageAreaFeatures) config.doubaoConfig.imageAreaSelector = imagegen.imageAreaFeatures.selector || '';
    if (imagegen.loadingFeatures)   config.doubaoConfig.loadingSelector   = imagegen.loadingFeatures.selector || '';
    if (imagegen.uploadPreviewFeatures) config.doubaoConfig.uploadPreviewSelector = imagegen.uploadPreviewFeatures.selector || '';
    if (imagegen.uploadDeleteFeatures)  config.doubaoConfig.uploadDeleteSelector  = imagegen.uploadDeleteFeatures.selector || '';
  }

  // 操作步骤：每站独立，且同步一份到对应 legacy config 供 background 直接读取
  if (analysis && Array.isArray(analysis.operationSteps)) {
    config.arenaConfig.operationSteps = analysis.operationSteps;
  }
  if (imagegen && Array.isArray(imagegen.operationSteps)) {
    config.doubaoConfig.operationSteps = imagegen.operationSteps;
  }

  // imageGenConfig mirror: primary imagegen → global
  if (imagegen?.imageGenConfig) {
    config.imageGenConfig = { ...config.imageGenConfig, ...imagegen.imageGenConfig };
  }

  // interceptorConfig mirror: primary imagegen → doubaoConfig
  if (imagegen?.interceptorConfig) {
    config.doubaoConfig.interceptorConfig = imagegen.interceptorConfig;
  }

  // failActionBySite mirror: derive from per-site failAction
  if (!config.advancedConfig) config.advancedConfig = {};
  const _fabMap = {};
  (config.sites || []).forEach(s => {
    if (s.failAction) _fabMap[s.id] = s.failAction;
  });
  config.advancedConfig.failActionBySite = _fabMap;
  const _firstAnalysis = sorted.find(s => s.role === 'analysis');
  const _firstImagegen = sorted.find(s => s.role === 'imagegen');
  config.advancedConfig.analysisFailAction = _firstAnalysis?.failAction || 'skip';
  config.advancedConfig.imagegenFailAction = _firstImagegen?.failAction || 'skip';
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function showSaveToast(msg = '✅ 设置已保存') {
  const toast = document.getElementById('saveToast');
  if (!toast) return;
  toast.textContent    = msg;
  toast.style.display  = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 2500);
}

// ═══════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════

init();