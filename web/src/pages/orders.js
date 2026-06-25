import api from '../lib/api.js';

export function renderOrders(orders) {
    const list = orders?.data || orders || [];

    return `
        <div class="orders-page">
            <div class="page-header">
                <h1>订单记录</h1>
            </div>

            ${list.length === 0 ? `
                <div class="card" style="text-align:center; padding:48px">
                    <div style="font-size:48px; margin-bottom:12px">🧾</div>
                    <h3>暂无订单</h3>
                    <p style="color:var(--gray-500); margin-top:8px">升级后订单将在此显示</p>
                </div>
            ` : `
                <div class="card">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>订单号</th>
                                <th>产品</th>
                                <th>金额</th>
                                <th>状态</th>
                                <th>时间</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${list.map(o => `
                                <tr>
                                    <td><code>${o.order_number || o.ls_order_id?.slice(0, 8) || '-'}</code></td>
                                    <td>${o.product_name || '-'} ${o.variant_name ? `(${o.variant_name})` : ''}</td>
                                    <td>${o.currency?.toUpperCase() || 'USD'} ${(o.amount / 100).toFixed(2)}</td>
                                    <td>
                                        <span class="badge ${o.status === 'paid' ? 'badge-pro' : 'badge-free'}">
                                            ${o.status === 'paid' ? '✅ 已支付' : '⏳ 待支付'}
                                        </span>
                                    </td>
                                    <td>${new Date(o.created_at).toLocaleDateString('zh-CN')}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `}
        </div>
    `;
}
