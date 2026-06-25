const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const quotaService = require('../services/quotaService');
const { success, fail } = require('../utils/response');

router.get('/quota', auth, async (req, res, next) => {
    try {
        const info = await quotaService.getQuotaInfo(req.user.id);
        if (!info) return fail(res, '无法获取额度', 404, 'NOT_FOUND');
        success(res, {
            plan: info.plan,
            total: info.quota_total,
            used: info.quota_used,
            remaining: info.quota_remaining,
            resetAt: info.quota_reset_at,
            unlimited: info.plan === 'pro' || info.plan === 'enterprise'
        });
    } catch (err) {
        next(err);
    }
});

router.post('/quota/deduct', auth, async (req, res, next) => {
    try {
        const { action = 'task_start', productCount = 0, imageCount = 0, metadata = {} } = req.body || {};
        const result = await quotaService.deductQuota(req.user.id, {
            action, productCount, imageCount, metadata
        });

        if (!result.success) {
            return fail(res, '本月免费额度已用完', 403, 'QUOTA_EXHAUSTED', {
                remaining: result.remaining,
                plan: result.plan,
                upgradeUrl: '/pricing'
            });
        }

        success(res, {
            charged: true,
            remaining: result.remaining,
            plan: result.plan
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
