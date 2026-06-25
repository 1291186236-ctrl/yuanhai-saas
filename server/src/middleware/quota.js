const { fail } = require('../utils/response');
const Models = require('../db/models');
const db = require('../db/database');

async function quota(req, res, next) {
    if (!req.user) {
        return fail(res, '需要登录', 401, 'NO_TOKEN');
    }

    const plan = req.user.plan;
    if (plan === 'pro' || plan === 'enterprise') {
        req.quotaInfo = { unlimited: true, plan };
        return next();
    }

    const info = await Models.User.getQuotaInfo(req.user.id);
    if (!info) {
        return fail(res, '无法获取额度信息', 500, 'QUOTA_FETCH_FAILED');
    }

    if (info.quota_remaining <= 0) {
        return fail(res, '本月免费额度已用完，请升级 Pro 解锁无限使用', 403, 'QUOTA_EXHAUSTED', {
            plan: info.plan,
            quotaTotal: info.quota_total,
            quotaUsed: info.quota_used,
            quotaResetAt: info.quota_reset_at,
            upgradeUrl: '/pricing'
        });
    }

    req.quotaInfo = {
        unlimited: false,
        plan: info.plan,
        remaining: info.quota_remaining,
        total: info.quota_total,
        used: info.quota_used,
        resetAt: info.quota_reset_at
    };
    next();
}

async function deductQuotaAtomic(userId, amount = 1) {
    const { rows } = await db.query('SELECT * FROM deduct_quota($1, $2)', [userId, amount]);
    return rows[0];
}

module.exports = { quota, deductQuotaAtomic };
