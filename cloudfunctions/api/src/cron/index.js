const cron = require('node-cron');
const { checkExpiredSubscriptions, resetMonthlyQuota, checkPastDueSubscriptions } = require('./subscriptions');

function startCronJobs() {
    cron.schedule('0 * * * *', async () => {
        try {
            await checkExpiredSubscriptions();
        } catch (err) {
            console.error('[Cron] checkExpiredSubscriptions error:', err);
        }
    });

    cron.schedule('0 0 1 * *', async () => {
        try {
            await resetMonthlyQuota();
        } catch (err) {
            console.error('[Cron] resetMonthlyQuota error:', err);
        }
    });

    cron.schedule('0 */6 * * *', async () => {
        try {
            await checkPastDueSubscriptions();
        } catch (err) {
            console.error('[Cron] checkPastDueSubscriptions error:', err);
        }
    });

    console.log('[Cron] ✅ Scheduled jobs started');
}

module.exports = { startCronJobs };
