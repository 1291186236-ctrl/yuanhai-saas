// content/player.js
// 页面自动化执行器
// 依赖：utils.js, picker.js

'use strict';

(function () {

  // ═══════════════════════════════════════════
  // ImageUploader 类
  // ═══════════════════════════════════════════

  class ImageUploader {

    /**
     * @param {object} siteConfig  arenaConfig 或 doubaoConfig
     */
    constructor(siteConfig) {
      this.config = siteConfig;
    }

    /**
     * 上传文件并验证完成
     * @param {Array<{buffer, name, type}>} filesData
     * @returns {Promise<{success, successCount, failCount}>}
     */
    async uploadAndVerify(filesData) {
      const expectedCount = filesData.length;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this._doUpload(filesData);
          const result = await this._waitAndVerify(expectedCount);

          if (result.success) {
            // 额外稳定等待
            await AutoUtils.sleep(1000);
            return result;
          }

          if (attempt < 3) {
            await this._clearUploaded();
            await AutoUtils.sleep(2000);
          }

        } catch (err) {
          console.warn(`[Uploader] 第${attempt}次尝试失败:`, err.message);
          if (attempt === 3) throw err;
          await AutoUtils.sleep(2000);
        }
      }

      throw new Error('图片上传失败，已重试3次，请检查网络和配置');
    }

    /**
     * 执行实际上传操作
     */
    async _doUpload(filesData) {
      const uploadFeatures = this.config.uploadFeatures;
      if (!uploadFeatures) {
        throw new Error('未配置上传按钮特征，请前往设置配置');
      }

      const uploadEl = window.ElementPicker.findElement(uploadFeatures);
      if (!uploadEl) {
        throw new Error('找不到上传按钮元素，请重新配置上传按钮');
      }

      // 重建File对象
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

      const normalizeBinary = (raw) => {
        if (!raw) return new Uint8Array(0);
        if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
        if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        if (raw.data && Array.isArray(raw.data)) return new Uint8Array(raw.data);
        if (Array.isArray(raw)) return new Uint8Array(raw);
        return new Uint8Array(0);
      };

      const files = filesData.map(f =>
        new File(
          [normalizeBinary(f.buffer)],
          f.name,
          {
            type: inferMimeType(f.name, f.type),
            lastModified: Date.now()
          }
        )
      ).filter(f => f.size > 0);

      const tagName  = uploadEl.tagName.toUpperCase();
      const isInput  = tagName === 'INPUT' && uploadEl.type === 'file';

      if (isInput) {
        // 直接是文件输入框
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        uploadEl.files = dt.files;
        uploadEl.dispatchEvent(new Event('change', { bubbles: true }));
        uploadEl.dispatchEvent(new Event('input',  { bubbles: true }));
      } else {
        // 按钮类型：点击后等待 input[type=file] 出现
        await this._clickAndWaitForFileInput(uploadEl, files);
      }
    }

    /**
     * 点击按钮后监听文件输入框出现
     */
    _clickAndWaitForFileInput(triggerEl, files) {
      return new Promise((resolve, reject) => {
        const observer = new MutationObserver(mutations => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType !== 1) continue;

              // 检查自身或子元素
              const input = (node.tagName === 'INPUT' && node.type === 'file')
                ? node
                : node.querySelector?.('input[type="file"]');

              if (input) {
                const dt = new DataTransfer();
                files.forEach(f => dt.items.add(f));
                input.files = dt.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                observer.disconnect();
                clearTimeout(timer);
                resolve();
                return;
              }
            }
          }
        });

        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error('点击上传按钮后3秒内未出现文件选择框'));
        }, 3000);

        observer.observe(document.body, { childList: true, subtree: true });
        triggerEl.click();
      });
    }

    /**
     * 等待上传完成并验证
     */
    _waitAndVerify(expectedCount) {
      const TIMEOUT         = this.config.uploadTimeout || 120000;
      const CHECK_INTERVAL  = 1000;
      const STABLE_REQUIRED = 3;

      let stableCounter    = 0;
      let lastPreviewCount = -1;
      const startTime      = Date.now();

      return new Promise((resolve, reject) => {
        const timer = setInterval(async () => {

          // 超时检查
          if (Date.now() - startTime > TIMEOUT) {
            clearInterval(timer);
            reject(new Error(`图片上传超时（${TIMEOUT / 60000}分钟）`));
            return;
          }

          let status;
          try {
            status = this._getUploadStatus();
          } catch {
            return;
          }

          // 出现错误立即终止
          if (status.hasError) {
            clearInterval(timer);
            reject(new Error('图片上传出现错误提示，请手动检查'));
            return;
          }

          // 上报进度到background（进而到popup）
          try {
            chrome.runtime.sendMessage({
              type: 'UPLOAD_PROGRESS',
              data: {
                previewCount:  status.previewCount,
                expectedCount,
                isLoading:     status.isLoading,
                elapsed:       Math.round((Date.now() - startTime) / 1000)
              }
            });
          } catch {}

          // 稳定性判断
          if (!status.isLoading &&
              status.previewCount === lastPreviewCount) {
            stableCounter++;
            if (stableCounter >= STABLE_REQUIRED) {
              clearInterval(timer);

              // 根据验证模式判断成功
              const threshold = this.config.verifyMode === 'strict'
                ? expectedCount
                : Math.floor(expectedCount * 0.8);

              resolve({
                success:      status.previewCount >= threshold,
                successCount: status.previewCount,
                failCount:    Math.max(0, expectedCount - status.previewCount)
              });
            }
          } else {
            stableCounter    = 0;
            lastPreviewCount = status.previewCount;
          }

        }, CHECK_INTERVAL);
      });
    }

    /**
     * 获取当前上传状态（同步，在页面上下文中执行）
     */
    _getUploadStatus() {
      const cfg = this.config;
      const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

      // ── 检查loading ──
      const loadingSelectors = [
        cfg.uploadLoadingSelector,
        cfg.uploadLoadingFeatures?.selector,
        '[class*="upload"][class*="loading"]',
        '[class*="uploading"]',
        '.upload-progress',
        '[data-uploading="true"]',
        '[class*="upload-ing"]'
      ].filter(Boolean);

      const isLoading = loadingSelectors.some(sel => {
        try { return isVisible(document.querySelector(sel)); }
        catch { return false; }
      });

      // ── 检查预览数量 ──
      const previewSelectors = [
        cfg.uploadPreviewSelector,
        cfg.uploadPreviewFeatures?.selector,
        '[class*="upload"][class*="preview"] img',
        '[class*="uploaded"] img',
        '[class*="attachment"] img',
        '[class*="thumb"] img',
        'img[class*="preview"]'
      ].filter(Boolean);

      let previewCount = 0;
      for (const sel of previewSelectors) {
        try {
          const count = document.querySelectorAll(sel).length;
          if (count > previewCount) previewCount = count;
        } catch {}
      }

      // ── 检查错误提示 ──
      const errorSelectors = [
        cfg.uploadErrorSelector,
        '[class*="upload"][class*="error"]',
        '[class*="upload"][class*="fail"]',
        '[class*="upload-err"]',
        '.upload-error'
      ].filter(Boolean);

      const hasError = errorSelectors.some(sel => {
        try { return isVisible(document.querySelector(sel)); }
        catch { return false; }
      });

      return { isLoading, previewCount, hasError };
    }

    /**
     * 清除已上传的图片（重试前使用）
     */
    async _clearUploaded() {
      const cfg = this.config;
      const deleteSelectors = [
        cfg.uploadDeleteSelector,
        cfg.uploadDeleteFeatures?.selector,
        '[class*="upload"] [class*="delete"]',
        '[class*="upload"] [class*="remove"]',
        '[class*="attachment"] [class*="close"]',
        '[class*="uploaded"] button',
        '[class*="preview"] [class*="del"]'
      ].filter(Boolean);

      deleteSelectors.forEach(sel => {
        try {
          document.querySelectorAll(sel).forEach(btn => btn.click());
        } catch {}
      });

      await AutoUtils.sleep(1200);
    }
  }

  // ═══════════════════════════════════════════
  // AutoPlayer 类
  // ═══════════════════════════════════════════

  class AutoPlayer {

    /**
     * @param {object} siteConfig  arenaConfig 或 doubaoConfig
     * @param {string} site        'arena' | 'doubao'
     */
    constructor(siteConfig, site) {
      this.config   = siteConfig;
      this.site     = site;
      this.uploader = new ImageUploader(siteConfig);
    }

    // ── 上传图片 ──

    async uploadImages(filesData) {
      return this.uploader.uploadAndVerify(filesData);
    }

    // ── 发送消息 ──

    async sendMessage(text) {
      const inputEl = this._findElement('inputFeatures', '输入框');
      AutoUtils.setNativeValue(inputEl, text);
      await AutoUtils.sleep(600);

      const sendEl = this._findElement('sendFeatures', '发送按钮');

      // 等待发送按钮可用
      await this._waitForElementEnabled(sendEl, 5000);
      sendEl.click();
    }

    // ── 等待回复完成 ──

    async waitForReplyComplete(timeout = 180000) {
      const startTime = Date.now();

      return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          if (Date.now() - startTime > timeout) {
            clearInterval(timer);
            reject(new Error('等待回复完成超时（3分钟）'));
            return;
          }

          try {
            const sendEl = window.ElementPicker.findElement(
              this.config.sendFeatures
            );
            if (sendEl) {
              const isEnabled = !sendEl.disabled &&
                                !sendEl.hasAttribute('disabled') &&
                                sendEl.getAttribute('aria-disabled') !== 'true';
              if (isEnabled) {
                clearInterval(timer);
                resolve();
              }
            }
          } catch {}
        }, 1000);
      });
    }

    // ── 获取Claude最后一条回复 ──

    getLastClaudeReply() {
      return AutoUtils.getLastClaudeReply();
    }

    // ── 获取页面已生成图片URL ──

    getGeneratedImageUrls() {
      const cfg = this.config;
      const imageAreaSel = cfg.imageAreaSelector ||
                           cfg.imageAreaFeatures?.selector || '';

      const root = imageAreaSel
        ? (document.querySelector(imageAreaSel) || document)
        : document;

      const imgs = Array.from(root.querySelectorAll('img'));
      const urls = [];

      imgs.forEach(img => {
        const url = img.src || img.getAttribute('data-src') || '';
        // 过滤：必须是http/https，宽度>100（排除图标）
        if (url.startsWith('http') &&
            !urls.includes(url) &&
            (img.naturalWidth > 100 || img.width > 100 || img.naturalWidth === 0)) {
          urls.push(url);
        }
      });

      return urls;
    }

    // ── 检查是否还在生成中 ──

    isGenerating() {
      const cfg = this.config;
      const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

      // 检查loading动画
      const loadingSelectors = [
        cfg.loadingSelector,
        cfg.loadingFeatures?.selector,
        '[class*="loading"]',
        '[class*="generating"]',
        '[class*="pending"]',
        '[class*="spinner"]'
      ].filter(Boolean);

      const hasLoading = loadingSelectors.some(sel => {
        try { return isVisible(document.querySelector(sel)); }
        catch { return false; }
      });

      // 检查发送按钮是否被禁用（生成中禁用）
      try {
        const sendEl = window.ElementPicker.findElement(this.config.sendFeatures);
        if (sendEl) {
          const btnDisabled = sendEl.disabled ||
                              sendEl.hasAttribute('disabled') ||
                              sendEl.getAttribute('aria-disabled') === 'true';
          return hasLoading || btnDisabled;
        }
      } catch {}

      return hasLoading;
    }

    // ── 等待一批图片生成完成 ──

    async waitForBatchComplete(beforeCount, timeout = 300000) {
      const startTime    = Date.now();
      let stableCounter  = 0;
      let lastCount      = beforeCount;

      return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          if (Date.now() - startTime > timeout) {
            clearInterval(timer);
            const currentUrls = this.getGeneratedImageUrls();
            if (currentUrls.length > beforeCount) {
              // 超时但有新图片，宽松处理
              resolve(currentUrls);
            } else {
              reject(new Error('等待图片生成超时（5分钟）'));
            }
            return;
          }

          try {
            const currentUrls = this.getGeneratedImageUrls();
            const isLoading   = this.isGenerating();
            const newCount    = currentUrls.length;

            // 上报进度
            try {
              chrome.runtime.sendMessage({
                type: 'IMAGE_GEN_PROGRESS',
                data: {
                  currentCount: newCount,
                  beforeCount,
                  newImages:   newCount - beforeCount,
                  isLoading
                }
              });
            } catch {}

            if (!isLoading &&
                newCount > beforeCount &&
                newCount === lastCount) {
              stableCounter++;
              if (stableCounter >= 3) {
                clearInterval(timer);
                resolve(currentUrls);
              }
            } else {
              if (newCount !== lastCount) stableCounter = 0;
              lastCount = newCount;
            }
          } catch {}

        }, 2000);
      });
    }

    // ── 内部工具 ──

    _findElement(configKey, label) {
      const features = this.config[configKey];
      if (!features) {
        throw new Error(`未配置${label}，请前往设置页面配置`);
      }
      const el = window.ElementPicker.findElement(features);
      if (!el) {
        throw new Error(`找不到${label}元素，请重新配置`);
      }
      return el;
    }

    _waitForElementEnabled(el, timeout = 5000) {
      return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const check = () => {
          if (!el.disabled && !el.hasAttribute('disabled')) {
            resolve();
          } else if (Date.now() - startTime > timeout) {
            reject(new Error('等待按钮可用超时'));
          } else {
            setTimeout(check, 200);
          }
        };
        check();
      });
    }
  }

  // ═══════════════════════════════════════════
  // 全局暴露
  // ═══════════════════════════════════════════

  window.AutoPlayer    = AutoPlayer;
  window.ImageUploader = ImageUploader;
  window.__PlayerReady = true;

})();