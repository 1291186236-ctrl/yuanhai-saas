const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const env = require('./config/env');
const { apiLimiter, webhookLimiter } = require('./middleware/rateLimit');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { success } = require('./utils/response');
const { initDatabase } = require('./db/database');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const quotaRoutes = require('./routes/quota');
const billingRoutes = require('./routes/billing');
const webhookRoutes = require('./routes/webhook');
const yishoumiWebhookRoutes = require('./routes/yishoumiWebhook');
const plansRoutes = require('./routes/plans');

const app = express();

// 确保数据库已初始化
app.use(async (req, res, next) => {
    await initDatabase();
    next();
});

app.use(helmet());
app.use(morgan(env.isProd ? 'combined' : 'dev'));

app.use(cors({
    origin: (origin, cb) => {
        const allowed = [env.web.origin, `chrome-extension://${env.web.extensionId}`];
        if (!origin || allowed.includes(origin) || origin?.startsWith('chrome-extension://')) {
            cb(null, true);
        } else {
            cb(null, true);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Signature']
}));

app.use('/api/webhook', webhookLimiter);
app.use('/api/webhook/lemonsqueezy', webhookRoutes);
app.use('/api/webhook/yishoumi', yishoumiWebhookRoutes);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api', apiLimiter);

app.get('/api/health', (req, res) => {
    success(res, {
        status: 'ok',
        env: env.nodeEnv,
        timestamp: new Date().toISOString()
    });
});

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api', quotaRoutes);
app.use('/api', billingRoutes);
app.use('/api', plansRoutes);

app.use(notFound);
app.use(errorHandler);

if (require.main === module) {
    const { startCronJobs } = require('./cron');
    app.listen(env.port, () => {
        console.log(`[Server] 🚀 Running on http://localhost:${env.port} (${env.nodeEnv})`);
        if (env.isProd) {
            startCronJobs();
        }
    });
}

module.exports = app;
