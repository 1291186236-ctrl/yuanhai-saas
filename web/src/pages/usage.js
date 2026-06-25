import api from '../lib/api.js';

export function renderUsage(user, usageStats, quota) {
    const monthly = usageStats?.monthly || {};
    const daily = usageStats?.daily || [];
    const isFree = user?.plan === 'free';

    return `
        <div class="usage-page">
            <div class="page-header">
                <h1>使用统计</h1>
            </div>

            <div class="usage-stats-grid">
                <div class="card stat-card">
                    <div class="stat-icon">📊</div>
                    <div class="stat-value">${monthly.totalTasks || 0}</div>
                    <div class="stat-label">本月任务数</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-icon">📦</div>
                    <div class="stat-value">${monthly.totalProducts || 0}</div>
                    <div class="stat-label">处理商品数</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-icon">🖼️</div>
                    <div class="stat-value">${monthly.totalImages || 0}</div>
                    <div class="stat-label">处理图片数</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-icon">${isFree ? '🎫' : '♾️'}</div>
                    <div class="stat-value">${isFree ? (quota?.remaining || 0) : '∞'}</div>
                    <div class="stat-label">剩余额度</div>
                </div>
            </div>

            ${daily.length > 0 ? `
                <div class="card">
                    <h3>近 30 天使用趋势</h3>
                    <div class="daily-chart">
                        ${daily.map(d => {
                            const maxVal = Math.max(...daily.map(x => parseInt(x.count || 0)), 1);
                            const height = Math.max(2, (parseInt(d.count || 0) / maxVal) * 100);
                            return `<div class="chart-bar-wrap" title="${d.date}: ${d.count}次">
                                <div class="chart-bar" style="height:${height}%"></div>
                                <span class="chart-label">${d.date.slice(-2)}</span>
                            </div>`;
                        }).join('')}
                    </div>
                </div>
            ` : ''}

            ${usageStats?.recent?.length ? `
                <div class="card">
                    <h3>最近使用记录</h3>
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>时间</th>
                                <th>操作</th>
                                <th>商品数</th>
                                <th>图片数</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${usageStats.recent.map(r => `
                                <tr>
                                    <td>${new Date(r.created_at).toLocaleString('zh-CN')}</td>
                                    <td>${r.action}</td>
                                    <td>${r.product_count || 0}</td>
                                    <td>${r.image_count || 0}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            ` : ''}
        </div>
    `;
}
