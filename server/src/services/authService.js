const { OAuth2Client } = require('google-auth-library');
const env = require('../config/env');
const Models = require('../db/models');
const { hashPassword, verifyPassword } = require('../utils/crypto');
const {
    signAccessToken, signRefreshToken,
    verifyRefreshToken, hashToken, generateRandomCode
} = require('../utils/jwt');

const googleClient = new OAuth2Client(env.google.clientId);

const REFRESH_TTL_DAYS = 7;

async function register({ email, password, name }) {
    email = String(email || '').toLowerCase().trim();
    if (!email || !password) {
        const err = new Error('邮箱和密码不能为空'); err.code = 'INVALID_INPUT'; throw err;
    }
    if (password.length < 8) {
        const err = new Error('密码至少8位'); err.code = 'WEAK_PASSWORD'; throw err;
    }

    const existing = await Models.User.findByEmail(email);
    if (existing) {
        const err = new Error('该邮箱已注册'); err.code = 'EMAIL_EXISTS'; err.expose = true; throw err;
    }

    const passwordHash = await hashPassword(password);
    const user = await Models.User.create({
        email,
        passwordHash,
        name: name || email.split('@')[0],
        authProvider: 'email'
    });

    return issueTokens(user, 'register');
}

async function login({ email, password }) {
    email = String(email || '').toLowerCase().trim();
    const user = await Models.User.findByEmail(email);
    if (!user || user.auth_provider === 'google') {
        const err = new Error('邮箱或密码错误'); err.code = 'INVALID_CREDENTIALS'; err.expose = true; throw err;
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
        const err = new Error('邮箱或密码错误'); err.code = 'INVALID_CREDENTIALS'; err.expose = true; throw err;
    }

    return issueTokens(user, 'login');
}

async function loginWithGoogle({ idToken }) {
    if (!idToken) {
        const err = new Error('缺少 Google ID Token'); err.code = 'INVALID_INPUT'; throw err;
    }

    const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: env.google.clientId
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email_verified) {
        const err = new Error('Google 账号邮箱未验证'); err.code = 'GOOGLE_EMAIL_UNVERIFIED'; throw err;
    }

    let user = await Models.User.findByGoogleId(payload.sub);
    if (!user) {
        const existing = await Models.User.findByEmail(payload.email);
        if (existing) {
            const err = new Error('该邮箱已用其他方式注册，请使用原方式登录'); err.code = 'EMAIL_CONFLICT'; err.expose = true; throw err;
        }
        user = await Models.User.create({
            email: payload.email,
            name: payload.name || payload.email.split('@')[0],
            avatarUrl: payload.picture,
            authProvider: 'google',
            googleId: payload.sub
        });
    }

    return issueTokens(user, 'google');
}

async function refresh(refreshToken) {
    const payload = verifyRefreshToken(refreshToken);
    if (!payload) {
        const err = new Error('Refresh token 无效或已过期'); err.code = 'INVALID_REFRESH'; err.expose = true; throw err;
    }

    const stored = await Models.RefreshToken.findByTokenHash(hashToken(refreshToken));
    if (!stored) {
        const err = new Error('Refresh token 已被吊销'); err.code = 'REFRESH_REVOKED'; err.expose = true; throw err;
    }

    await Models.RefreshToken.revokeById(stored.id);

    const user = await Models.User.findById(payload.sub);
    if (!user || user.status !== 'active') {
        const err = new Error('用户状态异常'); err.code = 'USER_INVALID'; throw err;
    }

    return issueTokens(user, 'refresh');
}

async function logout(refreshToken) {
    if (!refreshToken) return;
    const stored = await Models.RefreshToken.findByTokenHash(hashToken(refreshToken));
    if (stored) {
        await Models.RefreshToken.revokeById(stored.id);
    }
}

async function issueTokens(user, source) {
    const accessPayload = { sub: user.id, email: user.email, plan: user.plan };
    const accessToken = signAccessToken(accessPayload);
    const refreshToken = signRefreshToken({ sub: user.id });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TTL_DAYS);

    await Models.RefreshToken.create({
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        deviceInfo: source,
        expiresAt
    });

    return {
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresIn: env.jwt.accessExpires,
        user: {
            id: user.id,
            email: user.email,
            name: user.name,
            avatarUrl: user.avatar_url,
            plan: user.plan,
            authProvider: user.auth_provider,
            emailVerified: user.email_verified
        }
    };
}

module.exports = {
    register,
    login,
    loginWithGoogle,
    refresh,
    logout,
    generateRandomCode
};
