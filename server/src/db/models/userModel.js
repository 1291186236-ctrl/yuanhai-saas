const db = require('../database');

const UserModel = {
    async findById(id) {
        const { rows } = await db.query(
            `SELECT id, email, name, avatar_url, plan, quota_total, quota_used,
                    quota_reset_at, auth_provider, email_verified, status,
                    last_login_at, created_at
             FROM users WHERE id = $1`,
            [id]
        );
        return rows[0] || null;
    },

    async findByEmail(email) {
        const { rows } = await db.query(
            `SELECT * FROM users WHERE email = $1`,
            [email]
        );
        return rows[0] || null;
    },

    async findByGoogleId(googleId) {
        const { rows } = await db.query(
            `SELECT * FROM users WHERE google_id = $1`,
            [googleId]
        );
        return rows[0] || null;
    },

    async create({ email, passwordHash, name, authProvider = 'email', googleId = null }) {
        const { rows } = await db.query(
            `INSERT INTO users (email, password_hash, name, auth_provider, google_id)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, email, name, plan, quota_total, quota_used, auth_provider, created_at`,
            [email, passwordHash, name, authProvider, googleId]
        );
        return rows[0];
    },

    async updateLastLogin(userId, ip) {
        await db.query(
            `UPDATE users SET last_login_at = NOW(), last_login_ip = $2 WHERE id = $1`,
            [userId, ip]
        );
    },

    async verifyEmail(userId) {
        await db.query(
            `UPDATE users SET email_verified = TRUE WHERE id = $1`,
            [userId]
        );
    },

    async updateProfile(userId, { name, avatarUrl }) {
        const sets = [];
        const vals = [userId];
        let idx = 2;
        if (name !== undefined) { sets.push(`name = $${idx++}`); vals.push(name); }
        if (avatarUrl !== undefined) { sets.push(`avatar_url = $${idx++}`); vals.push(avatarUrl); }
        if (!sets.length) return;
        await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
    },

    async getQuotaInfo(userId) {
        const { rows } = await db.query(
            `SELECT plan, quota_total, quota_used,
                    GREATEST(0, quota_total - quota_used) AS quota_remaining,
                    quota_reset_at
             FROM users WHERE id = $1`,
            [userId]
        );
        return rows[0] || null;
    },

    async getSubscriptionSummary(userId) {
        const { rows } = await db.query(
            `SELECT * FROM v_user_subscription WHERE user_id = $1`,
            [userId]
        );
        return rows[0] || null;
    }
};

module.exports = UserModel;
