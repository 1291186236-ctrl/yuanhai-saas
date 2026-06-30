const express = require('express');
const router = express.Router();
const lemonSqueezy = require('../services/lemonSqueezy');
const Models = require('../db/models');
const db = require('../db/database');
const { success, fail } = require('../utils/response');

router.post('/webhook/lemonsqueezy', express.raw({ type: 'application/json' }), async (req, res) => {
    const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    const signature = req.headers['x-signature'] || '';

    if (!lemonSqueezy.verifyWebhookSignature(rawBody, signature)) {
        console.warn('[Webhook] Invalid signature');
        return res.status(401).json({ ok: false, error: 'Invalid signature' });
    }

    let event;
    try {
        event = JSON.parse(rawBody);
    } catch (err) {
        return res.status(400).json({ ok: false, error: 'Invalid JSON' });
    }

    const eventName = event.meta?.event_name;
    const lsEventId = event.meta?.event_id || String(event.data?.id || '') + '_' + eventName;
    const customData = event.meta?.custom_data || {};
    let userId = customData.user_id;

    console.log(`[Webhook] Received: ${eventName} (lsEventId=${lsEventId}) for user ${userId}`);

    const alreadyProcessed = await isEventProcessed(lsEventId);
    if (alreadyProcessed) {
        console.log(`[Webhook] Duplicate event, skipping: ${lsEventId}`);
        return res.status(200).json({ ok: true, duplicate: true });
    }

    try {
        switch (eventName) {
            case 'subscription_created':
            case 'subscription_updated':
                await handleSubscriptionCreated(event, userId);
                break;

            case 'subscription_payment_success':
                await handleSubscriptionPaymentSuccess(event, userId);
                break;

            case 'subscription_cancelled':
                await handleSubscriptionCancelled(event, userId);
                break;

            case 'subscription_expired':
                await handleSubscriptionExpired(event, userId);
                break;

            case 'subscription_payment_failed':
                await handleSubscriptionPaymentFailed(event, userId);
                break;

            case 'order_created':
                await handleOrderCreated(event, userId);
                break;

            case 'subscription_payment_recovered':
                await handleSubscriptionPaymentRecovered(event, userId);
                break;

            default:
                console.log(`[Webhook] Unhandled event: ${eventName}`);
        }

        await markEventProcessed(lsEventId, eventName, event, null);
        return res.status(200).json({ ok: true });

    } catch (err) {
        console.error('[Webhook] Handler error:', err);
        await markEventProcessed(lsEventId, eventName, event, err.message);
        return res.status(500).json({ ok: false, error: 'Handler failed' });
    }
});

async function isEventProcessed(lsEventId) {
    if (!lsEventId) return false;
    const { rows } = await db.query(
        'SELECT id FROM webhook_events WHERE ls_event_id = $1 AND processed = TRUE',
        [lsEventId]
    );
    return rows.length > 0;
}

async function markEventProcessed(lsEventId, eventName, event, errorMessage) {
    try {
        await db.query(
            `INSERT INTO webhook_events (ls_event_id, event_name, payload, processed, error_message, processed_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (ls_event_id) DO UPDATE SET
                 processed = EXCLUDED.processed,
                 error_message = EXCLUDED.error_message,
                 processed_at = EXCLUDED.processed_at`,
            [lsEventId, eventName, JSON.stringify(event), !errorMessage, errorMessage, !errorMessage ? new Date() : null]
        );
    } catch (err) {
        console.error('[Webhook] Failed to log event:', err.message);
    }
}

async function resolveUserId(userId, attrs) {
    if (userId) return userId;
    const email = attrs.user_email;
    if (!email) return null;
    const user = await Models.User.findByEmail(email);
    return user?.id || null;
}

async function handleSubscriptionCreated(event, userId) {
    const attrs = event.data?.attributes || {};
    const variantId = String(attrs.variant_id || '');
    const planInfo = lemonSqueezy.resolvePlanByVariantId(variantId);

    if (!planInfo) {
        console.warn(`[Webhook] Unknown variant: ${variantId}`);
        return;
    }

    userId = await resolveUserId(userId, attrs);
    if (!userId) {
        console.warn(`[Webhook] Cannot resolve user for subscription_created`);
        return;
    }

    await db.transaction(async (client) => {
        await client.query('SELECT * FROM upgrade_user_plan($1, $2)', [userId, planInfo.plan]);

        await Models.Subscription.create({
            userId,
            lsSubscriptionId: String(event.data.id),
            lsCustomerId: String(attrs.customer_id || ''),
            lsProductId: String(attrs.product_id || ''),
            lsVariantId: variantId,
            plan: planInfo.plan,
            status: 'active',
            currentPeriodStart: attrs.renews_at ? new Date(attrs.renews_at) : new Date(),
            currentPeriodEnd: attrs.ends_at ? new Date(attrs.ends_at) : null
        });
    });

    console.log(`[Webhook] ✅ User ${userId} upgraded to ${planInfo.plan}`);
}

