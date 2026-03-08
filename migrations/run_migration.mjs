import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Use session mode (port 6543) for DDL compatibility
const connectionString = process.env.DATABASE_URL.replace(':5432/', ':6543/');

const step = process.argv[2]; // 'extensions', '01', '02', '03', '04', 'verify'

async function run() {
    const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

    try {
        console.log(`Connecting to database (session mode)...`);
        await client.connect();
        console.log(`Connected successfully.\n`);

        if (step === 'extensions') {
            console.log('=== Step 1: Enabling Extensions ===');

            for (const ext of ['pg_trgm', '"uuid-ossp"', 'vector']) {
                try {
                    await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext};`);
                    console.log(`✅ Extension ${ext} enabled`);
                } catch (err) {
                    console.error(`❌ Failed to enable ${ext}: ${err.message}`);
                    process.exit(1);
                }
            }
            console.log('\n✅ All extensions enabled successfully.');

        } else if (['01', '02', '03', '04'].includes(step)) {
            const fileMap = {
                '01': '01_shared.sql',
                '02': '02_warehouse.sql',
                '03': '03_pm_and_connector.sql',
                '04': '04_storage_and_jobs.sql',
            };

            const filename = fileMap[step];
            const filePath = path.join(__dirname, filename);
            let sql = fs.readFileSync(filePath, 'utf-8');

            console.log(`=== Running ${filename} ===\n`);

            // For 04_storage_and_jobs.sql, skip the storage.buckets INSERT block
            if (step === '04') {
                // Remove lines 9-25 (the INSERT INTO storage.buckets block)
                sql = sql.replace(
                    /INSERT INTO storage\.buckets[\s\S]*?\);/m,
                    '-- [SKIPPED] storage.buckets INSERT — will create via Supabase API'
                );
                console.log('⏭️  Skipped storage.buckets INSERT block (will create via API)\n');
            }

            try {
                await client.query(sql);
                console.log(`\n✅ ${filename} executed successfully.`);
            } catch (err) {
                // Check if it's a graphql_public error
                if (err.message.includes('graphql_public')) {
                    console.log(`⚠️  graphql_public error encountered (expected, skipping): ${err.message}`);
                } else {
                    console.error(`\n❌ ${filename} FAILED:`);
                    console.error(`   Error: ${err.message}`);
                    if (err.detail) console.error(`   Detail: ${err.detail}`);
                    if (err.hint) console.error(`   Hint: ${err.hint}`);
                    if (err.position) console.error(`   Position: ${err.position}`);
                    process.exit(1);
                }
            }

        } else if (step === 'verify') {
            console.log('=== Verification ===\n');

            // Check tables
            console.log('--- Tables in new schemas ---');
            const tablesResult = await client.query(`
        SELECT table_schema, table_name 
        FROM information_schema.tables
        WHERE table_schema IN ('shared','warehouse','pm','connector')
        ORDER BY table_schema, table_name;
      `);

            if (tablesResult.rows.length === 0) {
                console.log('❌ No tables found in the new schemas!');
            } else {
                for (const row of tablesResult.rows) {
                    console.log(`  ${row.table_schema}.${row.table_name}`);
                }
                console.log(`\nTotal: ${tablesResult.rows.length} tables`);
            }

            // Check functions
            console.log('\n--- Functions ---');
            const funcsResult = await client.query(`
        SELECT routine_schema, routine_name 
        FROM information_schema.routines
        WHERE routine_schema IN ('connector', 'shared', 'warehouse')
        ORDER BY routine_schema, routine_name;
      `);
            for (const row of funcsResult.rows) {
                console.log(`  ${row.routine_schema}.${row.routine_name}()`);
            }

            // Check extensions
            console.log('\n--- Extensions ---');
            const extResult = await client.query(`
        SELECT extname, extversion FROM pg_extension 
        WHERE extname IN ('pg_trgm', 'uuid-ossp', 'vector')
        ORDER BY extname;
      `);
            for (const row of extResult.rows) {
                console.log(`  ${row.extname} v${row.extversion}`);
            }

            console.log('\n✅ Verification complete.');

        } else {
            console.error('Usage: node run_migration.mjs <extensions|01|02|03|04|verify>');
            process.exit(1);
        }

    } finally {
        await client.end();
    }
}

run().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
