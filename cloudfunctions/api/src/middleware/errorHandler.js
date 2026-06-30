const { fail } = require('../utils/response');

function notFound(req, res) {
    return fail(res, `路由不存在: ${req.method} ${req.path}`, 404, 'NOT_FOUND');
}

function errorHandler(err, req, res, next) {
    console.error('[Error]', err);

    if (err.code === 'LIMIT_FILE_SIZE') {
        return fail(res, '文件过大', 413, 'FILE_TOO_LARGE');
    }

    if (err.type === 'entity.parse.failed') {
        return fail(res, '请求体格式错误', 400, 'INVALID_JSON');
    }

    if (err.code === '23505') {
        return fail(res, '数据已存在（唯一约束冲突）', 409, 'DUPLICATE');
    }

    if (err.code === '23503') {
        return fail(res, '关联数据不存在', 400, 'FOREIGN_KEY_VIOLATION');
    }

    if (err.code === '42P01') {
        console.error('[Error] Table not found:', err.message, err.detail);
        return fail(res, '数据库表不存在: ' + err.message, 500, 'TABLE_NOT_FOUND');
    }

    const status = err.status || 500;
    const message = err.expose
        ? err.message
        : (status >= 500 ? '服务器内部错误' : err.message);

    return fail(res, message, status, err.code || 'INTERNAL_ERROR');
}

module.exports = { notFound, errorHandler };