async function handleSubscriptionPaymentSuccess(event, userId) {
    const attrs = event.data?.attributes || {};
    userId = await resolveUserId(userId, attrs);
    if (!userId) return;

    const sub = await Models.Subscription.findByLsSubscriptionId(String(event.data.id));
    if (sub) {
        await Models.Subscription.renewPeriod(
            sub.id,
            attrs.renews_at ? new Date(attrs.renews_at) : new Date(),
            attrs.ends_at ? new Date(attrs.ends_at) : null
        );
    }

    const planInfo = lemonSqueezy.resolvePlanByVariantId(String(attrs.variant_id || ''));
    if (planInfo) {
        await db.query('SELECT * FROM upgrade_user_plan($1, $2)', [userId, planInfo.plan]);
    }

    console.log(`[Webhook] ✅ Payment success, renewed for user ${userId}`);
}

async function handleSubscriptionCancelled(event, userId) {
    const attrs = event.data?.attributes || {};
    userId = await resolveUserId(userId, attrs);

    const sub = await Models.Subscription.findByLsSubscriptionId(String(event.data.id));
    if (sub) {
        await Models.Subscription.cancelAtPeriodEnd(sub.id);
    }
    console.log(`[Webhook] Subscription cancelled for user ${userId}, will downgrade at period end`);
}

async function handleSubscriptionExpired(event, userId) {
    const attrs = event.data?.attributes || {};
    userId = await resolveUserId(userId, attrs);

    const sub = await Models.Subscription.findByLsSubscriptionId(String(event.data.id));
    if (sub) {
        await Models.Subscription.updateStatus(sub.id, 'expired');
    }
    if (userId) {
        await db.query("UPDATE users SET plan = 'free', quota_total = 10 WHERE id = $1", [userId]);
    }
    console.log(`[Webhook] Subscription expired, user ${userId} downgraded to free`);
}

async function handleSubscriptionPaymentFailed(event, userId) {
    const attrs = event.data?.attributes || {};
    userId = await resolveUserId(userId, attrs);

    const sub = await Models.Subscription.findByLsSubscriptionId(String(event.data.id));
    if (sub) {
        await Models.Subscription.updateStatus(sub.id, 'past_due');
    }
    console.log(`[Webhook] ⚠️ Payment failed for user ${userId}`);
}

async function handleSubscriptionPaymentRecovered(event, userId) {
    const attrs = event.data?.attributes || {};
    userId = await resolveUserId(userId, attrs);

    const sub = await Models.Subscription.findByLsSubscriptionId(String(event.data.id));
    if (sub) {
        await Models.Subscription.updateStatus(sub.id, 'active');
    }
    if (userId) {
        const planInfo = lemonSqueezy.resolvePlanByVariantId(String(attrs.variant_id || ''));
        if (planInfo) {
            await db.query('SELECT * FROM upgrade_user_plan($1, $2)', [userId, planInfo.plan]);
        }
    }
    console.log(`[Webhook] ✅ Payment recovered for user ${userId}`);
}

async function handleOrderCreated(event, userId) {
    const attrs = event.data?.attributes || {};
    userId = await resolveUserId(userId, attrs);
    if (!userId) return;

    const existing = await Models.Order.findByLsOrderId(String(event.data.id));
    if (existing) {
        console.log(`[Webhook] Order already recorded: ${event.data.id}`);
        return;
    }

    const firstItem = (attrs.first_order_item || [])[0] || {};

    await Models.Order.create({
        userId,
        lsOrderId: String(event.data.id),
        lsOrderItemId: String(firstItem.id || ''),
        orderNumber: attrs.order_number || '',
        productName: firstItem.product_name || '',
        variantName: firstItem.variant_name || '',
        amount: attrs.total || 0,
        currency: attrs.currency || 'USD',
        status: attrs.status === 'paid' ? 'paid' : 'pending',
        lsSubscriptionId: attrs.subscription_id ? String(attrs.subscription_id) : null
    });

    console.log(`[Webhook] 📦 Order recorded for user ${userId}: ${attrs.order_number}`);
}

module.exports = router;
