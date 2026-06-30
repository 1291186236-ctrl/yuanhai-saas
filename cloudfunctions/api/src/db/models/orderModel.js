const db = require('../database');

const OrderModel = {
    async create({
        userId, lsOrderId, lsOrderItemId, orderNumber,
        productName, variantName, amount, currency = 'USD',
        status = 'pending', lsSubscriptionId = null
    }) {
        const { rows } = await db.query(
            `INSERT INTO orders
                (user_id, ls_order_id, ls_order_item_id, order_number,
                 product_name, variant_name, amount, currency,
                 status, ls_subscription_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING *`,
            [userId, lsOrderId, lsOrderItemId, orderNumber,
             productName, variantName, amount, currency,
             status, lsSubscriptionId]
        );
        return rows[0];
    },

    async findByUserId(userId, { limit = 20, offset = 0 } = {}) {
        const { rows } = await db.query(
            `SELECT * FROM orders WHERE user_id = $1
             ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
        );
        return rows;
    },

    async findByLsOrderId(lsOrderId) {
        const { rows } = await db.query(
            `SELECT * FROM orders WHERE ls_order_id = $1`,
            [lsOrderId]
        );
        return rows[0] || null;
    },

    async updateStatus(orderId, status) {
        const { rows } = await db.query(
            `UPDATE orders SET status = $2 WHERE id = $1 RETURNING *`,
            [orderId, status]
        );
        return rows[0];
    },

    async getMonthlyRevenue(year, month) {
        const { rows } = await db.query(
            `SELECT currency,
                    COUNT(*) AS order_count,
                    SUM(amount) AS total_amount
             FROM orders
             WHERE status = 'paid'
               AND EXTRACT(YEAR FROM created_at)  = $1
               AND EXTRACT(MONTH FROM created_at) = $2
             GROUP BY currency`,
            [year, month]
        );
        return rows;
    }
};

module.exports = OrderModel;
