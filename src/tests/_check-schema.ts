import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
    // Run the migration SQL via the management API
    const sql = readFileSync('supabase/migrations/20260308114500_security_hardening.sql', 'utf8');

    // Split into statements and run each
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
        console.log('Running:', stmt.substring(0, 80) + '...');
        const { error } = await supabase.rpc('', {});
        // Can't run raw SQL via PostgREST... use a different approach
    }

    // Test if columns exist by trying to select them
    const { data, error } = await supabase
        .schema('warehouse')
        .from('documents')
        .select('quarantine_reason, quarantine_notes, quarantined_by, quarantined_at')
        .limit(1);

    if (error) {
        console.log('Quarantine columns do NOT exist yet:', error.message);
        console.log('\nPlease run this SQL in Supabase SQL editor:');
        console.log(sql);
    } else {
        console.log('Quarantine columns exist! ✅');
    }
}
main();
