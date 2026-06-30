require('dotenv').config();
const { resetMonthlyQuota } = require('../cron/subscriptions');

(async () => {
    console.log('[Cron:quota-reset] Starting...');
    try {
        await resetMonthlyQuota();
        console.log('[Cron:quota-reset] Done.');
    } catch (err) {
        console.error('[Cron:quota-reset] Error:', err);
        process.exit(1);
    }
    process.exit(0);
})();
