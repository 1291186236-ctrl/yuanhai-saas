const API_BASE = window.location.hostname === 'localhost' 
    ? '/api' 
    : 'https://yuanhai-web-d1g1arjtcf3d2978e-1323801362.ap-shanghai.app.tcloudbase.com/api';

const STORAGE_KEYS = {
    ACCESS_TOKEN: 'yh_access_token',
    REFRESH_TOKEN: 'yh_refresh_token',
    USER_INFO: 'yh_user_info'
};

function getStorage(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function setStorage(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

function removeStorage(key) {
    localStorage.removeItem(key);
}

async function refreshTokens() {
    const refreshToken = getStorage(STORAGE_KEYS.REFRESH_TOKEN);
    if (!refreshToken) return null;

    try {
        const resp = await fetch(`${API_BASE}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken })
        });
        if (!resp.ok) return null;
        const json = await resp.json();
        if (!json.ok) return null;

        setStorage(STORAGE_KEYS.ACCESS_TOKEN, json.data.accessToken);
        if (json.data.refreshToken) {
            setStorage(STORAGE_KEYS.REFRESH_TOKEN, json.data.refreshToken);
        }
        setStorage(STORAGE_KEYS.USER_INFO, json.data.user);
        return json.data.accessToken;
    } catch {
        return null;
    }
}

async function apiRequest(path, options = {}) {
    const accessToken = getStorage(STORAGE_KEYS.ACCESS_TOKEN);
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };
    if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
    }

    let resp = await fetch(`${API_BASE}${path}`, { ...options, headers });

    if (resp.status === 401 && accessToken) {
        const newToken = await refreshTokens();
        if (newToken) {
            headers['Authorization'] = `Bearer ${newToken}`;
            resp = await fetch(`${API_BASE}${path}`, { ...options, headers });
        } else {
            clearAuth();
            window.location.hash = '#/login';
        }
    }

    const json = await resp.json().catch(() => ({ ok: false, error: 'Network error' }));
    return { ok: resp.ok, status: resp.status, data: json };
}

function clearAuth() {
    Object.values(STORAGE_KEYS).forEach(k => removeStorage(k));
}

const api = {
    isLoggedIn() {
        return !!getStorage(STORAGE_KEYS.ACCESS_TOKEN);
    },

    getUser() {
        return getStorage(STORAGE_KEYS.USER_INFO);
    },

    async register({ email, password, name }) {
        const result = await apiRequest('/auth/register', {
            method: 'POST',
            body: JSON.stringify({ email, password, name })
        });
        if (result.data?.ok) {
            setStorage(STORAGE_KEYS.ACCESS_TOKEN, result.data.data.accessToken);
            setStorage(STORAGE_KEYS.REFRESH_TOKEN, result.data.data.refreshToken);
            setStorage(STORAGE_KEYS.USER_INFO, result.data.data.user);
        }
        return result.data;
    },

    async login({ email, password }) {
        const result = await apiRequest('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password })
        });
        if (result.data?.ok) {
            setStorage(STORAGE_KEYS.ACCESS_TOKEN, result.data.data.accessToken);
            setStorage(STORAGE_KEYS.REFRESH_TOKEN, result.data.data.refreshToken);
            setStorage(STORAGE_KEYS.USER_INFO, result.data.data.user);
        }
        return result.data;
    },

    async loginWithGoogle(idToken) {
        const result = await apiRequest('/auth/google', {
            method: 'POST',
            body: JSON.stringify({ idToken })
        });
        if (result.data?.ok) {
            setStorage(STORAGE_KEYS.ACCESS_TOKEN, result.data.data.accessToken);
            setStorage(STORAGE_KEYS.REFRESH_TOKEN, result.data.data.refreshToken);
            setStorage(STORAGE_KEYS.USER_INFO, result.data.data.user);
        }
        return result.data;
    },

    async logout() {
        const refreshToken = getStorage(STORAGE_KEYS.REFRESH_TOKEN);
        await apiRequest('/auth/logout', {
            method: 'POST',
            body: JSON.stringify({ refreshToken })
        });
        clearAuth();
    },

    async getMe() {
        const result = await apiRequest('/user/me');
        if (result.data?.ok) {
            setStorage(STORAGE_KEYS.USER_INFO, result.data.data);
        }
        return result.data;
    },

    async getPlans() {
        return apiRequest('/plans').then(r => r.data);
    },

    async createCheckout(plan) {
        return apiRequest('/billing/checkout', {
            method: 'POST',
            body: JSON.stringify({ plan })
        }).then(r => r.data);
    },

    async mockCheckout(plan) {
        return apiRequest('/billing/mock-checkout', {
            method: 'POST',
            body: JSON.stringify({ plan })
        }).then(r => r.data);
    },

    async mockCancel() {
        return apiRequest('/billing/mock-cancel', {
            method: 'POST'
        }).then(r => r.data);
    },

    async mockReactivate() {
        return apiRequest('/billing/mock-reactivate', {
            method: 'POST'
        }).then(r => r.data);
    },

    async yishoumiCheckout(plan, payType) {
        return apiRequest('/billing/yishoumi/checkout', {
            method: 'POST',
            body: JSON.stringify({ plan, payType })
        }).then(r => r.data);
    },

    async yishoumiOrderStatus(outTradeNo) {
        return apiRequest(`/billing/yishoumi/status/${outTradeNo}`).then(r => r.data);
    },

    async createPortalSession() {
        return apiRequest('/billing/portal', {
            method: 'POST'
        }).then(r => r.data);
    },

    async getOrders() {
        return apiRequest('/billing/orders').then(r => r.data);
    },

    async getUsageStats() {
        return apiRequest('/user/me/usage').then(r => r.data);
    },

    async getQuota() {
        return apiRequest('/quota').then(r => r.data);
    },

    async updateProfile(data) {
        return apiRequest('/user/me', {
            method: 'PATCH',
            body: JSON.stringify(data)
        }).then(r => r.data);
    }
};

export { api, STORAGE_KEYS };
export default api;
