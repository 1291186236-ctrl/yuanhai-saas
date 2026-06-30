const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
    console.error('[DB] Unexpected pool error:', err.message);
});

async function query(text, params) {
    const start = Date.now();
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 500) {
        console.warn(`[DB] Slow query (${duration}ms):`, text.slice(0, 100));
    }
    return result;
}

async function getClient() {
    return pool.connect();
}

async function transaction(callback) {
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// 自动初始化数据库表
let initialized = false;
async function initDatabase() {
    if (initialized) return;
    try {
        // 检查 users 表是否存在
        const checkResult = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'users'
            );
        `);
        if (checkResult.rows[0].exists) {
            initialized = true;
            return;
        }

        console.log('[DB] Initializing database schema...');
        const sql = fs.readFileSync(
            path.join(__dirname, 'migrations', '001_initial_schema.sql'),
            'utf-8'
        );
        await pool.query(sql);
        initialized = true;
        console.log('[DB] Database initialized successfully');
    } catch (err) {
        console.error('[DB] Init failed:', err.message);
    }
}

// 启动时尝试初始化
initDatabase();

module.exports = { query, getClient, transaction, pool, initDatabase };
