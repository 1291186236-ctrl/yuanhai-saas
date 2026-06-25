require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function setupDatabase() {
    const adminPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    console.log('[Setup] Testing connection...');
    await adminPool.query('SELECT NOW()');
    console.log('[Setup] ✅ Database connected');

    console.log('[Setup] Running migrations...');
    const { rows: tables } = await adminPool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    const hasMigrations = tables.some(t => t.tablename === '_migrations');

    if (!hasMigrations) {
        await adminPool.query(`
            CREATE TABLE IF NOT EXISTS _migrations (
                id          SERIAL PRIMARY KEY,
                filename    VARCHAR(255) UNIQUE NOT NULL,
                applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
    }

    const { rows: applied } = await adminPool.query('SELECT filename FROM _migrations');
    const appliedSet = new Set(applied.map(r => r.filename));

    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

    for (const file of files) {
        if (appliedSet.has(file)) {
            console.log(`[Setup] Skip: ${file}`);
            continue;
        }
        console.log(`[Setup] Applying: ${file}`);
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        try {
            await adminPool.query(sql);
            await adminPool.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
            console.log(`[Setup] ✅ Applied: ${file}`);
        } catch (err) {
            console.error(`[Setup] ❌ Failed: ${file}`, err.message);
            throw err;
        }
    }

    console.log('[Setup] ✅ All migrations applied');
    await adminPool.end();
}

if (require.main === module) {
    setupDatabase()
        .then(() => { console.log('[Setup] Done!'); process.exit(0); })
        .catch(err => { console.error('[Setup] Fatal:', err); process.exit(1); });
}

module.exports = setupDatabase;
