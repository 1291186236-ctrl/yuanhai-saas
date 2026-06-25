const crypto = require('crypto');
const env = require('../config/env');

/**
 * 易收米支付服务
 * API 文档参考: https://www.yishoumi.cn/
 * 支持微信支付 / 支付宝，个人免营业执照
 */

const YSM_API_BASE = 'https://api.yishoumi.cn';

// 订阅方案配置（金额单位：元）
const PLAN_CONFIG = {
    'pro_monthly':   { plan: 'pro',        cycle: 'monthly', amount: '9.90',  name: '专业版月付' },
    'pro_yearly':    { plan: 'pro',        cycle: 'yearly',  amount: '99.00',  name: '专业版年付' },
    'ent_monthly':   { plan: 'enterprise', cycle: 'monthly', amount: '299.00', name: '企业版月付' },
    'ent_yearly':    { plan: 'enterprise', cycle: 'yearly',  amount: '2990.00', name: '企业版年付' }
};

/**
 * 生成签名
 * 规则：参数按字母排序 → 拼接为 key=value&key=value → 追加商户密钥 → MD5 大写
 */
function generateSign(params, merchantKey) {
    const sortedKeys = Object.keys(params)
        .filter(k => params[k] !== '' && params[k] !== undefined && params[k] !== null && k !== 'sign' && k !== 'sign_type')
        .sort();

    const signStr = sortedKeys.map(k => `${k}=${params[k]}`).join('&') + merchantKey;
    return crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toUpperCase();
}

/**
 * 验证回调签名
 */
function verifyCallbackSign(params, merchantKey) {
    if (!params.sign) return false;
    const expectedSign = generateSign(params, merchantKey);
    return expectedSign === params.sign;
}

/**
 * 创建支付订单
 * @param {Object} opts
 * @param {string} opts.planKey - 方案 key (pro_monthly / pro_yearly / ent_monthly / ent_yearly)
 * @param {string} opts.userId - 用户 ID
 * @param {string} opts.userEmail - 用户邮箱
 * @param {string} opts.payType - 支付方式 (alipay / wxpay)
 * @returns {Promise<Object>} { tradeNo, outTradeNo, payUrl }
 */
async function createOrder({ planKey, userId, payType }) {
    const planInfo = PLAN_CONFIG[planKey];
    if (!planInfo) {
        const err = new Error('无效的订阅方案');
        err.code = 'INVALID_PLAN';
        throw err;
    }

    if (!env.yishoumi.pid || !env.yishoumi.merchantKey) {
        const err = new Error('易收米支付未配置');
        err.code = 'YSM_NOT_CONFIGURED';
        throw err;
    }

    const outTradeNo = `YSM${Date.now()}${Math.floor(Math.random() * 1000)}`;

    const params = {
        pid: env.yishoumi.pid,
        type: payType,
        out_trade_no: outTradeNo,
        notify_url: env.yishoumi.notifyUrl,
        return_url: env.web.origin + '/account?status=success',
        name: planInfo.name,
        money: planInfo.amount,
        sitename: '愿海商品助手'
    };

    params.sign = generateSign(params, env.yishoumi.merchantKey);
    params.sign_type = 'MD5';

    // 发起请求
    const axios = require('axios');
    const resp = await axios.post(`${YSM_API_BASE}/submit.php`, new URLSearchParams(params).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
    });

    const data = resp.data;
    if (data.code !== 1) {
        const err = new Error(data.msg || '创建支付订单失败');
        err.code = 'YSM_ORDER_FAILED';
        err.detail = data;
        throw err;
    }

    return {
        tradeNo: data.trade_no,
        outTradeNo: outTradeNo,
        payUrl: data.code_url,
        planKey,
        planInfo
    };
}

/**
 * 查询订单状态
 */
async function queryOrder(outTradeNo) {
    if (!env.yishoumi.pid || !env.yishoumi.merchantKey) {
        const err = new Error('易收米支付未配置');
        err.code = 'YSM_NOT_CONFIGURED';
        throw err;
    }

    const params = {
        pid: env.yishoumi.pid,
        out_trade_no: outTradeNo
    };
    params.sign = generateSign(params, env.yishoumi.merchantKey);
    params.sign_type = 'MD5';

    const axios = require('axios');
    const resp = await axios.post(`${YSM_API_BASE}/api.php?act=order`, new URLSearchParams(params).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
    });

    return resp.data;
}

/**
 * 处理支付回调
 * 回调参数: pid, trade_no, out_trade_no, type, name, money, trade_status, sign, sign_type
 */
function parseCallback(queryParams) {
    const params = {
        pid: queryParams.pid || '',
        trade_no: queryParams.trade_no || '',
        out_trade_no: queryParams.out_trade_no || '',
        type: queryParams.type || '',
        name: queryParams.name || '',
        money: queryParams.money || '',
        trade_status: queryParams.trade_status || '',
        sign: queryParams.sign || '',
        sign_type: queryParams.sign_type || ''
    };

    return params;
}

module.exports = {
    createOrder,
    queryOrder,
    generateSign,
    verifyCallbackSign,
    parseCallback,
    PLAN_CONFIG
};
