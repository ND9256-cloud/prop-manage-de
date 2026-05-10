import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
}

const supabase = createClient(supabaseUrl, supabaseKey);
const wh = supabase.schema('warehouse');

const TEST_SUBJECT = `test:integration_${Date.now()}`;

async function getPropertyId(): Promise<string> {
  const { data, error } = await supabase
    .from('Property')
    .select('id')
    .limit(1)
    .single();
  if (error || !data) throw new Error(`Cannot get property_id: ${error?.message}`);
  return data.id;
}

let passed = 0;
const total = 13;

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
  passed++;
  console.log(`  ✓ ${passed}. ${msg}`);
}

async function run() {
  const propertyId = await getPropertyId();
  const extractionRunId = crypto.randomUUID();

  // 1. INSERT a valid claim → succeeds
  const { data: claim1, error: err1 } = await wh
    .from('claims')
    .insert({
      property_id: propertyId,
      subject: TEST_SUBJECT,
      predicate: 'test_predicate',
      value: 'test_value',
      claim_kind: 'assertion',
      source_type: 'document_extraction',
      valid_from: '2025-01-01',
      source_extraction_run_id: extractionRunId,
    })
    .select('id')
    .single();
  if (err1) throw new Error(`Test 1 failed: ${err1.message}`);
  const claimId = claim1!.id;
  assert(typeof claimId === 'string' && claimId.length > 0, 'INSERT valid claim succeeds');

  // 2. INSERT with invalid claim_kind → fails
  const { error: err2 } = await wh
    .from('claims')
    .insert({
      property_id: propertyId,
      subject: TEST_SUBJECT,
      predicate: 'p',
      value: 'v',
      claim_kind: 'invalid_kind',
      source_type: 'document_extraction',
      valid_from: '2025-01-01',
      source_extraction_run_id: crypto.randomUUID(),
    });
  assert(err2 !== null, 'Invalid claim_kind rejected by CHECK');

  // 3. INSERT human_adjudication without human_actor_id → fails
  const { error: err3 } = await wh
    .from('claims')
    .insert({
      property_id: propertyId,
      subject: TEST_SUBJECT,
      predicate: 'p',
      value: 'v',
      claim_kind: 'assertion',
      source_type: 'human_adjudication',
      valid_from: '2025-01-01',
      // human_actor_id intentionally omitted
    });
  assert(err3 !== null, 'human_adjudication requires human_actor_id');

  // 4. INSERT document_extraction without source_extraction_run_id → fails
  const { error: err4 } = await wh
    .from('claims')
    .insert({
      property_id: propertyId,
      subject: TEST_SUBJECT,
      predicate: 'p',
      value: 'v',
      claim_kind: 'assertion',
      source_type: 'document_extraction',
      valid_from: '2025-01-01',
      // source_extraction_run_id intentionally omitted
    });
  assert(err4 !== null, 'document_extraction requires source_extraction_run_id');

  // 5. INSERT with valid_to < valid_from → fails
  const { error: err5 } = await wh
    .from('claims')
    .insert({
      property_id: propertyId,
      subject: TEST_SUBJECT,
      predicate: 'p',
      value: 'v',
      claim_kind: 'assertion',
      source_type: 'document_extraction',
      valid_from: '2025-06-01',
      valid_to: '2025-01-01',
      source_extraction_run_id: crypto.randomUUID(),
    });
  assert(err5 !== null, 'valid_to < valid_from rejected');

  // 6. UPDATE claim's value → fails (immutability trigger)
  const { error: err6 } = await wh
    .from('claims')
    .update({ value: 'changed' })
    .eq('id', claimId);
  assert(err6 !== null, 'UPDATE value blocked by immutability trigger');

  // 7. UPDATE claim's valid_to (NULL → date) → succeeds (one-way supersession)
  const { error: err7 } = await wh
    .from('claims')
    .update({ valid_to: '2025-12-31' })
    .eq('id', claimId);
  assert(err7 === null, 'UPDATE valid_to NULL→date succeeds');

  // 8. UPDATE claim's valid_to again (date → other date) → fails
  const { error: err8 } = await wh
    .from('claims')
    .update({ valid_to: '2026-06-30' })
    .eq('id', claimId);
  assert(err8 !== null, 'UPDATE valid_to date→date blocked (one-way only)');

  // 9. DELETE the claim → fails (GoBD trigger)
  const { error: err9 } = await wh
    .from('claims')
    .delete()
    .eq('id', claimId);
  assert(err9 !== null, 'DELETE claim blocked (GoBD)');

  // 10. INSERT a claim_closure → succeeds (need second claim as reason)
  const { data: claim2 } = await wh
    .from('claims')
    .insert({
      property_id: propertyId,
      subject: TEST_SUBJECT,
      predicate: 'test_pred_2',
      value: 'v2',
      claim_kind: 'assertion',
      source_type: 'document_extraction',
      valid_from: '2025-02-01',
      source_extraction_run_id: crypto.randomUUID(),
    })
    .select('id')
    .single();
  const claim2Id = claim2!.id;

  const { error: err10 } = await wh
    .from('claim_closures')
    .insert({
      target_claim_id: claimId,
      reason_claim_id: claim2Id,
      close_mode: 'close_overlapping_only',
      applied_valid_to: '2025-12-31',
      applier_version: 'test-v0.4',
    });
  assert(err10 === null, 'INSERT claim_closure succeeds');

  // 11. UPDATE the claim_closure → fails (audit log immutability)
  const { error: err11 } = await wh
    .from('claim_closures')
    .update({ applier_version: 'hacked' })
    .eq('target_claim_id', claimId);
  assert(err11 !== null, 'UPDATE claim_closure blocked (audit log)');

  // 12. INSERT a derivation_record → succeeds
  const { error: err12 } = await wh
    .from('derivation_records')
    .insert({
      property_id: propertyId,
      output_type: 'claim',
      output_id: claimId,
      input_claim_ids: [claimId],
      rule_refs: ['rule:test'],
      emitter_version: 'test-v0.4',
    });
  assert(err12 === null, 'INSERT derivation_record succeeds');

  // 13. DELETE a derivation_record → fails
  const { error: err13 } = await wh
    .from('derivation_records')
    .delete()
    .eq('output_id', claimId);
  assert(err13 !== null, 'DELETE derivation_record blocked');

  console.log(`\n✓ ${passed} claim store migration assertions passed`);
  if (passed !== total) {
    throw new Error(`Expected ${total} assertions but only ${passed} passed`);
  }
}

run().catch((err) => {
  console.error(`\nFAILED after ${passed}/${total} assertions:`, err.message);
  process.exit(1);
});
