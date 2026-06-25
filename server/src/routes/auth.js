const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const { authLimiter } = require('../middleware/rateLimit');
const { success, fail } = require('../utils/response');

router.post('/register', authLimiter, async (req, res, next) => {
    try {
        const { email, password, name } = req.body || {};
        const result = await authService.register({ email, password, name });
        success(res, result, '注册成功', 201);
    } catch (err) {
        if (err.expose) return fail(res, err.message, 400, err.code);
        next(err);
    }
});

router.post('/login', authLimiter, async (req, res, next) => {
    try {
        const { email, password } = req.body || {};
        const result = await authService.login({ email, password });
        success(res, result, '登录成功');
    } catch (err) {
        if (err.expose) return fail(res, err.message, 401, err.code);
        next(err);
    }
});

router.post('/google', authLimiter, async (req, res, next) => {
    try {
        const { idToken } = req.body || {};
        const result = await authService.loginWithGoogle({ idToken });
        success(res, result, 'Google 登录成功');
    } catch (err) {
        if (err.expose) return fail(res, err.message, 400, err.code);
        next(err);
    }
});

router.post('/refresh', async (req, res, next) => {
    try {
        const { refreshToken } = req.body || {};
        if (!refreshToken) return fail(res, '缺少 refreshToken', 400, 'NO_REFRESH');
        const result = await authService.refresh(refreshToken);
        success(res, result, '刷新成功');
    } catch (err) {
        if (err.expose) return fail(res, err.message, 401, err.code);
        next(err);
    }
});

router.post('/logout', async (req, res, next) => {
    try {
        const { refreshToken } = req.body || {};
        await authService.logout(refreshToken);
        success(res, null, '已登出');
    } catch (err) {
        next(err);
    }
});

module.exports = router;
