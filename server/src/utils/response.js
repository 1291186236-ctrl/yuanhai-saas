function success(res, data = null, message = 'ok', status = 200) {
    return res.status(status).json({
        ok: true,
        message,
        data
    });
}

function fail(res, message = 'error', status = 400, code = null, extra = {}) {
    return res.status(status).json({
        ok: false,
        error: message,
        code,
        ...extra
    });
}

function failWithCode(res, { status = 400, message, code, extra = {} }) {
    return fail(res, message, status, code, extra);
}

module.exports = { success, fail, failWithCode };
