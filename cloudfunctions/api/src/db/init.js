const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
});

async function init() {
    try {
        // 先测试连接
        const testResult = await pool.query('SELECT 1 as test');
        console.log('DB connected:', testResult.rows[0]);

        const sql = fs.readFileSync(
            path.join(__dirname, 'migrations', '001_initial_schema.sql'),
            'utf-8'
        );
        await pool.query(sql);
        console.log('Database initialized successfully');
    } catch (err) {
        console.error('Database init failed:', err.message);
        console.error('Stack:', err.stack);
    } finally {
        await pool.end();
    }
}

init();
