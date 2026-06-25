import api from '../lib/api.js';
import { navigate } from '../lib/router.js';

const NAV_ITEMS = [
    { path: '/account', label: '账户概览', icon: '👤' },
    { path: '/subscription', label: '订阅管理', icon: '⭐' },
    { path: '/usage', label: '使用统计', icon: '📊' },
    { path: '/orders', label: '订单记录', icon: '🧾' },
    { path: '/pricing', label: '升级方案', icon: '💎' }
];

export function renderLayout(content) {
    const user = api.getUser();
    const isLoggedIn = api.isLoggedIn();

    const planDisplay = {
        free: { name: '免费版', cls: 'badge-free' },
        pro: { name: '专业版', cls: 'badge-pro' },
        enterprise: { name: '企业版', cls: 'badge-enterprise' }
    };
    const plan = planDisplay[user?.plan || 'free'];

    return `
        <nav class="navbar">
            <div class="navbar-inner">
                <a href="#/account" class="navbar-brand">🛍️ 商品自动化助手</a>
                ${isLoggedIn ? `
                    <div class="navbar-right">
                        <span class="badge ${plan.cls}">${plan.name}</span>
                        <span class="navbar-user">${user?.email || ''}</span>
                        <button class="btn btn-outline btn-sm" id="logoutBtn">退出</button>
                    </div>
                ` : `
                    <div class="navbar-right">
                        <a href="#/login" class="btn btn-primary btn-sm">登录</a>
                        <a href="#/register" class="btn btn-outline btn-sm">注册</a>
                    </div>
                `}
            </div>
        </nav>
        <div class="layout">
            ${isLoggedIn ? `
                <aside class="sidebar">
                    ${NAV_ITEMS.map(item => `
                        <a href="#${item.path}" class="sidebar-item" data-nav="${item.path}">
                            <span class="sidebar-icon">${item.icon}</span>
                            <span>${item.label}</span>
                        </a>
                    `).join('')}
                </aside>
            ` : ''}
            <main class="main-content">
                ${content}
            </main>
        </div>
    `;
}

export function bindLayoutEvents() {
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            await api.logout();
            navigate('/login');
        });
    }

    const currentPath = window.location.hash.slice(1).split('?')[0];
    document.querySelectorAll('.sidebar-item').forEach(el => {
        if (el.dataset.nav === currentPath) {
            el.classList.add('active');
        }
    });
}
