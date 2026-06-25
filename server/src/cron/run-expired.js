require('dotenv').config();
const { checkExpiredSubscriptions, checkPastDueSubscriptions } = require('../cron/subscriptions');

(async () => {
    console.log('[Cron:expired] Starting...');
    try {
        const count = await checkExpiredSubscriptions();
        console.log(`[Cron:expired] Done. Processed ${count} expired subscriptions.`);
    } catch (err) {
        console.error('[Cron:expired] Error:', err);
        process.exit(1);
    }

    console.log('[Cron:past-due] Starting...');
    try {
        const count2 = await checkPastDueSubscriptions();
        console.log(`[Cron:past-due] Done. Processed ${count2} past-due subscriptions.`);
    } catch (err) {
        console.error('[Cron:past-due] Error:', err);
        process.exit(1);
    }

    process.exit(0);
})();
