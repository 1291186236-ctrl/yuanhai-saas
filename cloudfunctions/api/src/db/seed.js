require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const SEED_FILE = path.join(__dirname, 'migrations', '002_seed_data.sql');

async function runSeed() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    console.log('[Seed] Connecting database...');
    await pool.query('SELECT NOW()');

    console.log('[Seed] Running seed data...');
    const sql = fs.readFileSync(SEED_FILE, 'utf8');
    await pool.query(sql);
    console.log('[Seed] ✅ Seed data applied');

    const { rows: plans } = await pool.query(
        'SELECT plan_code, plan_name, price_monthly, price_yearly FROM plan_config ORDER BY sort_order'
    );
    console.log('[Seed] Current plan_config:');
    plans.forEach(p => {
        console.log(`  - ${p.plan_code} (${p.plan_name}): $${p.price_monthly}/月, $${p.price_yearly}/年`);
    });

    await pool.end();
}

runSeed()
    .then(() => { console.log('[Seed] Done!'); process.exit(0); })
    .catch(err => { console.error('[Seed] Fatal:', err); process.exit(1); });
