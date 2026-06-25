// lib/auth-ui.js
// 共享的认证 UI 组件：会员状态条、登录拦截、升级引导

(function (global) {
  'use strict';

  const AuthUI = {
    async openLoginPage() {
      const url = chrome.runtime.getURL('auth/login.html');
      await chrome.tabs.create({ url });
    },

    async ensureLoggedIn() {
      const loggedIn = await ApiClient.isLoggedIn();
      if (!loggedIn) {
        const confirmed = confirm('使用此功能需要先登录账号。\n\n点击"确定"打开登录页面。');
        if (confirmed) {
          await this.openLoginPage();
        }
        return false;
      }
      return true;
    },

    async refreshUserInfo() {
      try {
        const result = await ApiClient.getMe();
        return result?.ok ? result.data : null;
      } catch (err) {
        return null;
      }
    },

    createStatusBar(container) {
      const bar = document.createElement('div');
      bar.className = 'auth-status-bar';
      bar.innerHTML = `
        <div class="auth-status-left">
          <span class="auth-avatar" id="authAvatar">👤</span>
          <div class="auth-user-info">
            <div class="auth-user-name" id="authUserName">未登录</div>
            <div class="auth-user-email" id="authUserEmail"></div>
          </div>
        </div>
        <div class="auth-status-right">
          <span class="auth-plan-badge auth-plan-free" id="authPlanBadge">免费版</span>
          <button class="auth-btn-upgrade" id="authUpgradeBtn" style="display:none">升级</button>
          <button class="auth-btn-logout" id="authLogoutBtn" style="display:none">退出</button>
          <button class="auth-btn-login" id="authLoginBtn">登录</button>
        </div>
      `;
      container.insertBefore(bar, container.firstChild);
      this._bindStatusBar(bar);
      return bar;
    },

    _bindStatusBar(bar) {
      const loginBtn = bar.querySelector('#authLoginBtn');
      const logoutBtn = bar.querySelector('#authLogoutBtn');
      const upgradeBtn = bar.querySelector('#authUpgradeBtn');

      loginBtn.addEventListener('click', () => this.openLoginPage());
      logoutBtn.addEventListener('click', async () => {
        if (confirm('确定要退出登录吗？')) {
          await ApiClient.logout();
          this.updateStatusBar(null);
          chrome.runtime.sendMessage({ type: 'AUTH_LOGOUT' }).catch(() => {});
        }
      });
      upgradeBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://your-domain.com/pricing' });
      });
    },

    async updateStatusBar(user) {
      if (!user) {
        user = await ApiClient.getUserInfo();
      }

      const bars = document.querySelectorAll('.auth-status-bar');
      bars.forEach(bar => {
        const nameEl = bar.querySelector('#authUserName');
        const emailEl = bar.querySelector('#authUserEmail');
        const avatarEl = bar.querySelector('#authAvatar');
        const planBadge = bar.querySelector('#authPlanBadge');
        const loginBtn = bar.querySelector('#authLoginBtn');
        const logoutBtn = bar.querySelector('#authLogoutBtn');
        const upgradeBtn = bar.querySelector('#authUpgradeBtn');

        if (user) {
          nameEl.textContent = user.name || user.email.split('@')[0];
          emailEl.textContent = user.email;
          avatarEl.textContent = '👤';

          const display = Permission.getDisplay(user.plan);
          planBadge.textContent = display.icon + ' ' + display.name;
          planBadge.className = `auth-plan-badge auth-plan-${user.plan}`;
          planBadge.style.color = display.color;

          loginBtn.style.display = 'none';
          logoutBtn.style.display = 'inline-block';
          upgradeBtn.style.display = user.plan === 'free' ? 'inline-block' : 'none';
        } else {
          nameEl.textContent = '未登录';
          emailEl.textContent = '';
          avatarEl.textContent = '👤';
          planBadge.textContent = '🆓 免费版';
          planBadge.className = 'auth-plan-badge auth-plan-free';
          loginBtn.style.display = 'inline-block';
          logoutBtn.style.display = 'none';
          upgradeBtn.style.display = 'none';
        }
      });
    },

    showUpgradeModal(reason) {
      const modal = document.createElement('div');
      modal.className = 'auth-upgrade-modal';
      modal.innerHTML = `
        <div class="auth-upgrade-content">
          <div class="auth-upgrade-icon">⭐</div>
          <h3>需要升级会员</h3>
          <p>${reason || '此功能需要升级会员才能使用'}</p>
          <div class="auth-upgrade-plans">
            <div class="auth-upgrade-plan">
              <div class="plan-name">⭐ Pro 专业版</div>
              <div class="plan-price">$9.9/月</div>
              <ul>
                <li>无限使用次数</li>
                <li>无限商品处理</li>
                <li>导出 Excel 结果</li>
                <li>断点续传</li>
              </ul>
            </div>
            <div class="auth-upgrade-plan auth-plan-ent">
              <div class="plan-name">💎 Enterprise 企业版</div>
              <div class="plan-price">$299/月</div>
              <ul>
                <li>包含 Pro 全部功能</li>
                <li>自定义网站支持</li>
                <li>团队模板共享</li>
                <li>优先客服支持</li>
              </ul>
            </div>
          </div>
          <div class="auth-upgrade-actions">
            <button class="auth-btn-cancel">稍后再说</button>
            <button class="auth-btn-go-upgrade">立即升级</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      modal.querySelector('.auth-btn-cancel').addEventListener('click', () => modal.remove());
      modal.querySelector('.auth-btn-go-upgrade').addEventListener('click', async () => {
        modal.remove();
        const result = await ApiClient.createCheckout('pro_monthly');
        if (result?.ok && result.data?.checkoutUrl) {
          chrome.tabs.create({ url: result.data.checkoutUrl });
        }
      });
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
      });
    },

    async checkFeature(feature, options = {}) {
      const loggedIn = await this.ensureLoggedIn();
      if (!loggedIn) return false;

      const user = await ApiClient.getUserInfo();
      if (!user) return false;

      if (Permission.canUseFeature(user.plan, feature)) {
        return true;
      }

      if (options.silent) return false;

      const reason = Permission.getUpgradeReason(feature);
      this.showUpgradeModal(reason);
      return false;
    },

    async checkQuota() {
      const loggedIn = await this.ensureLoggedIn();
      if (!loggedIn) return { ok: false, reason: 'NOT_LOGGED_IN' };

      const result = await ApiClient.deductQuota({ action: 'task_start' });
      if (result?.ok) {
        return { ok: true, remaining: result.data.remaining, plan: result.data.plan };
      }

      if (result?.code === 'QUOTA_EXHAUSTED') {
        this.showUpgradeModal('本月免费额度已用完，升级 Pro 解锁无限使用');
        return { ok: false, reason: 'QUOTA_EXHAUSTED' };
      }

      return { ok: false, reason: 'UNKNOWN', error: result?.error };
    }
  };

  global.AuthUI = AuthUI;
})(typeof window !== 'undefined' ? window : self);
