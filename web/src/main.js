import './styles/global.css';
import './styles/layout.css';
import './styles/auth.css';
import './styles/account.css';
import './styles/pricing.css';
import './styles/subscription.css';
import './styles/pages.css';

import { register, startRouter, navigate } from './lib/router.js';
import api from './lib/api.js';
import { renderLayout, bindLayoutEvents } from './components/layout.js';

import { renderLogin, bindLoginEvents } from './pages/login.js';
import { renderRegister, bindRegisterEvents } from './pages/register.js';
import { renderAccount, bindAccountEvents } from './pages/account.js';
import { renderPricing, bindPricingEvents } from './pages/pricing.js';
import { renderSubscription, bindSubscriptionEvents } from './pages/subscription.js';
import { renderUsage } from './pages/usage.js';
import { renderOrders } from './pages/orders.js';

function requireAuth() {
    if (!api.isLoggedIn()) {
        navigate('/login');
        return false;
    }
    return true;
}

function render(content) {
    document.getElementById('app').innerHTML = renderLayout(content);
    bindLayoutEvents();
}

register('/login', async () => {
    if (api.isLoggedIn()) { navigate('/account'); return; }
    render(renderLogin());
    bindLoginEvents();
});

register('/register', async () => {
    if (api.isLoggedIn()) { navigate('/account'); return; }
    render(renderRegister());
    bindRegisterEvents();
});

register('/account', async () => {
    if (!requireAuth()) return;

    let user = api.getUser();
    let quota = null;

    try {
        const [meResult, quotaResult] = await Promise.all([
            api.getMe(),
            api.getQuota()
        ]);
        user = meResult?.data || user;
        quota = quotaResult?.data || null;
    } catch {}

    render(renderAccount(user, quota));
    await bindAccountEvents();
});

register('/pricing', async () => {
    let plans = [];
    let currentUser = null;

    try {
        const [plansResult] = await Promise.all([api.getPlans()]);
        plans = plansResult?.data || [];
    } catch {}

    if (api.isLoggedIn()) {
        try {
            const meResult = await api.getMe();
            currentUser = meResult?.data;
        } catch {}
    }

    render(renderPricing(plans, currentUser));
    await bindPricingEvents();
});

register('/subscription', async () => {
    if (!requireAuth()) return;

    let user = null;
    let subscription = null;

    try {
        const [meResult, subResult] = await Promise.all([
            api.getMe(),
            api.getMe().then(() => null)
        ]);
        user = meResult?.data;
    } catch {}

    render(renderSubscription(user, subscription));
    await bindSubscriptionEvents();
});

register('/usage', async () => {
    if (!requireAuth()) return;

    let user = null;
    let usageStats = null;
    let quota = null;

    try {
        const [meResult, usageResult, quotaResult] = await Promise.all([
            api.getMe(),
            api.getUsageStats(),
            api.getQuota()
        ]);
        user = meResult?.data;
        usageStats = usageResult?.data;
        quota = quotaResult?.data;
    } catch {}

    render(renderUsage(user, usageStats, quota));
});

register('/orders', async () => {
    if (!requireAuth()) return;

    let orders = [];

    try {
        const result = await api.getOrders();
        orders = result?.data || [];
    } catch {}

    render(renderOrders(orders));
});

register('/', async () => {
    if (api.isLoggedIn()) {
        navigate('/account');
    } else {
        navigate('/login');
    }
});

const params = new URLSearchParams(window.location.search);
if (params.get('status') === 'success') {
    const hash = window.location.hash || '#/account';
    window.location.hash = hash;
}

startRouter();
