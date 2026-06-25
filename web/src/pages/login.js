import api from '../lib/api.js';
import { navigate } from '../lib/router.js';

export function renderLogin() {
    return `
        <div class="auth-page">
            <div class="auth-card">
                <div class="auth-logo">🛍️</div>
                <h1 class="auth-title">登录到商品自动化助手</h1>
                <p class="auth-subtitle">登录后即可使用全部功能</p>

                <div class="alert alert-error" id="loginError" style="display:none"></div>

                <form id="loginForm">
                    <div class="form-group">
                        <label class="form-label">邮箱</label>
                        <input type="email" class="form-input" id="email" placeholder="you@example.com" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">密码</label>
                        <input type="password" class="form-input" id="password" placeholder="输入密码" required>
                    </div>
                    <button type="submit" class="btn btn-primary btn-block" id="submitBtn">登录</button>
                </form>

                <div class="auth-divider"><span>或</span></div>

                <button class="btn btn-outline btn-block" id="googleBtn">
                    <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
                    使用 Google 登录
                </button>

                <div class="auth-footer">
                    还没有账号？<a href="#/register">立即注册</a>
                </div>
            </div>
        </div>
    `;
}

export function bindLoginEvents() {
    const form = document.getElementById('loginForm');
    const errorEl = document.getElementById('loginError');
    const submitBtn = document.getElementById('submitBtn');

    function showError(msg) {
        errorEl.textContent = msg;
        errorEl.style.display = 'block';
    }
    function hideError() { errorEl.style.display = 'none'; }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideError();

        const email = document.getElementById('email').value.trim();
        const password = document.getElementById('password').value;

        if (!email || !password) { showError('请填写邮箱和密码'); return; }

        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner"></span> 登录中...';

        try {
            const result = await api.login({ email, password });
            if (result?.ok) {
                const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
                navigate(params.get('redirect') || '/account');
            } else {
                showError(result?.error || '登录失败');
            }
        } catch (err) {
            showError('网络错误，请重试');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = '登录';
        }
    });

    document.getElementById('googleBtn').addEventListener('click', () => {
        const googleClientId = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
        const redirectUri = encodeURIComponent(window.location.origin + '/auth/callback.html');
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${googleClientId}&response_type=id_token&redirect_uri=${redirectUri}&scope=openid+email+profile&nonce=${crypto.randomUUID()}`;
        window.location.href = authUrl;
    });
}
