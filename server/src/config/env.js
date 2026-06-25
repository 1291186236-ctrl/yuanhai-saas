require('dotenv').config();

const env = {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    isProd: process.env.NODE_ENV === 'production',

    databaseUrl: process.env.DATABASE_URL,

    jwt: {
        secret: process.env.JWT_SECRET || 'dev-secret-change-me',
        accessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
        refreshExpires: process.env.JWT_REFRESH_EXPIRES || '7d'
    },

    google: {
        clientId: process.env.GOOGLE_CLIENT_ID
    },

    lemonSqueezy: {
        apiKey: process.env.LS_API_KEY,
        storeId: process.env.LS_STORE_ID,
        webhookSecret: process.env.LS_WEBHOOK_SECRET,
        variants: {
            pro_monthly: process.env.LS_PRODUCT_PRO_MONTHLY_VARIANT_ID,
            pro_yearly: process.env.LS_PRODUCT_PRO_YEARLY_VARIANT_ID,
            ent_monthly: process.env.LS_PRODUCT_ENT_MONTHLY_VARIANT_ID,
            ent_yearly: process.env.LS_PRODUCT_ENT_YEARLY_VARIANT_ID
        }
    },

    yishoumi: {
        pid: process.env.YSM_PID,
        merchantKey: process.env.YSM_MERCHANT_KEY,
        notifyUrl: process.env.YSM_NOTIFY_URL || ''
    },

    mail: {
        apiKey: process.env.RESEND_API_KEY,
        from: process.env.MAIL_FROM || 'noreply@localhost'
    },

    web: {
        origin: process.env.WEB_ORIGIN || 'http://localhost:5173',
        extensionId: process.env.EXTENSION_ID
    }
};

module.exports = env;
