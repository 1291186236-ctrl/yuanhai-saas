// lib/api-client.js
// 与后端 API 通信的统一封装，支持自动 token 刷新

(function (global) {
  'use strict';

  const STORAGE_KEYS = {
    ACCESS_TOKEN: 'auth_access_token',
    REFRESH_TOKEN: 'auth_refresh_token',
    USER_INFO: 'auth_user_info',
    USER_PLAN: 'auth_user_plan'
  };

  const DEFAULT_BASE = 'https://yuanhai-web-d1g1arjtcf3d2978e-1323801362.ap-shanghai.app.tcloudbase.com/api';

  const ApiClient = {
    baseUrl: DEFAULT_BASE,

    setBaseUrl(url) {
      this.baseUrl = url;
    },

    async _getStorage(key) {
      return new Promise((resolve) => {
        chrome.storage.local.get([key], (res) => resolve(res[key]));
      });
    },

    async _setStorage(key, value) {
      return new Promise((resolve) => {
        chrome.storage.local.set({ [key]: value }, () => resolve());
      });
    },

    async _removeStorage(keys) {
      return new Promise((resolve) => {
        chrome.storage.local.remove(keys, () => resolve());
      });
    },

    async getTokens() {
      const [accessToken, refreshToken] = await Promise.all([
        this._getStorage(STORAGE_KEYS.ACCESS_TOKEN),
        this._getStorage(STORAGE_KEYS.REFRESH_TOKEN)
      ]);
      return { accessToken, refreshToken };
    },

    async setTokens(accessToken, refreshToken) {
      await Promise.all([
        this._setStorage(STORAGE_KEYS.ACCESS_TOKEN, accessToken),
        refreshToken ? this._setStorage(STORAGE_KEYS.REFRESH_TOKEN, refreshToken) : Promise.resolve()
      ]);
    },

    async clearAuth() {
      await this._removeStorage([
        STORAGE_KEYS.ACCESS_TOKEN,
        STORAGE_KEYS.REFRESH_TOKEN,
        STORAGE_KEYS.USER_INFO,
        STORAGE_KEYS.USER_PLAN
      ]);
    },

    async getUserInfo() {
      return this._getStorage(STORAGE_KEYS.USER_INFO);
    },

    async setUserInfo(user) {
      await this._setStorage(STORAGE_KEYS.USER_INFO, user);
      if (user?.plan) {
        await this._setStorage(STORAGE_KEYS.USER_PLAN, user.plan);
      }
    },

    async isLoggedIn() {
      const { accessToken } = await this.getTokens();
      return !!accessToken;
    },

    async _refreshTokens() {
      const { refreshToken } = await this.getTokens();
      if (!refreshToken) return null;

      try {
        const resp = await fetch(`${this.baseUrl}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken })
        });
        if (!resp.ok) return null;
        const json = await resp.json();
        if (!json.ok) return null;

        await this.setTokens(json.data.accessToken, json.data.refreshToken);
        await this.setUserInfo(json.data.user);
        return json.data.accessToken;
      } catch (err) {
        console.error('[ApiClient] refresh failed:', err);
        return null;
      }
    },

    async request(path, options = {}) {
      const { accessToken } = await this.getTokens();
      const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      };
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }

      let resp = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers
      });

      if (resp.status === 401 && accessToken) {
        const newToken = await this._refreshTokens();
        if (newToken) {
          headers['Authorization'] = `Bearer ${newToken}`;
          resp = await fetch(`${this.baseUrl}${path}`, {
            ...options,
            headers
          });
        } else {
          await this.clearAuth();
          chrome.runtime.sendMessage({ type: 'AUTH_EXPIRED' }).catch(() => {});
        }
      }

      const json = await resp.json().catch(() => ({ ok: false, error: 'Invalid JSON' }));
      return { ok: resp.ok, status: resp.status, data: json };
    },

    async register({ email, password, name }) {
      const result = await this.request('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, name })
      });
      if (result.data?.ok) {
        await this.setTokens(result.data.data.accessToken, result.data.data.refreshToken);
        await this.setUserInfo(result.data.data.user);
      }
      return result.data;
    },

    async login({ email, password }) {
      const result = await this.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      if (result.data?.ok) {
        await this.setTokens(result.data.data.accessToken, result.data.data.refreshToken);
        await this.setUserInfo(result.data.data.user);
      }
      return result.data;
    },

    async loginWithGoogle(idToken) {
      const result = await this.request('/auth/google', {
        method: 'POST',
        body: JSON.stringify({ idToken })
      });
      if (result.data?.ok) {
        await this.setTokens(result.data.data.accessToken, result.data.data.refreshToken);
        await this.setUserInfo(result.data.data.user);
      }
      return result.data;
    },

    async logout() {
      const { refreshToken } = await this.getTokens();
      await this.request('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken })
      });
      await this.clearAuth();
    },

    async getMe() {
      const result = await this.request('/user/me');
      if (result.data?.ok) {
        await this.setUserInfo(result.data.data);
      }
      return result.data;
    },

    async getQuota() {
      const result = await this.request('/quota');
      return result.data;
    },

    async deductQuota({ action = 'task_start', productCount = 0, imageCount = 0, metadata = {} }) {
      const result = await this.request('/quota/deduct', {
        method: 'POST',
        body: JSON.stringify({ action, productCount, imageCount, metadata })
      });
      return result.data;
    },

    async getPlans() {
      const result = await this.request('/plans');
      return result.data;
    },

    async createCheckout(plan) {
      const result = await this.request('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan })
      });
      return result.data;
    },

    async createPortalSession() {
      const result = await this.request('/billing/portal', {
        method: 'POST'
      });
      return result.data;
    },

    async getOrders() {
      const result = await this.request('/billing/orders');
      return result.data;
    },

    async getUsageStats() {
      const result = await this.request('/user/me/usage');
      return result.data;
    },

    STORAGE_KEYS
  };

  global.ApiClient = ApiClient;
})(typeof window !== 'undefined' ? window : self);
