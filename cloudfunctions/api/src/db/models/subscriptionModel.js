const db = require('../database');

const SubscriptionModel = {
    async findByUserId(userId) {
        const { rows } = await db.query(
            `SELECT * FROM subscriptions WHERE user_id = $1`,
            [userId]
        );
        return rows[0] || null;
    },

    async findByLsSubscriptionId(lsSubId) {
        const { rows } = await db.query(
            `SELECT * FROM subscriptions WHERE ls_subscription_id = $1`,
            [lsSubId]
        );
        return rows[0] || null;
    },

    async findByLsCustomerId(lsCustomerId) {
        const { rows } = await db.query(
            `SELECT * FROM subscriptions WHERE ls_customer_id = $1`,
            [lsCustomerId]
        );
        return rows;
    },

    async create({
        userId, lsSubscriptionId, lsCustomerId,
        lsProductId, lsVariantId, plan,
        status = 'active', currentPeriodStart, currentPeriodEnd
    }) {
        const { rows } = await db.query(
            `INSERT INTO subscriptions
                (user_id, ls_subscription_id, ls_customer_id,
                 ls_product_id, ls_variant_id, plan, status,
                 current_period_start, current_period_end)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (user_id) DO UPDATE SET
                 ls_subscription_id = EXCLUDED.ls_subscription_id,
                 ls_customer_id    = EXCLUDED.ls_customer_id,
                 ls_product_id     = EXCLUDED.ls_product_id,
                 ls_variant_id     = EXCLUDED.ls_variant_id,
                 plan              = EXCLUDED.plan,
                 status            = EXCLUDED.status,
                 current_period_start = EXCLUDED.current_period_start,
                 current_period_end   = EXCLUDED.current_period_end,
                 cancel_at_period_end = FALSE,
                 cancelled_at        = NULL
             RETURNING *`,
            [userId, lsSubscriptionId, lsCustomerId,
             lsProductId, lsVariantId, plan, status,
             currentPeriodStart, currentPeriodEnd]
        );
        return rows[0];
    },

    async updateStatus(subscriptionId, status) {
        const { rows } = await db.query(
            `UPDATE subscriptions SET status = $2 WHERE id = $1 RETURNING *`,
            [subscriptionId, status]
        );
        return rows[0];
    },

    async cancelAtPeriodEnd(subscriptionId) {
        const { rows } = await db.query(
            `UPDATE subscriptions
             SET cancel_at_period_end = TRUE, cancelled_at = NOW()
             WHERE id = $1 RETURNING *`,
            [subscriptionId]
        );
        return rows[0];
    },

    async renewPeriod(subscriptionId, periodStart, periodEnd) {
        const { rows } = await db.query(
            `UPDATE subscriptions
             SET current_period_start = $2,
                 current_period_end   = $3,
                 cancel_at_period_end = FALSE,
                 cancelled_at         = NULL,
                 status               = 'active'
             WHERE id = $1 RETURNING *`,
            [subscriptionId, periodStart, periodEnd]
        );
        return rows[0];
    },

    async findExpiringSoon(hours = 24) {
        const { rows } = await db.query(
            `SELECT * FROM subscriptions
             WHERE status = 'active'
               AND current_period_end <= NOW() + ($1 || ' hours')::INTERVAL
               AND current_period_end > NOW()`,
            [hours]
        );
        return rows;
    }
};

module.exports = SubscriptionModel;
