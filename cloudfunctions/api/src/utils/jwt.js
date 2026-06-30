const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../config/env');

function signAccessToken(payload) {
    return jwt.sign(payload, env.jwt.secret, {
        expiresIn: env.jwt.accessExpires,
        issuer: 'yuanhai-saas',
        audience: 'yuanhai-client'
    });
}

function signRefreshToken(payload) {
    return jwt.sign(payload, env.jwt.secret + '_refresh', {
        expiresIn: env.jwt.refreshExpires,
        issuer: 'yuanhai-saas',
        audience: 'yuanhai-client'
    });
}

function verifyAccessToken(token) {
    try {
        return jwt.verify(token, env.jwt.secret, {
            issuer: 'yuanhai-saas',
            audience: 'yuanhai-client'
        });
    } catch (err) {
        return null;
    }
}

function verifyRefreshToken(token) {
    try {
        return jwt.verify(token, env.jwt.secret + '_refresh', {
            issuer: 'yuanhai-saas',
            audience: 'yuanhai-client'
        });
    } catch (err) {
        return null;
    }
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function generateRandomCode(length = 6) {
    const digits = '0123456789';
    let code = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
        code += digits[bytes[i] % 10];
    }
    return code;
}

module.exports = {
    signAccessToken,
    signRefreshToken,
    verifyAccessToken,
    verifyRefreshToken,
    hashToken,
    generateRandomCode
};
