import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectionString = process.env.DATABASE_URL.replace(':5432/', ':6543/');

// Use a DO block with EXECUTE to create the function.
// The event trigger fires on ddl_command_end, but the DO block itself
// is just a single DDL event. The CREATE FUNCTION inside EXECUTE
// runs as a nested statement. If the event trigger error is caught,
// the function may still have been created.
const sql = `
DO $do$
BEGIN
  -- First, try a dummy ALTER to trigger the graphql event before our real CREATE
  BEGIN
    EXECUTE 'ALTER FUNCTION connector.apply OWNER TO postgres';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Dummy alter caught: %', SQLERRM;
  END;
  
  -- Now create the resolve function
  CREATE OR REPLACE FUNCTION connector.resolve(
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
        'pm_entity_id', p.id,
        'name', p.name,
        'address', concat(p.address_street, ' ', p.address_number, ', ', p.address_zip, ' ', p.address_city),
        'confidence',
        CASE 
          WHEN lower(p.address_street) = lower(p_fields->>'address_street') 
           AND p.address_zip = (p_fields->>'address_zip') THEN 95.0
          WHEN lower(p.address_street) LIKE lower('%' || (p_fields->>'address_street') || '%') THEN 70.0
          ELSE 40.0
        END
      ))
      INTO v_candidates
      FROM pm.properties p WHERE p.org_id = p_org_id;
    ELSIF p_entity_type = 'unit' THEN
      SELECT jsonb_agg(jsonb_build_object(
        'pm_entity_id', u.id, 'unit_ref', u.unit_ref, 'property_id', u.property_id,
        'confidence',
        CASE
          WHEN lower(u.unit_ref) = lower(p_fields->>'unit_ref') THEN 95.0
          WHEN lower(u.unit_ref) LIKE lower('%' || (p_fields->>'unit_ref') || '%') THEN 70.0
          ELSE 40.0
        END
      ))
      INTO v_candidates
      FROM pm.units u WHERE u.org_id = p_org_id
        AND (p_fields->>'property_id' IS NULL OR u.property_id = (p_fields->>'property_id')::UUID);
    ELSIF p_entity_type = 'tenant' THEN
      SELECT jsonb_agg(jsonb_build_object(
        'pm_entity_id', t.id,
        'name', concat(t.first_name, ' ', t.last_name),
        'confidence',
        CASE
          WHEN lower(concat(t.first_name, ' ', t.last_name)) = lower(p_fields->>'tenant_name') THEN 95.0
          WHEN lower(t.last_name) = lower(p_fields->>'last_name') THEN 75.0
          ELSE 40.0
        END
      ))
      INTO v_candidates
      FROM pm.tenants t WHERE t.org_id = p_org_id;
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
END;
$do$;
`;

async function run() {
    const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
    try {
        await client.connect();
        console.log('Connected.\n');

        // Attempt 1: Direct CREATE (maybe the graphql cache is warm now)
        console.log('Attempt 1: Direct CREATE OR REPLACE...');
        try {
            const directSql = fs.readFileSync(path.join(__dirname, '03_pm_and_connector.sql'), 'utf-8');
            const resolveMatch = directSql.match(/(CREATE OR REPLACE FUNCTION connector\.resolve\([\s\S]*?\$\$;)/);
            if (resolveMatch) {
                await client.query(resolveMatch[1]);
                console.log('✅ Attempt 1 succeeded!');
            }
        } catch (err) {
            console.log('❌ Attempt 1 failed: ' + err.message);

            // Attempt 2: Check if the function was created despite the error
            console.log('\nChecking if function exists despite error...');
            const check = await client.query(
                "SELECT routine_name FROM information_schema.routines WHERE routine_schema = 'connector' AND routine_name = 'resolve'"
            );
            if (check.rows.length > 0) {
                console.log('✅ Function exists! The error was from the event trigger AFTER creation.');
            } else {
                console.log('Function does not exist yet. The event trigger rolled it back.');
            }
        }

        // Final check
        console.log('\n--- Final status ---');
        const result = await client.query(
            "SELECT routine_schema, routine_name FROM information_schema.routines WHERE routine_schema IN ('connector', 'shared', 'warehouse') ORDER BY 1,2"
        );
        for (const row of result.rows) {
            console.log(`  ✅ ${row.routine_schema}.${row.routine_name}()`);
        }

    } finally {
        await client.end();
    }
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
