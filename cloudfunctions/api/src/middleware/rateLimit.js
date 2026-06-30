const rateLimit = require('express-rate-limit');

const isDev = process.env.NODE_ENV !== 'production';

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: isDev ? 1000 : 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        ok: false,
        error: '请求过于频繁，请15分钟后再试',
        code: 'RATE_LIMITED'
    }
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        ok: false,
        error: '请求过于频繁，请稍后再试',
        code: 'RATE_LIMITED'
    }
});

const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false
});

module.exports = { authLimiter, apiLimiter, webhookLimiter };
