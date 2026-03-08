import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectionString = process.env.DATABASE_URL.replace(':5432/', ':6543/');

async function run() {
    const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
    try {
        await client.connect();
        console.log('Connected.\n');

        // Strategy: Create the function in the PUBLIC schema first (no graphql trigger issue),
        // then ALTER FUNCTION SET SCHEMA to move it to connector.
        console.log('Step 1: Creating resolve() in PUBLIC schema...');
        try {
            await client.query(`
        CREATE OR REPLACE FUNCTION public.connector_resolve(
          p_org_id UUID,
          p_entity_type TEXT,
          p_fields JSONB,
          p_confidence_threshold NUMERIC DEFAULT 90.0
        )
        RETURNS JSONB
        LANGUAGE plpgsql SECURITY DEFINER AS $fn$
        DECLARE
          v_result JSONB;
          v_candidates JSONB := '[]'::JSONB;
        BEGIN
          IF p_entity_type = 'property' THEN
            SELECT jsonb_agg(jsonb_build_object(
              'pm_entity_id', p.id, 'name', p.name,
              'address', concat(p.address_street, ' ', p.address_number, ', ', p.address_zip, ' ', p.address_city),
              'confidence',
              CASE 
                WHEN lower(p.address_street) = lower(p_fields->>'address_street') 
                 AND p.address_zip = (p_fields->>'address_zip') THEN 95.0
                WHEN lower(p.address_street) LIKE lower('%' || (p_fields->>'address_street') || '%') THEN 70.0
                ELSE 40.0
              END
            )) INTO v_candidates FROM pm.properties p WHERE p.org_id = p_org_id;
          ELSIF p_entity_type = 'unit' THEN
            SELECT jsonb_agg(jsonb_build_object(
              'pm_entity_id', u.id, 'unit_ref', u.unit_ref, 'property_id', u.property_id,
              'confidence',
              CASE
                WHEN lower(u.unit_ref) = lower(p_fields->>'unit_ref') THEN 95.0
                WHEN lower(u.unit_ref) LIKE lower('%' || (p_fields->>'unit_ref') || '%') THEN 70.0
                ELSE 40.0
              END
            )) INTO v_candidates FROM pm.units u WHERE u.org_id = p_org_id
              AND (p_fields->>'property_id' IS NULL OR u.property_id = (p_fields->>'property_id')::UUID);
          ELSIF p_entity_type = 'tenant' THEN
            SELECT jsonb_agg(jsonb_build_object(
              'pm_entity_id', t.id, 'name', concat(t.first_name, ' ', t.last_name),
              'confidence',
              CASE
                WHEN lower(concat(t.first_name, ' ', t.last_name)) = lower(p_fields->>'tenant_name') THEN 95.0
                WHEN lower(t.last_name) = lower(p_fields->>'last_name') THEN 75.0
                ELSE 40.0
              END
            )) INTO v_candidates FROM pm.tenants t WHERE t.org_id = p_org_id;
          END IF;

          SELECT CASE
            WHEN v_candidates IS NULL OR jsonb_array_length(v_candidates) = 0 THEN
              jsonb_build_object('match_type', 'new', 'candidates', '[]'::JSONB)
            WHEN (SELECT MAX((c->>'confidence')::NUMERIC) FROM jsonb_array_elements(v_candidates) c) >= p_confidence_threshold THEN
              jsonb_build_object('match_type', 'existing', 'candidates', v_candidates,
                'best_match', (SELECT c FROM jsonb_array_elements(v_candidates) c ORDER BY (c->>'confidence')::NUMERIC DESC LIMIT 1))
            WHEN (SELECT COUNT(*) FROM jsonb_array_elements(v_candidates) c WHERE (c->>'confidence')::NUMERIC >= 60) > 1 THEN
              jsonb_build_object('match_type', 'ambiguous', 'candidates', v_candidates)
            ELSE
              jsonb_build_object('match_type', 'new', 'candidates', v_candidates)
          END INTO v_result;

          RETURN v_result;
        END;
        $fn$;
      `);
            console.log('✅ public.connector_resolve() created!');
        } catch (err) {
            console.error('❌ Failed to create in public schema: ' + err.message);
            process.exit(1);
        }

        // Step 2: Move it to connector schema
        console.log('\nStep 2: Moving to connector schema...');
        try {
            await client.query(`
        ALTER FUNCTION public.connector_resolve(UUID, TEXT, JSONB, NUMERIC) SET SCHEMA connector;
      `);
            console.log('✅ Moved to connector schema!');
        } catch (err) {
            console.log('❌ Move failed: ' + err.message);
            // If move fails, try renaming in connector schema
            console.log('\nStep 2b: Trying ALTER FUNCTION RENAME...');
            try {
                await client.query(`ALTER FUNCTION connector.connector_resolve(UUID, TEXT, JSONB, NUMERIC) RENAME TO resolve;`);
                console.log('✅ Renamed to connector.resolve()!');
            } catch (err2) {
                console.log('❌ Rename also failed: ' + err2.message);
            }
        }

        // Step 3: Rename it (if move succeeded, the name is still connector_resolve)
        console.log('\nStep 3: Renaming connector_resolve -> resolve...');
        try {
            await client.query(`ALTER FUNCTION connector.connector_resolve(UUID, TEXT, JSONB, NUMERIC) RENAME TO resolve;`);
            console.log('✅ Renamed to connector.resolve()!');
        } catch (err) {
            // Maybe it was already renamed or moved
            console.log('Note: ' + err.message);
        }

        // Verify
        console.log('\n--- Verification ---');
        const result = await client.query(
            "SELECT routine_schema, routine_name FROM information_schema.routines WHERE routine_schema IN ('connector', 'shared', 'warehouse') ORDER BY 1,2"
        );
        for (const row of result.rows) {
            console.log(`  ✅ ${row.routine_schema}.${row.routine_name}()`);
        }

        // Cleanup: drop public.connector_resolve if it still exists there
        try {
            await client.query('DROP FUNCTION IF EXISTS public.connector_resolve(UUID, TEXT, JSONB, NUMERIC);');
        } catch (err) { }

    } finally {
        await client.end();
    }
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
