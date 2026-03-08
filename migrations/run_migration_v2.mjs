import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

// Use session mode (port 6543) for DDL compatibility
const connectionString = process.env.DATABASE_URL.replace(':5432/', ':6543/');

const step = process.argv[2];

/**
 * Split SQL into individual statements, respecting $$ blocks and DO blocks.
 */
function splitStatements(sql) {
    const statements = [];
    let current = '';
    let inDollarQuote = false;
    let dollarTag = '';
    const lines = sql.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();

        // Skip pure comments and empty lines when not accumulating
        if (!current.trim() && (trimmed.startsWith('--') || trimmed === '')) {
            continue;
        }

        current += line + '\n';

        // Track $$ or $tag$ dollar quoting
        const dollarMatches = line.match(/\$([a-zA-Z_]*)\$/g);
        if (dollarMatches) {
            for (const match of dollarMatches) {
                if (!inDollarQuote) {
                    inDollarQuote = true;
                    dollarTag = match;
                } else if (match === dollarTag) {
                    inDollarQuote = false;
                    dollarTag = '';
                }
            }
        }

        // Statement ends with ; and we're not inside a dollar-quoted block
        if (!inDollarQuote && trimmed.endsWith(';')) {
            const stmt = current.trim();
            if (stmt && !stmt.match(/^--/)) {
                statements.push(stmt);
            }
            current = '';
        }
    }

    if (current.trim()) {
        statements.push(current.trim());
    }

    return statements;
}

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

            console.log(`=== Running ${filename} (statement-by-statement) ===\n`);

            // For 04, skip the storage.buckets INSERT block
            if (step === '04') {
                sql = sql.replace(
                    /INSERT INTO storage\.buckets[\s\S]*?\);/m,
                    '-- [SKIPPED] storage.buckets INSERT'
                );
                console.log('⏭️  Skipped storage.buckets INSERT block\n');
            }

            const statements = splitStatements(sql);
            console.log(`Found ${statements.length} statements to execute.\n`);

            let successCount = 0;
            let skipCount = 0;
            let failCount = 0;

            for (let i = 0; i < statements.length; i++) {
                const stmt = statements[i];
                // Show a preview (first 80 chars)
                const preview = stmt.replace(/\s+/g, ' ').substring(0, 100);

                try {
                    await client.query(stmt);
                    successCount++;
                    console.log(`  [${i + 1}/${statements.length}] ✅ ${preview}...`);
                } catch (err) {
                    if (err.message.includes('graphql_public')) {
                        skipCount++;
                        console.log(`  [${i + 1}/${statements.length}] ⏭️  Skipped (graphql_public): ${preview}...`);
                    } else if (err.message.includes('already exists')) {
                        skipCount++;
                        console.log(`  [${i + 1}/${statements.length}] ⏭️  Already exists: ${preview}...`);
                    } else {
                        failCount++;
                        console.error(`  [${i + 1}/${statements.length}] ❌ FAILED: ${preview}...`);
                        console.error(`     Error: ${err.message}`);
                        if (err.detail) console.error(`     Detail: ${err.detail}`);
                        // Stop on real errors
                        console.error(`\n❌ Stopping execution due to error.`);
                        process.exit(1);
                    }
                }
            }

            console.log(`\n=== Summary for ${filename} ===`);
            console.log(`  ✅ Success: ${successCount}`);
            console.log(`  ⏭️  Skipped: ${skipCount}`);
            console.log(`  ❌ Failed: ${failCount}`);

            if (failCount === 0) {
                console.log(`\n✅ ${filename} completed successfully.`);
            }

        } else if (step === 'verify') {
            console.log('=== Verification ===\n');

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
                let currentSchema = '';
                for (const row of tablesResult.rows) {
                    if (row.table_schema !== currentSchema) {
                        currentSchema = row.table_schema;
                        console.log(`\n  [${currentSchema}]`);
                    }
                    console.log(`    ${row.table_name}`);
                }
                console.log(`\n  Total: ${tablesResult.rows.length} tables`);
            }

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

            console.log('\n--- Extensions ---');
            const extResult = await client.query(`
        SELECT extname, extversion FROM pg_extension 
        WHERE extname IN ('pg_trgm', 'uuid-ossp', 'vector')
        ORDER BY extname;
      `);
            for (const row of extResult.rows) {
                console.log(`  ✅ ${row.extname} v${row.extversion}`);
            }

            // Check storage bucket
            console.log('\n--- Storage Bucket ---');
            try {
                const bucketResult = await client.query(`
          SELECT id, name, public, file_size_limit, allowed_mime_types 
          FROM storage.buckets 
          WHERE id = 'property-documents';
        `);
                if (bucketResult.rows.length > 0) {
                    const b = bucketResult.rows[0];
                    console.log(`  ✅ Bucket "${b.name}" exists (public: ${b.public}, size limit: ${b.file_size_limit})`);
                } else {
                    console.log('  ⚠️  Bucket "property-documents" not found (may need API creation)');
                }
            } catch (err) {
                console.log(`  ⚠️  Could not check bucket: ${err.message}`);
            }

            console.log('\n✅ Verification complete.');

        } else {
            console.error('Usage: node run_migration_v2.mjs <extensions|01|02|03|04|verify>');
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
