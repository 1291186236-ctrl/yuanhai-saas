import api from '../lib/api.js';
import { navigate } from '../lib/router.js';

export function renderRegister() {
    return `
        <div class="auth-page">
            <div class="auth-card">
                <div class="auth-logo">🛍️</div>
                <h1 class="auth-title">创建账号</h1>
                <p class="auth-subtitle">注册后即可免费使用 10 次/月</p>

                <div class="alert alert-error" id="regError" style="display:none"></div>

                <form id="regForm">
                    <div class="form-group">
                        <label class="form-label">用户名（可选）</label>
                        <input type="text" class="form-input" id="name" placeholder="你的名字">
                    </div>
                    <div class="form-group">
                        <label class="form-label">邮箱</label>
                        <input type="email" class="form-input" id="email" placeholder="you@example.com" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">密码</label>
                        <input type="password" class="form-input" id="password" placeholder="至少 8 位" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">确认密码</label>
                        <input type="password" class="form-input" id="password2" placeholder="再次输入密码" required>
                    </div>
                    <button type="submit" class="btn btn-primary btn-block" id="submitBtn">注册</button>
                </form>

                <div class="auth-footer">
                    已有账号？<a href="#/login">立即登录</a>
                </div>
            </div>
        </div>
    `;
}

export function bindRegisterEvents() {
    const form = document.getElementById('regForm');
    const errorEl = document.getElementById('regError');
    const submitBtn = document.getElementById('submitBtn');

    function showError(msg) { errorEl.textContent = msg; errorEl.style.display = 'block'; }
    function hideError() { errorEl.style.display = 'none'; }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideError();

        const name = document.getElementById('name').value.trim();
        const email = document.getElementById('email').value.trim();
        const password = document.getElementById('password').value;
        const password2 = document.getElementById('password2').value;

        if (!email || !password) { showError('请填写邮箱和密码'); return; }
        if (password.length < 8) { showError('密码至少 8 位'); return; }
        if (password !== password2) { showError('两次密码不一致'); return; }

        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner"></span> 注册中...';

        try {
            const result = await api.register({ email, password, name });
            if (result?.ok) {
                navigate('/account');
            } else {
                showError(result?.error || '注册失败');
            }
        } catch (err) {
            showError('网络错误，请重试');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = '注册';
        }
    });
}
