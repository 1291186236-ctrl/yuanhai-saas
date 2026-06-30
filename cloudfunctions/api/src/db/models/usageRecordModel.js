const db = require('../database');

const UsageRecordModel = {
    async create({
        userId, action = 'task_start',
        productCount = 0, imageCount = 0,
        quotaCharged = 1, metadata = {}
    }) {
        const { rows } = await db.query(
            `INSERT INTO usage_records
                (user_id, action, product_count, image_count, quota_charged, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [userId, action, productCount, imageCount, quotaCharged, JSON.stringify(metadata)]
        );
        return rows[0];
    },

    async getMonthlyUsage(userId, year, month) {
        const { rows } = await db.query(
            `SELECT COUNT(*) AS total_tasks,
                    SUM(quota_charged) AS total_quota_used,
                    SUM(product_count) AS total_products,
                    SUM(image_count) AS total_images
             FROM usage_records
             WHERE user_id = $1
               AND EXTRACT(YEAR FROM created_at)  = $2
               AND EXTRACT(MONTH FROM created_at) = $3`,
            [userId, year, month]
        );
        return rows[0];
    },

    async getRecentUsage(userId, limit = 50) {
        const { rows } = await db.query(
            `SELECT id, action, product_count, image_count, quota_charged, created_at
             FROM usage_records
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [userId, limit]
        );
        return rows;
    },

    async getDailyStats(userId, days = 30) {
        const { rows } = await db.query(
            `SELECT DATE(created_at) AS date,
                    COUNT(*) AS task_count,
                    SUM(quota_charged) AS quota_used,
                    SUM(product_count) AS product_count,
                    SUM(image_count) AS image_count
             FROM usage_records
             WHERE user_id = $1
               AND created_at >= NOW() - ($2 || ' days')::INTERVAL
             GROUP BY DATE(created_at)
             ORDER BY date DESC`,
            [userId, days]
        );
        return rows;
    }
};

module.exports = UsageRecordModel;
