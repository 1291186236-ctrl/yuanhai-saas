import api from '../lib/api.js';

const PLAN_FEATURES = {
    free: [
        '每月 10 次免费使用',
        '最多 5 个商品',
        '每商品最多 10 张图',
        '1 个消息模板',
        '基础自动化流程'
    ],
    pro: [
        '无限使用次数',
        '无限商品处理',
        '无限图片数量',
        '无限消息模板',
        '导出 Excel 结果',
        '断点续传功能',
        '优先客服支持'
    ],
    enterprise: [
        '包含 Pro 全部功能',
        '自定义网站支持',
        '团队模板共享',
        '专属客服经理',
        'API 接口访问',
        'SLA 保障'
    ]
};

export function renderPricing(plans, currentUser) {
    const currentPlan = currentUser?.plan || 'free';

    return `
        <div class="pricing-page">
            <div class="page-header">
                <h1>选择适合你的方案</h1>
                <p class="page-subtitle">升级后立即解锁全部功能</p>
            </div>

            <div class="pricing-grid">
                ${renderPlanCard('free', '免费版', 0, null, PLAN_FEATURES.free, currentPlan, plans)}
                ${renderPlanCard('pro', '专业版', 9.90, 99, PLAN_FEATURES.pro, currentPlan, plans)}
                ${renderPlanCard('enterprise', '企业版', 299, 2990, PLAN_FEATURES.enterprise, currentPlan, plans)}
            </div>
        </div>
    `;
}

function renderPlanCard(plan, name, monthly, yearly, features, currentPlan, plans) {
    const isCurrent = currentPlan === plan;
    const isPopular = plan === 'pro';

    return `
        <div class="pricing-card ${isPopular ? 'pricing-popular' : ''} ${isCurrent ? 'pricing-current' : ''}">
            ${isPopular ? '<div class="pricing-badge">最受欢迎</div>' : ''}
            ${isCurrent ? '<div class="pricing-badge pricing-badge-current">当前方案</div>' : ''}

            <h3 class="pricing-name">${name}</h3>

            <div class="pricing-price">
                ${monthly === 0 ? `
                    <span class="price-amount">免费</span>
                ` : `
                    <span class="price-currency">¥</span>
                    <span class="price-amount">${monthly}</span>
                    <span class="price-period">/月</span>
                    <div class="price-yearly">年付 ¥${yearly}/年（省 ${(monthly * 12 - yearly).toFixed(0)} 元）</div>
                `}
            </div>

            <ul class="pricing-features">
                ${features.map(f => `<li><span class="feature-check">✓</span> ${f}</li>`).join('')}
            </ul>

            ${isCurrent ? `
                <button class="btn btn-outline btn-block" disabled>当前方案</button>
            ` : monthly === 0 ? `
                <button class="btn btn-outline btn-block" disabled>基础方案</button>
            ` : `
                <div class="pricing-actions">
                    <button class="btn btn-primary btn-block checkout-btn" data-plan="${plan}_monthly">
                        按月付费 ¥${monthly}/月
                    </button>
                    <button class="btn btn-outline btn-block checkout-btn" data-plan="${plan}_yearly" style="margin-top:8px">
                        按年付费 ¥${yearly}/年
                    </button>
                </div>
            `}
        </div>
    `;
}

export async function bindPricingEvents() {
    document.querySelectorAll('.checkout-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const plan = btn.dataset.plan;
            const planLabel = plan.includes('monthly')
                ? (plan.startsWith('pro') ? '专业版月付 ¥9.90' : '企业版月付 ¥299')
                : (plan.startsWith('pro') ? '专业版年付 ¥99' : '企业版年付 ¥2990');

            // 弹出支付方式选择
            const payMethod = showPaymentDialog(planLabel);
            if (!payMethod) return;

            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> 正在处理...';

            try {
                if (payMethod === 'mock') {
                    // 模拟支付
                    const result = await api.mockCheckout(plan);
                    if (result?.ok) {
                        alert('✅ 支付成功！会员已升级');
                        await api.getMe();
                        window.location.hash = '#/account';
                    } else {
                        alert(result?.error || '支付失败，请重试');
                        resetBtn(btn, plan);
                    }
                } else if (payMethod === 'wxpay' || payMethod === 'alipay') {
                    // 易收米支付
                    const result = await api.yishoumiCheckout(plan, payMethod);
                    if (result?.ok && result.data?.payUrl) {
                        // 在新窗口打开支付页面
                        window.open(result.data.payUrl, '_blank');
                        // 轮询订单状态
                        await pollOrderStatus(result.data.outTradeNo, btn, plan);
                    } else {
                        alert(result?.error || result?.data?.error || '创建支付订单失败');
                        resetBtn(btn, plan);
                    }
                }
            } catch (err) {
                alert('网络错误，请重试');
                resetBtn(btn, plan);
            }
        });
    });
}

function showPaymentDialog(planLabel) {
    const choice = prompt(
        `确认升级到「${planLabel}」\n\n请选择支付方式：\n1. 微信支付（易收米）\n2. 支付宝（易收米）\n3. 模拟支付（测试用）\n\n输入数字 1/2/3 选择：`
    );
    if (!choice) return null;
    const map = { '1': 'wxpay', '2': 'alipay', '3': 'mock' };
    return map[choice.trim()] || null;
}

async function pollOrderStatus(outTradeNo, btn, plan) {
    btn.innerHTML = '<span class="spinner"></span> 等待支付完成...';
    let attempts = 0;
    const maxAttempts = 60; // 最多轮询 5 分钟

    const timer = setInterval(async () => {
        attempts++;
        if (attempts > maxAttempts) {
            clearInterval(timer);
            alert('支付超时，请重试');
            resetBtn(btn, plan);
            return;
        }

        try {
            const result = await api.yishoumiOrderStatus(outTradeNo);
            if (result?.ok && result.data?.status === 'TRADE_SUCCESS') {
                clearInterval(timer);
                alert('✅ 支付成功！会员已升级');
                await api.getMe();
                window.location.hash = '#/account';
            }
        } catch {
            // 忽略轮询错误
        }
    }, 5000);
}

function resetBtn(btn, plan) {
    btn.disabled = false;
    btn.textContent = plan.includes('monthly')
        ? `按月付费 ¥${plan === 'pro_monthly' ? '9.90' : '299'}/月`
        : `按年付费 ¥${plan === 'pro_yearly' ? '99' : '2990'}/年`;
}
