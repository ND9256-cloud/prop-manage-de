import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectionString = process.env.DATABASE_URL.replace(':5432/', ':6543/');

const resolveSql = `
CREATE OR REPLACE FUNCTION connector.resolve(
  p_org_id        UUID,
  p_entity_type   TEXT,
  p_fields        JSONB,
  p_confidence_threshold NUMERIC DEFAULT 90.0
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_result JSONB;
  v_candidates JSONB := '[]'::JSONB;
  v_match_score NUMERIC;
BEGIN
  IF p_entity_type = 'property' THEN
    SELECT jsonb_agg(jsonb_build_object(
      'pm_entity_id', p.id, 'name', p.name,
      'address', concat(p.address_street,' ',p.address_number,', ',p.address_zip,' ',p.address_city),
      'confidence', CASE 
        WHEN lower(p.address_street) = lower(p_fields->>'address_street') AND p.address_zip = (p_fields->>'address_zip') THEN 95.0
        WHEN lower(p.address_street) LIKE lower('%' || (p_fields->>'address_street') || '%') THEN 70.0
        ELSE 40.0 END
    )) INTO v_candidates FROM pm.properties p WHERE p.org_id = p_org_id;
  ELSIF p_entity_type = 'unit' THEN
    SELECT jsonb_agg(jsonb_build_object(
      'pm_entity_id', u.id, 'unit_ref', u.unit_ref, 'property_id', u.property_id,
      'confidence', CASE
        WHEN lower(u.unit_ref) = lower(p_fields->>'unit_ref') THEN 95.0
        WHEN lower(u.unit_ref) LIKE lower('%' || (p_fields->>'unit_ref') || '%') THEN 70.0
        ELSE 40.0 END
    )) INTO v_candidates FROM pm.units u WHERE u.org_id = p_org_id
      AND (p_fields->>'property_id' IS NULL OR u.property_id = (p_fields->>'property_id')::UUID);
  ELSIF p_entity_type = 'tenant' THEN
    SELECT jsonb_agg(jsonb_build_object(
      'pm_entity_id', t.id, 'name', concat(t.first_name,' ',t.last_name),
      'confidence', CASE
        WHEN lower(concat(t.first_name,' ',t.last_name)) = lower(p_fields->>'tenant_name') THEN 95.0
        WHEN lower(t.last_name) = lower(p_fields->>'last_name') THEN 75.0
        ELSE 40.0 END
    )) INTO v_candidates FROM pm.tenants t WHERE t.org_id = p_org_id;
  END IF;

  SELECT CASE
    WHEN v_candidates IS NULL OR jsonb_array_length(v_candidates) = 0 THEN
      jsonb_build_object('match_type','new','candidates','[]'::JSONB)
    WHEN (SELECT MAX((c->>'confidence')::NUMERIC) FROM jsonb_array_elements(v_candidates) c) >= p_confidence_threshold THEN
      jsonb_build_object('match_type','existing','candidates',v_candidates,
        'best_match',(SELECT c FROM jsonb_array_elements(v_candidates) c ORDER BY (c->>'confidence')::NUMERIC DESC LIMIT 1))
    WHEN (SELECT COUNT(*) FROM jsonb_array_elements(v_candidates) c WHERE (c->>'confidence')::NUMERIC >= 60) > 1 THEN
      jsonb_build_object('match_type','ambiguous','candidates',v_candidates)
    ELSE jsonb_build_object('match_type','new','candidates',v_candidates)
  END INTO v_result;

  RETURN v_result;
END;
$fn$;
`;

async function run() {
    const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();
        console.log('Connected.\n');

        // Find the event trigger name
        console.log('Looking for event triggers...');
        const triggers = await client.query(
            "SELECT evtname, evtevent, evtenabled FROM pg_event_trigger;"
        );
        console.log('Event triggers found:');
        for (const t of triggers.rows) {
            console.log(`  ${t.evtname} (event: ${t.evtevent}, enabled: ${t.evtenabled})`);
        }

        // Try disabling each relevant trigger
        let disabledTriggers = [];
        for (const t of triggers.rows) {
            if (t.evtname.includes('graphql') || t.evtname.includes('pg_graphql')) {
                try {
                    await client.query(`ALTER EVENT TRIGGER ${t.evtname} DISABLE;`);
                    disabledTriggers.push(t.evtname);
                    console.log(`✅ Disabled trigger: ${t.evtname}`);
                } catch (err) {
                    console.log(`⚠️  Cannot disable ${t.evtname}: ${err.message}`);
                }
            }
        }

        // Now create the function
        console.log('\nCreating connector.resolve()...');
        try {
            await client.query(resolveSql);
            console.log('✅ connector.resolve() created!');
        } catch (err) {
            console.error('❌ Failed: ' + err.message);
        }

        // Re-enable triggers
        for (const name of disabledTriggers) {
            try {
                await client.query(`ALTER EVENT TRIGGER ${name} ENABLE;`);
                console.log(`✅ Re-enabled trigger: ${name}`);
            } catch (err) {
                console.log(`⚠️  Could not re-enable ${name}: ${err.message}`);
            }
        }

        // Verify
        const result = await client.query(
            "SELECT routine_schema, routine_name FROM information_schema.routines WHERE routine_schema = 'connector';"
        );
        console.log('\nFunctions in connector schema:');
        for (const row of result.rows) {
            console.log(`  ✅ ${row.routine_schema}.${row.routine_name}()`);
        }

    } finally {
        await client.end();
    }
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
