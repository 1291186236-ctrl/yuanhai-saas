const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const lemonSqueezy = require('../services/lemonSqueezy');
const yishoumi = require('../services/yishoumi');
const Models = require('../db/models');
const db = require('../db/database');
const env = require('../config/env');
const { success, fail } = require('../utils/response');

const VALID_PLANS = {
    'pro_monthly': env.lemonSqueezy.variants.pro_monthly,
    'pro_yearly': env.lemonSqueezy.variants.pro_yearly,
    'ent_monthly': env.lemonSqueezy.variants.ent_monthly,
    'ent_yearly': env.lemonSqueezy.variants.ent_yearly
};

// 模拟支付方案配置（amount 单位：分）
const MOCK_PLANS = {
    'pro_monthly':        { plan: 'pro',        cycle: 'monthly', amount: 990,   name: '专业版月付' },
    'pro_yearly':         { plan: 'pro',        cycle: 'yearly',  amount: 9900,  name: '专业版年付' },
    'ent_monthly':        { plan: 'enterprise', cycle: 'monthly', amount: 29900, name: '企业版月付' },
    'ent_yearly':         { plan: 'enterprise', cycle: 'yearly',  amount: 299000, name: '企业版年付' }
};

// ── 模拟支付：创建结账（直接返回成功，不跳转外部支付）──
router.post('/billing/mock-checkout', auth, async (req, res, next) => {
    try {
        const { plan } = req.body || {};
        const planInfo = MOCK_PLANS[plan];
        if (!planInfo) {
            return fail(res, '无效的订阅方案', 400, 'INVALID_PLAN', { validPlans: Object.keys(MOCK_PLANS) });
        }

        // 计算订阅周期
        const now = new Date();
        const periodEnd = new Date(now);
        if (planInfo.cycle === 'monthly') {
            periodEnd.setMonth(periodEnd.getMonth() + 1);
        } else {
            periodEnd.setFullYear(periodEnd.getFullYear() + 1);
        }

        // 事务：升级会员 + 创建订阅记录 + 创建订单
        await db.transaction(async (client) => {
            // 升级用户会员等级
            await client.query('SELECT * FROM upgrade_user_plan($1, $2)', [req.user.id, planInfo.plan]);

            // 创建/更新订阅记录
            await client.query(
                `INSERT INTO subscriptions
                    (user_id, ls_subscription_id, ls_customer_id, ls_product_id, ls_variant_id,
                     plan, status, current_period_start, current_period_end)
                 VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)
                 ON CONFLICT (user_id) DO UPDATE SET
                     ls_subscription_id = EXCLUDED.ls_subscription_id,
                     ls_customer_id    = EXCLUDED.ls_customer_id,
                     ls_product_id     = EXCLUDED.ls_product_id,
                     ls_variant_id     = EXCLUDED.ls_variant_id,
                     plan              = EXCLUDED.plan,
                     status            = 'active',
                     current_period_start = EXCLUDED.current_period_start,
                     current_period_end   = EXCLUDED.current_period_end,
                     cancel_at_period_end = FALSE,
                     cancelled_at        = NULL`,
                [
                    req.user.id,
                    `mock_sub_${Date.now()}`,
                    `mock_customer_${req.user.id}`,
                    'mock_product',
                    plan,
                    planInfo.plan,
                    now,
                    periodEnd
                ]
            );

            // 创建订单记录
            await client.query(
                `INSERT INTO orders
                    (user_id, ls_order_id, ls_order_item_id, order_number,
                     product_name, variant_name, amount, currency, status, ls_subscription_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'CNY', 'paid', $8)`,
                [
                    req.user.id,
                    `mock_order_${Date.now()}`,
                    `mock_item_${Date.now()}`,
                    `MOCK-${Date.now().toString(36).toUpperCase()}`,
                    planInfo.name,
                    plan,
                    planInfo.amount,
                    `mock_sub_${Date.now()}`
                ]
            );
        });

        success(res, {
            mock: true,
            plan: planInfo.plan,
            cycle: planInfo.cycle,
            amount: planInfo.amount / 100,
            message: '模拟支付成功，会员已升级'
        });
    } catch (err) {
        next(err);
    }
});

// ── 模拟支付：取消订阅 ──
router.post('/billing/mock-cancel', auth, async (req, res, next) => {
    try {
        const sub = await Models.Subscription.findByUserId(req.user.id);
        if (!sub) {
            return fail(res, '暂无订阅', 400, 'NO_SUBSCRIPTION');
        }

        await Models.Subscription.cancelAtPeriodEnd(sub.id);

        success(res, { message: '订阅将在当前周期结束后取消' });
    } catch (err) {
        next(err);
    }
});

