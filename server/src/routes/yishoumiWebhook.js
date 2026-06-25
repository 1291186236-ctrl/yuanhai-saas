const express = require('express');
const router = express.Router();
const yishoumi = require('../services/yishoumi');
const Models = require('../db/models');
const db = require('../db/database');
const env = require('../config/env');

/**
 * 易收米支付回调
 * 支付成功后易收米会向 notify_url 发送 GET/POST 请求
 * 参数: pid, trade_no, out_trade_no, type, name, money, trade_status, sign, sign_type
 */
router.all('/webhook/yishoumi', async (req, res) => {
    try {
        // 兼容 GET 和 POST 表单
        const params = req.method === 'GET'
            ? req.query
            : { ...req.query, ...req.body };

        console.log('[YSM Webhook] Received callback:', JSON.stringify(params));

        const callbackData = yishoumi.parseCallback(params);

        // 验签
        if (!yishoumi.verifyCallbackSign(callbackData, env.yishoumi.merchantKey)) {
            console.warn('[YSM Webhook] Invalid signature');
            return res.send('fail');
        }

        // 只处理支付成功的回调
        if (callbackData.trade_status !== 'TRADE_SUCCESS') {
            console.log(`[YSM Webhook] Trade status: ${callbackData.trade_status}, skipping`);
            return res.send('success');
        }

        const outTradeNo = callbackData.out_trade_no;
        const tradeNo = callbackData.trade_no;
        const money = callbackData.money;

        // 幂等检查：订单是否已处理
        const { rows: existingOrders } = await db.query(
            'SELECT * FROM orders WHERE order_number = $1 AND status = $2',
            [outTradeNo, 'paid']
        );
        if (existingOrders.length > 0) {
            console.log(`[YSM Webhook] Order ${outTradeNo} already processed`);
            return res.send('success');
        }

        // 查找订单
        const { rows: orderRows } = await db.query(
            'SELECT * FROM orders WHERE order_number = $1',
            [outTradeNo]
        );
        if (orderRows.length === 0) {
            console.warn(`[YSM Webhook] Order not found: ${outTradeNo}`);
            return res.send('fail');
        }

        const order = orderRows[0];
        const planKey = order.variant_name;
        const planInfo = yishoumi.PLAN_CONFIG[planKey];

        if (!planInfo) {
            console.warn(`[YSM Webhook] Unknown plan: ${planKey}`);
            return res.send('fail');
        }

        // 计算订阅周期
        const now = new Date();
        const periodEnd = new Date(now);
        if (planInfo.cycle === 'monthly') {
            periodEnd.setMonth(periodEnd.getMonth() + 1);
        } else {
            periodEnd.setFullYear(periodEnd.getFullYear() + 1);
        }

        // 事务：更新订单状态 + 升级会员 + 创建/更新订阅
        await db.transaction(async (client) => {
            // 更新订单状态为已支付
            await client.query(
                `UPDATE orders SET status = 'paid' WHERE id = $1`,
                [order.id]
            );

            // 升级用户会员等级
            await client.query('SELECT * FROM upgrade_user_plan($1, $2)', [order.user_id, planInfo.plan]);

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
                    order.user_id,
                    `ysm_sub_${tradeNo}`,
                    `ysm_customer_${order.user_id}`,
                    'yishoumi',
                    planKey,
                    planInfo.plan,
                    now,
                    periodEnd
                ]
            );
        });

        console.log(`[YSM Webhook] ✅ User ${order.user_id} upgraded to ${planInfo.plan} via ${callbackData.type}`);

        // 返回 success 给易收米
        res.send('success');
    } catch (err) {
        console.error('[YSM Webhook] Error:', err);
        res.send('fail');
    }
});

module.exports = router;
