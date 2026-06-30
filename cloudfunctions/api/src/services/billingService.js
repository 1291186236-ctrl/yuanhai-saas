const Models = require('../db/models');
const db = require('../db/database');

async function handleRefund({ userId, lsSubscriptionId, refundType }) {
    if (!userId || !lsSubscriptionId) {
        const err = new Error('缺少必要参数'); err.code = 'INVALID_INPUT'; throw err;
    }

    const sub = await Models.Subscription.findByLsSubscriptionId(lsSubscriptionId);
    if (!sub) {
        const err = new Error('订阅不存在'); err.code = 'SUB_NOT_FOUND'; throw err;
    }

    if (refundType === 'full') {
        await db.transaction(async (client) => {
            await client.query("UPDATE users SET plan = 'free', quota_total = 10 WHERE id = $1", [userId]);
            await client.query(
                "UPDATE subscriptions SET status = 'expired' WHERE id = $1",
                [sub.id]
            );
        });
        return { action: 'downgraded_to_free', effective: 'immediate' };
    }

    if (refundType === 'partial') {
        await Models.Subscription.updateStatus(sub.id, 'cancelled');
        return { action: 'cancel_at_period_end', effective: 'end_of_period' };
    }

    const err = new Error('未知退款类型'); err.code = 'INVALID_REFUND_TYPE'; throw err;
}

async function handlePlanChange({ userId, newPlan }) {
    const validPlans = ['pro', 'enterprise'];
    if (!validPlans.includes(newPlan)) {
        const err = new Error('无效的目标方案'); err.code = 'INVALID_PLAN'; throw err;
    }

    const user = await Models.User.findById(userId);
    if (!user) {
        const err = new Error('用户不存在'); err.code = 'USER_NOT_FOUND'; throw err;
    }

    if (user.plan === newPlan) {
        return { action: 'none', reason: 'already_on_plan' };
    }

    await db.query('SELECT * FROM upgrade_user_plan($1, $2)', [userId, newPlan]);

    return { action: 'plan_changed', from: user.plan, to: newPlan };
}

module.exports = {
    handleRefund,
    handlePlanChange
};