// ── 模拟支付：重新激活订阅 ──
router.post('/billing/mock-reactivate', auth, async (req, res, next) => {
    try {
        const sub = await Models.Subscription.findByUserId(req.user.id);
        if (!sub) {
            return fail(res, '暂无订阅', 400, 'NO_SUBSCRIPTION');
        }

        await db.query(
            `UPDATE subscriptions
             SET cancel_at_period_end = FALSE, cancelled_at = NULL
             WHERE id = $1`,
            [sub.id]
        );

        success(res, { message: '订阅已重新激活' });
    } catch (err) {
        next(err);
    }
});

// ── 易收米支付：创建支付订单 ──
router.post('/billing/yishoumi/checkout', auth, async (req, res, next) => {
    try {
        const { plan, payType } = req.body || {};
        if (!plan || !payType) {
            return fail(res, '缺少 plan 或 payType 参数', 400, 'MISSING_PARAMS');
        }
        if (!['alipay', 'wxpay'].includes(payType)) {
            return fail(res, '不支持的支付方式', 400, 'INVALID_PAY_TYPE');
        }

        const result = await yishoumi.createOrder({
            planKey: plan,
            userId: req.user.id,
            payType
        });

        // 在数据库中创建 pending 订单记录
        await db.query(
            `INSERT INTO orders
                (user_id, ls_order_id, ls_order_item_id, order_number,
                 product_name, variant_name, amount, currency, status, ls_subscription_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'CNY', 'pending', $8)`,
            [
                req.user.id,
                result.outTradeNo,
                result.tradeNo,
                result.outTradeNo,
                result.planInfo.name,
                plan,
                Math.round(parseFloat(result.planInfo.amount) * 100),
                null
            ]
        );

        success(res, {
            payUrl: result.payUrl,
            outTradeNo: result.outTradeNo,
            tradeNo: result.tradeNo,
            planName: result.planInfo.name,
            amount: result.planInfo.amount
        });
    } catch (err) {
        if (err.code === 'YSM_NOT_CONFIGURED') {
            return fail(res, '易收米支付未配置，请先在 .env 中设置 YSM_PID 和 YSM_MERCHANT_KEY', 400, err.code);
        }
        if (err.code === 'INVALID_PLAN') {
            return fail(res, '无效的订阅方案', 400, err.code);
        }
        next(err);
    }
});

// ── 易收米支付：查询订单状态 ──
router.get('/billing/yishoumi/status/:outTradeNo', auth, async (req, res, next) => {
    try {
        const { outTradeNo } = req.params;
        const result = await yishoumi.queryOrder(outTradeNo);
        success(res, result);
    } catch (err) {
        next(err);
    }
});

// ── Lemon Squeezy 正式结账（配置 API Key 后启用）──
router.post('/billing/checkout', auth, async (req, res, next) => {
    try {
        const { plan } = req.body || {};

        // 如果没有配置 Lemon Squeezy，走模拟支付
        if (!env.lemonSqueezy.apiKey) {
            return fail(res, '支付系统未配置，请使用模拟支付', 400, 'PAYMENT_NOT_CONFIGURED');
        }

        const variantId = VALID_PLANS[plan];
        if (!variantId) {
            return fail(res, '无效的订阅方案', 400, 'INVALID_PLAN', { validPlans: Object.keys(VALID_PLANS) });
        }

        const result = await lemonSqueezy.createCheckout({
            variantId,
            userId: req.user.id,
            userEmail: req.user.email,
            redirectUrl: env.web.origin + '/account?status=success'
        });

        success(res, { checkoutUrl: result.checkoutUrl });
    } catch (err) {
        next(err);
    }
});

router.post('/billing/portal', auth, async (req, res, next) => {
    try {
        if (!env.lemonSqueezy.apiKey) {
            return fail(res, '支付系统未配置', 400, 'PAYMENT_NOT_CONFIGURED');
        }

        const sub = await Models.Subscription.findByUserId(req.user.id);
        const result = await lemonSqueezy.createCustomerPortalSession({
            customerId: sub?.ls_customer_id,
            userEmail: req.user.email
        });
        success(res, { portalUrl: result.portalUrl });
    } catch (err) {
        if (err.code === 'NO_LS_CUSTOMER') {
            return fail(res, '尚未购买订阅，无需管理', 400, 'NO_SUBSCRIPTION');
        }
        next(err);
    }
});

router.get('/billing/orders', auth, async (req, res, next) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
        const offset = parseInt(req.query.offset || '0', 10);
        const orders = await Models.Order.findByUserId(req.user.id, { limit, offset });
        success(res, orders);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
