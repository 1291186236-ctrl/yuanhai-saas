const { verifyAccessToken } = require('../utils/jwt');
const { fail } = require('../utils/response');
const Models = require('../db/models');

async function auth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
        return fail(res, '未登录', 401, 'NO_TOKEN');
    }

    const payload = verifyAccessToken(token);
    if (!payload) {
        return fail(res, '登录已过期，请重新登录', 401, 'TOKEN_EXPIRED');
    }

    const user = await Models.User.findById(payload.sub);
    if (!user) {
        return fail(res, '用户不存在', 401, 'USER_NOT_FOUND');
    }
    if (user.status !== 'active') {
        return fail(res, '账号已被禁用', 403, 'USER_SUSPENDED');
    }

    req.user = user;
    req.tokenPayload = payload;
    next();
}

function authOptional(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (token) {
        const payload = verifyAccessToken(token);
        if (payload) {
            req.tokenPayload = payload;
        }
    }
    next();
}

module.exports = { auth, authOptional };
