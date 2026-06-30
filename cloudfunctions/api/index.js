const serverless = require('serverless-http');
const app = require('./src/index');
const handler = serverless(app);

exports.main = async (event, context) => {
    // CloudBase HTTP 网关路径映射：/api/* -> 云函数
    // 但云函数收到的路径是 /*（不带 /api 前缀）
    // 需要把路径加回 /api 前缀，让 Express 路由匹配
    const originalPath = event.path || '/';
    const pathWithApi = originalPath.startsWith('/api') ? originalPath : '/api' + originalPath;

    const apiGatewayEvent = {
        httpMethod: event.httpMethod || 'GET',
        path: pathWithApi,
        resource: pathWithApi,
        headers: event.headers || {},
        queryStringParameters: event.queryStringParameters || event.queryString || {},
        pathParameters: event.pathParameters || null,
        stageVariables: null,
        requestContext: {
            httpMethod: event.httpMethod || 'GET',
            path: pathWithApi,
            stage: 'prod',
            identity: {},
            sourceIp: (event.headers && (event.headers['x-forwarded-for'] || event.headers['X-Forwarded-For'])) || ''
        },
        body: event.body || '',
        isBase64Encoded: event.isBase64Encoded || false
    };

    const result = await handler(apiGatewayEvent, context);
    return result;
};
