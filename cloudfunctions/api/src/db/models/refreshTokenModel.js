const db = require('../database');

const RefreshTokenModel = {
    async create({ userId, tokenHash, deviceInfo = '', expiresAt }) {
        const { rows } = await db.query(
            `INSERT INTO refresh_tokens (user_id, token_hash, device_info, expires_at)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [userId, tokenHash, deviceInfo, expiresAt]
        );
        return rows[0];
    },

    async findByTokenHash(tokenHash) {
        const { rows } = await db.query(
            `SELECT rt.*, u.email, u.plan, u.status AS user_status
             FROM refresh_tokens rt
             JOIN users u ON u.id = rt.user_id
             WHERE rt.token_hash = $1 AND rt.expires_at > NOW()`,
            [tokenHash]
        );
        return rows[0] || null;
    },

    async revokeByUserId(userId) {
        await db.query(
            `DELETE FROM refresh_tokens WHERE user_id = $1`,
            [userId]
        );
    },

    async revokeById(tokenId) {
        await db.query(
            `DELETE FROM refresh_tokens WHERE id = $1`,
            [tokenId]
        );
    },

    async cleanExpired() {
        const { rowCount } = await db.query(
            `DELETE FROM refresh_tokens WHERE expires_at < NOW()`
        );
        return rowCount;
    }
};

module.exports = RefreshTokenModel;
