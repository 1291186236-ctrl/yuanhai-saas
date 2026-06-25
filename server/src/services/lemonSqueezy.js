const axios = require('axios');
const env = require('../config/env');

const LS_API = 'https://api.lemonsqueezy.com/v1';

const lsClient = axios.create({
    baseURL: LS_API,
    headers: {
        'Accept': 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        'Authorization': `Bearer ${env.lemonSqueezy.apiKey}`
    },
    timeout: 15000
});

const PLAN_VARIANT_MAP = {
    'pro_monthly':        { plan: 'pro',        cycle: 'monthly' },
    'pro_yearly':         { plan: 'pro',        cycle: 'yearly' },
    'ent_monthly':        { plan: 'enterprise', cycle: 'monthly' },
    'ent_yearly':         { plan: 'enterprise', cycle: 'yearly' }
};

function resolvePlanByVariantId(variantId) {
    for (const [key, info] of Object.entries(PLAN_VARIANT_MAP)) {
        if (env.lemonSqueezy.variants[key] === variantId) {
            return info;
        }
    }
    return null;
}

async function createCheckout({ variantId, userId, userEmail, redirectUrl }) {
    if (!variantId) {
        const err = new Error('缺少 variantId'); err.code = 'INVALID_INPUT'; throw err;
    }

    const payload = {
        data: {
            type: 'checkouts',
            attributes: {
                'product_options': {
                    'redirect_url': redirectUrl || (env.web.origin + '/account?status=success'),
                    'receipt_thank_you_note': '感谢升级！请返回插件查看会员状态。'
                },
                'checkout_options': {
                    'embed': false,
                    'dark': false
                },
                'checkout_data': {
                    'email': userEmail,
                    'custom': {
                        'user_id': userId
                    }
                },
                'custom_price': null
            },
            relationships: {
                store: {
                    data: { type: 'stores', id: env.lemonSqueezy.storeId }
                },
                variant: {
                    data: { type: 'variants', id: variantId }
                }
            }
        }
    };

    const { data } = await lsClient.post('/checkouts', payload);
    return {
        checkoutUrl: data.data.attributes.url,
        checkoutId: data.data.id
    };
}

async function createCustomerPortalSession({ customerId, userEmail }) {
    let targetCustomerId = customerId;

    if (!targetCustomerId) {
        const { data: customers } = await lsClient.get('/customers', {
            params: { 'filter[email]': userEmail }
        });
        if (customers.data && customers.data.length > 0) {
            targetCustomerId = customers.data[0].id;
        }
    }

    if (!targetCustomerId) {
        const err = new Error('未找到 Lemon Squeezy 客户记录'); err.code = 'NO_LS_CUSTOMER'; throw err;
    }

    const { data } = await lsClient.post(`/customers/${targetCustomerId}/portal`, {});
    return { portalUrl: data.data.attributes.url };
}

async function getSubscription(lsSubscriptionId) {
    const { data } = await lsClient.get(`/subscriptions/${lsSubscriptionId}`);
    return data.data;
}

async function cancelSubscription(lsSubscriptionId) {
    await lsClient.delete(`/subscriptions/${lsSubscriptionId}`);
}

function verifyWebhookSignature(rawBody, signature) {
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', env.lemonSqueezy.webhookSecret);
    hmac.update(rawBody);
    const digest = hmac.digest('hex');
    return digest === signature;
}

module.exports = {
    createCheckout,
    createCustomerPortalSession,
    getSubscription,
    cancelSubscription,
    verifyWebhookSignature,
    resolvePlanByVariantId,
    PLAN_VARIANT_MAP
};
