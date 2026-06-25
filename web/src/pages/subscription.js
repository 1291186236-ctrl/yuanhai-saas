import api from '../lib/api.js';
import { navigate } from '../lib/router.js';

export function renderSubscription(user, subscription) {
    const hasSub = !!subscription;
    const isActive = subscription?.status === 'active';
    const isPastDue = subscription?.status === 'past_due';
    const isCancelled = subscription?.cancel_at_period_end;

    const statusDisplay = {
        active: { label: '生效中', cls: 'badge-pro', icon: '✅' },
        past_due: { label: '逾期', cls: 'badge-free', icon: '⚠️' },
        cancelled: { label: '已取消', cls: 'badge-free', icon: '🚫' },
        expired: { label: '已过期', cls: 'badge-free', icon: '❌' },
        paused: { label: '已暂停', cls: 'badge-free', icon: '⏸️' }
    };

    const status = statusDisplay[subscription?.status] || statusDisplay.expired;

    return `
        <div class="subscription-page">
            <div class="page-header">
                <h1>订阅管理</h1>
            </div>

            ${!hasSub || !isActive ? renderNoSubscription(user) : ''}

            ${hasSub && isActive ? renderActiveSubscription(subscription, status, isCancelled) : ''}

            ${isPastDue ? renderPastDueNotice() : ''}
        </div>
    `;
}

function renderNoSubscription(user) {
    return `
        <div class="card sub-empty">
            <div class="sub-empty-icon">📋</div>
            <h3>暂无有效订阅</h3>
            <p>升级到 Pro 解锁无限使用和全部高级功能</p>
            <button class="btn btn-primary" onclick="location.hash='#/pricing'">查看升级方案</button>
        </div>
    `;
}

function renderActiveSubscription(sub, status, isCancelled) {
    const periodEnd = sub.current_period_end
        ? new Date(sub.current_period_end).toLocaleDateString('zh-CN')
        : '未知';

    return `
        <div class="card sub-active">
            <div class="sub-status-row">
                <h3>当前订阅</h3>
                <span class="badge ${status.cls}">${status.icon} ${status.label}</span>
            </div>

            <div class="sub-details-grid">
                <div class="sub-detail">
                    <span class="sub-detail-label">方案</span>
                    <span class="sub-detail-value">${sub.plan === 'pro' ? '⭐ 专业版' : '💎 企业版'}</span>
                </div>
                <div class="sub-detail">
                    <span class="sub-detail-label">当前周期结束</span>
                    <span class="sub-detail-value">${periodEnd}</span>
                </div>
                ${isCancelled ? `
                    <div class="sub-detail sub-cancel-notice">
                        <span class="sub-detail-label">取消状态</span>
                        <span class="sub-detail-value" style="color:var(--warning)">将于周期结束后降级为免费版</span>
                    </div>
                ` : ''}
            </div>

            <div class="sub-actions">
                ${!isCancelled ? `
                    <button class="btn btn-outline" id="manageSubBtn">管理订阅</button>
                    <button class="btn btn-outline btn-danger-outline" id="cancelSubBtn">取消订阅</button>
                ` : `
                    <button class="btn btn-primary" id="reactivateBtn">重新激活订阅</button>
                `}
            </div>
        </div>
    `;
}

function renderPastDueNotice() {
    return `
        <div class="alert alert-error" style="margin-top:16px">
            ⚠️ 您的订阅付款失败，请尽快更新支付方式，否则将在宽限期后降级为免费版。
        </div>
    `;
}

export async function bindSubscriptionEvents() {
    const manageBtn = document.getElementById('manageSubBtn');
    if (manageBtn) {
        manageBtn.addEventListener('click', async () => {
            manageBtn.disabled = true;
            manageBtn.innerHTML = '<span class="spinner"></span> 正在跳转...';
            try {
                const result = await api.createPortalSession();
                if (result?.ok && result.data?.portalUrl) {
                    window.location.href = result.data.portalUrl;
                } else {
                    alert(result?.error || '支付系统未配置，请使用模拟操作');
                    manageBtn.disabled = false;
                    manageBtn.textContent = '管理订阅';
                }
            } catch {
                alert('网络错误');
                manageBtn.disabled = false;
                manageBtn.textContent = '管理订阅';
            }
        });
    }

    const cancelBtn = document.getElementById('cancelSubBtn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', async () => {
            if (!confirm('确定要取消订阅吗？\n\n取消后您仍可在当前周期内使用，周期结束后将降级为免费版。')) return;

            cancelBtn.disabled = true;
            try {
                const result = await api.mockCancel();
                if (result?.ok) {
                    alert('订阅将在当前周期结束后取消');
                    location.reload();
                } else {
                    alert(result?.error || '操作失败');
                    cancelBtn.disabled = false;
                }
            } catch {
                alert('网络错误');
                cancelBtn.disabled = false;
            }
        });
    }

    const reactivateBtn = document.getElementById('reactivateBtn');
    if (reactivateBtn) {
        reactivateBtn.addEventListener('click', async () => {
            reactivateBtn.disabled = true;
            try {
                const result = await api.mockReactivate();
                if (result?.ok) {
                    alert('订阅已重新激活');
                    location.reload();
                } else {
                    alert(result?.error || '操作失败');
                    reactivateBtn.disabled = false;
                }
            } catch {
                alert('网络错误');
                reactivateBtn.disabled = false;
            }
        });
    }
}
