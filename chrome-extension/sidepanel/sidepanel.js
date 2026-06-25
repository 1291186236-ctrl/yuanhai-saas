// 复用 popup 逻辑，迁移到 sidepanel 页面。
// 注意：该文件保持轻量，核心逻辑仍由 popup.js 提供。

'use strict';

const script = document.createElement('script');
script.src = chrome.runtime.getURL('popup/popup.js');
document.documentElement.appendChild(script);
