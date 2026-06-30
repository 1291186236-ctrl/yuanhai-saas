const Models = require('../db/models');
const db = require('../db/database');
const quotaService = require('../services/quotaService');

async function checkExpiredSubscriptions() {
    console.log('[Cron] Checking expired subscriptions...');

    const { rows } = await db.query(`
        UPDATE subscriptions
        SET status = 'expired'
        WHERE status = 'active'
          AND cancel_at_period_end = TRUE
          AND current_period_end <= NOW()
        RETURNING user_id
    `);

    for (const row of rows) {
        await db.query("UPDATE users SET plan = 'free', quota_total = 10 WHERE id = $1", [row.user_id]);
        console.log(`[Cron] User ${row.user_id} subscription expired, downgraded to free`);
    }

    console.log(`[Cron] Processed ${rows.length} expired subscriptions`);
    return rows.length;
}

async function resetMonthlyQuota() {
    console.log('[Cron] Resetting monthly quota...');
    await quotaService.resetExpiredQuota();
    console.log('[Cron] Monthly quota reset complete');
}

async function checkPastDueSubscriptions() {
    console.log('[Cron] Checking past_due subscriptions...');

    const { rows } = await db.query(`
        SELECT user_id FROM subscriptions
        WHERE status = 'past_due'
          AND current_period_end <= NOW() - INTERVAL '7 days'
    `);

    for (const row of rows) {
        await db.transaction(async (client) => {
            await client.query("UPDATE users SET plan = 'free', quota_total = 10 WHERE id = $1", [row.user_id]);
            await client.query("UPDATE subscriptions SET status = 'expired' WHERE user_id = $1", [row.user_id]);
        });
        console.log(`[Cron] Past-due user ${row.user_id} downgraded after grace period`);
    }

    return rows.length;
}

module.exports = {
    checkExpiredSubscriptions,
    resetMonthlyQuota,
    checkPastDueSubscriptions
};
