require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./database');

async function runMigrations() {
    console.log('[Migrate] Starting migrations...');

    await db.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
            id          SERIAL PRIMARY KEY,
            filename    VARCHAR(255) UNIQUE NOT NULL,
            applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    const { rows: applied } = await db.query('SELECT filename FROM _migrations');
    const appliedSet = new Set(applied.map(r => r.filename));

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    for (const file of files) {
        if (appliedSet.has(file)) {
            console.log(`[Migrate] Skip (already applied): ${file}`);
            continue;
        }

        console.log(`[Migrate] Applying: ${file}`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

        try {
            await db.query(sql);
            await db.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
            console.log(`[Migrate] ✅ Applied: ${file}`);
        } catch (err) {
            console.error(`[Migrate] ❌ Failed: ${file}`, err.message);
            throw err;
        }
    }

    console.log('[Migrate] All migrations complete.');
}

if (require.main === module) {
    runMigrations()
        .then(() => process.exit(0))
        .catch(err => {
            console.error('[Migrate] Fatal:', err);
            process.exit(1);
        });
}

module.exports = runMigrations;
