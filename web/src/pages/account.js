import api from '../lib/api.js';
import { navigate } from '../lib/router.js';

export function renderAccount(user, quota) {
    const planDisplay = {
        free: { name: '免费版', cls: 'badge-free', icon: '🆓' },
        pro: { name: '专业版', cls: 'badge-pro', icon: '⭐' },
        enterprise: { name: '企业版', cls: 'badge-enterprise', icon: '💎' }
    };
    const p = planDisplay[user?.plan || 'free'];
    const isFree = user?.plan === 'free';

    const quotaPercent = quota ? Math.round((quota.used / quota.total) * 100) : 0;
    const quotaBarColor = quotaPercent > 80 ? 'var(--danger)' : quotaPercent > 50 ? 'var(--warning)' : 'var(--success)';

    return `
        <div class="account-page">
            <div class="page-header">
                <h1>账户概览</h1>
            </div>

            <div class="account-grid">
                <div class="card account-info-card">
                    <div class="account-avatar">${p.icon}</div>
                    <div class="account-details">
                        <h2>${user?.name || user?.email?.split('@')[0] || '用户'}</h2>
                        <p class="account-email">${user?.email || ''}</p>
                        <span class="badge ${p.cls}">${p.name}</span>
                    </div>
                    ${isFree ? `
                        <button class="btn btn-primary" id="upgradeBtn">⭐ 升级 Pro</button>
                    ` : ''}
                </div>

                <div class="card quota-card">
                    <h3>本月使用额度</h3>
                    ${isFree ? `
                        <div class="quota-bar-wrap">
                            <div class="quota-bar">
                                <div class="quota-bar-fill" style="width:${quotaPercent}%; background:${quotaBarColor}"></div>
                            </div>
                            <span class="quota-text">${quota?.used || 0} / ${quota?.total || 10}</span>
                        </div>
                        <p class="quota-hint">每月 ${quota?.total || 10} 次免费使用，升级 Pro 解锁无限</p>
                    ` : `
                        <div class="quota-unlimited">♾️ 无限使用</div>
                        <p class="quota-hint">${p.name}会员享受无限使用次数</p>
                    `}
                </div>

                <div class="card quick-actions-card">
                    <h3>快捷操作</h3>
                    <div class="action-list">
                        <a href="#/subscription" class="action-item">
                            <span class="action-icon">📋</span>
                            <span>管理订阅</span>
                        </a>
                        <a href="#/usage" class="action-item">
                            <span class="action-icon">📊</span>
                            <span>查看使用统计</span>
                        </a>
                        <a href="#/orders" class="action-item">
                            <span class="action-icon">🧾</span>
                            <span>订单记录</span>
                        </a>
                        <a href="#/pricing" class="action-item">
                            <span class="action-icon">💎</span>
                            <span>升级方案</span>
                        </a>
                    </div>
                </div>

                <div class="card install-card">
                    <h3>安装 Chrome 插件</h3>
                    <p>从 Chrome Web Store 安装插件，登录同一账号即可同步使用。</p>
                    <a href="https://chromewebstore.google.com/" class="btn btn-outline" target="_blank">
                        前往 Chrome Web Store
                    </a>
                </div>
            </div>
        </div>
    `;
}

export async function bindAccountEvents() {
    const upgradeBtn = document.getElementById('upgradeBtn');
    if (upgradeBtn) {
        upgradeBtn.addEventListener('click', () => navigate('/pricing'));
    }
}
