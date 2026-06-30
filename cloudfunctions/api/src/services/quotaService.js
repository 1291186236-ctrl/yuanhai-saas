const db = require('../db/database');
const Models = require('../db/models');
const { deductQuotaAtomic } = require('../middleware/quota');

async function getQuotaInfo(userId) {
    return Models.User.getQuotaInfo(userId);
}

async function deductQuota(userId, { action = 'task_start', productCount = 0, imageCount = 0, metadata = {} }) {
    const result = await deductQuotaAtomic(userId, 1);

    if (!result.success) {
        return {
            success: false,
            reason: 'QUOTA_EXHAUSTED',
            remaining: result.remaining,
            plan: result.plan
        };
    }

    await Models.UsageRecord.create({
        userId,
        action,
        productCount,
        imageCount,
        quotaCharged: 1,
        metadata
    });

    return {
        success: true,
        remaining: result.remaining,
        plan: result.plan
    };
}

async function getUsageStats(userId) {
    const now = new Date();
    const monthly = await Models.UsageRecord.getMonthlyUsage(userId, now.getFullYear(), now.getMonth() + 1);
    const recent = await Models.UsageRecord.getRecentUsage(userId, 20);
    const daily = await Models.UsageRecord.getDailyStats(userId, 30);

    return {
        monthly: {
            totalTasks: parseInt(monthly?.total_tasks || 0, 10),
            totalQuotaUsed: parseInt(monthly?.total_quota_used || 0, 10),
            totalProducts: parseInt(monthly?.total_products || 0, 10),
            totalImages: parseInt(monthly?.total_images || 0, 10)
        },
        recent,
        daily
    };
}

async function resetExpiredQuota() {
    await db.query('SELECT reset_monthly_quota()');
}

module.exports = {
    getQuotaInfo,
    deductQuota,
    getUsageStats,
    resetExpiredQuota
};
