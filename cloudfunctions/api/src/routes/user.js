const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const Models = require('../db/models');
const quotaService = require('../services/quotaService');
const { success, fail } = require('../utils/response');

router.get('/me', auth, async (req, res, next) => {
    try {
        const summary = await Models.User.getSubscriptionSummary(req.user.id);
        if (!summary) return fail(res, '用户不存在', 404, 'USER_NOT_FOUND');

        success(res, {
            id: summary.user_id,
            email: summary.email,
            name: summary.name,
            avatarUrl: null,
            plan: summary.plan,
            emailVerified: summary.email_verified,
            status: summary.user_status,
            quota: {
                total: summary.quota_total,
                used: summary.quota_used,
                remaining: summary.quota_remaining,
                resetAt: summary.quota_reset_at
            },
            subscription: summary.ls_subscription_id ? {
                id: summary.ls_subscription_id,
                status: summary.subscription_status,
                plan: summary.subscription_plan,
                currentPeriodStart: summary.current_period_start,
                currentPeriodEnd: summary.current_period_end,
                cancelAtPeriodEnd: summary.cancel_at_period_end
            } : null
        });
    } catch (err) {
        next(err);
    }
});

router.get('/me/subscription', auth, async (req, res, next) => {
    try {
        const sub = await Models.Subscription.findByUserId(req.user.id);
        success(res, sub);
    } catch (err) {
        next(err);
    }
});

router.get('/me/usage', auth, async (req, res, next) => {
    try {
        const stats = await quotaService.getUsageStats(req.user.id);
        success(res, stats);
    } catch (err) {
        next(err);
    }
});

router.patch('/me', auth, async (req, res, next) => {
    try {
        const { name, avatarUrl } = req.body || {};
        await Models.User.updateProfile(req.user.id, { name, avatarUrl });
        const user = await Models.User.findById(req.user.id);
        success(res, {
            id: user.id,
            email: user.email,
            name: user.name,
            avatarUrl: user.avatar_url
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
