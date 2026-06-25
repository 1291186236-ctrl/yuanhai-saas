// auth/login.js
// 登录页逻辑

(function () {
  'use strict';

  let currentMode = 'login';

  const $ = (id) => document.getElementById(id);
  const errorMsg = $('errorMsg');
  const submitBtn = $('submitBtn');
  const nameGroup = $('nameGroup');
  const emailInput = $('emailInput');
  const passwordInput = $('passwordInput');
  const nameInput = $('nameInput');

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentMode = tab.dataset.tab;
      nameGroup.style.display = currentMode === 'register' ? 'block' : 'none';
      submitBtn.textContent = currentMode === 'register' ? '注册' : '登录';
      hideError();
    });
  });

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.add('show');
  }
  function hideError() {
    errorMsg.classList.remove('show');
  }

  function setLoading(loading) {
    submitBtn.disabled = loading;
    submitBtn.innerHTML = loading
      ? '<span class="loading"></span>处理中...'
      : (currentMode === 'register' ? '注册' : '登录');
  }

  $('emailForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      showError('请填写邮箱和密码');
      return;
    }
    if (password.length < 8) {
      showError('密码至少 8 位');
      return;
    }

    setLoading(true);
    try {
      let result;
      if (currentMode === 'register') {
        const name = nameInput.value.trim();
        result = await ApiClient.register({ email, password, name });
      } else {
        result = await ApiClient.login({ email, password });
      }

      if (result.ok) {
        chrome.runtime.sendMessage({ type: 'AUTH_SUCCESS', user: result.data.user }).catch(() => {});
        window.close();
      } else {
        showError(result.error || '操作失败');
      }
    } catch (err) {
      showError('网络错误，请重试');
    } finally {
      setLoading(false);
    }
  });

  $('googleBtn').addEventListener('click', async () => {
    hideError();
    setLoading(true);
    try {
      const redirectUrl = chrome.identity.getRedirectURL('callback');
      const manifest = chrome.runtime.getManifest();
      const clientId = manifest.oauth2?.client_id;

      if (!clientId || clientId.startsWith('YOUR_')) {
        showError('Google 登录未配置，请使用邮箱登录');
        setLoading(false);
        return;
      }

      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('response_type', 'id_token');
      authUrl.searchParams.set('redirect_uri', redirectUrl);
      authUrl.searchParams.set('scope', 'openid email profile');
      authUrl.searchParams.set('nonce', crypto.randomUUID());

      chrome.identity.launchWebAuthFlow(
        { url: authUrl.toString(), interactive: true },
        async (callbackUrl) => {
          if (chrome.runtime.lastError || !callbackUrl) {
            showError('Google 登录已取消');
            setLoading(false);
            return;
          }

          const hash = new URL(callbackUrl).hash.substring(1);
          const params = new URLSearchParams(hash);
          const idToken = params.get('id_token');

          if (!idToken) {
            showError('未获取到 Google 凭证');
            setLoading(false);
            return;
          }

          const result = await ApiClient.loginWithGoogle(idToken);
          if (result.ok) {
            chrome.runtime.sendMessage({ type: 'AUTH_SUCCESS', user: result.data.user }).catch(() => {});
            window.close();
          } else {
            showError(result.error || 'Google 登录失败');
          }
          setLoading(false);
        }
      );
    } catch (err) {
      showError('Google 登录异常');
      setLoading(false);
    }
  });
})();
