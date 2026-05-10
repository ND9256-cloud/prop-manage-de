import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
}

const supabase = createClient(supabaseUrl, supabaseKey);
const wh = supabase.schema('warehouse');

const TEST_RUN_TAG = `test:envelope_${Date.now()}`;

async function getDocumentId(): Promise<string> {
  const { data, error } = await wh
    .from('documents')
    .select('id')
    .limit(1)
    .single();
  if (error || !data) throw new Error(`Cannot get document_id: ${error?.message}`);
  return data.id;
}

let passed = 0;
const total = 12;

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
  passed++;
  console.log(`  ✓ ${passed}. ${msg}`);
}

async function run() {
  const sourceDocId = await getDocumentId();
  const extractionRunId = crypto.randomUUID();

  // 1. INSERT a valid envelope → succeeds, returns UUID
  const { data: env1, error: err1 } = await wh
    .from('document_extractions_v2')
    .insert({
      source_document_id: sourceDocId,
      doc_type: TEST_RUN_TAG,
      schema_version: '1.0.0',
      prompt_version: 'test-v0.5',
      model: 'anthropic/claude-sonnet-4-20250514',
      extraction_run_id: extractionRunId,
      fields: {},
      lifecycle: {},
    })
    .select('id')
    .single();
  if (err1) throw new Error(`Test 1 failed: ${err1.message}`);
  const envelopeId = env1!.id;
  assert(typeof envelopeId === 'string' && envelopeId.length > 0, 'INSERT valid envelope succeeds');

  // 2. INSERT with invalid human_review_status → fails (CHECK constraint)
  const { error: err2 } = await wh
    .from('document_extractions_v2')
    .insert({
      source_document_id: sourceDocId,
      doc_type: TEST_RUN_TAG,
      schema_version: '1.0.0',
      prompt_version: 'test-v0.5',
      model: 'test-model',
      extraction_run_id: crypto.randomUUID(),
      human_review_status: 'invalid_status',
    });
  assert(err2 !== null, 'Invalid human_review_status rejected by CHECK');

  // 3. INSERT with default human_review_status='not_reviewed' → succeeds
  const { data: env3, error: err3 } = await wh
    .from('document_extractions_v2')
    .insert({
      source_document_id: sourceDocId,
      doc_type: TEST_RUN_TAG,
      schema_version: '1.0.0',
      prompt_version: 'test-v0.5',
      model: 'test-model',
      extraction_run_id: crypto.randomUUID(),
    })
    .select('id, human_review_status')
    .single();
  if (err3) throw new Error(`Test 3 failed: ${err3.message}`);
  assert(env3!.human_review_status === 'not_reviewed', 'Default human_review_status is not_reviewed');

  // 4. INSERT with empty fields jsonb {} → succeeds
  const { error: err4 } = await wh
    .from('document_extractions_v2')
    .insert({
      source_document_id: sourceDocId,
      doc_type: TEST_RUN_TAG,
      schema_version: '1.0.0',
      prompt_version: 'test-v0.5',
      model: 'test-model',
      extraction_run_id: crypto.randomUUID(),
      fields: {},
    })
    .select('id')
    .single();
  assert(err4 === null, 'INSERT with empty fields {} succeeds');

  // 5. INSERT with rich fields jsonb → succeeds
  const richFields = {
    kaltmiete: {
      raw_value: '900,00 EUR',
      normalized_value: { amount: 90000, currency: 'EUR' },
      evidence: { quote: 'Die monatliche Kaltmiete beträgt 900,00 EUR', page: 2, bbox: null },
      confidence: 'high',
      absence_state: 'present',
      validation_status: 'valid',
      severity: 'critical',
    },
  };
  const { error: err5 } = await wh
    .from('document_extractions_v2')
    .insert({
      source_document_id: sourceDocId,
      doc_type: TEST_RUN_TAG,
      schema_version: '1.0.0',
      prompt_version: 'test-v0.5',
      model: 'test-model',
      extraction_run_id: crypto.randomUUID(),
      fields: richFields,
    })
    .select('id')
    .single();
  assert(err5 === null, 'INSERT with rich fields (full field envelope) succeeds');

  // 6. INSERT with full lifecycle sub-envelope → succeeds
  const fullLifecycle = {
    issue_date: '2025-01-15',
    effective_date: '2025-02-01',
    signed_date: '2025-01-10',
    expiry_date: null,
    document_status: 'active',
    supersedes_document_id: null,
    amended_by_document_id: null,
    lifecycle_evidence: { quote: 'Mietbeginn: 01.02.2025', page: 1 },
  };
  const { error: err6 } = await wh
    .from('document_extractions_v2')
    .insert({
      source_document_id: sourceDocId,
      doc_type: TEST_RUN_TAG,
      schema_version: '1.0.0',
      prompt_version: 'test-v0.5',
      model: 'test-model',
      extraction_run_id: crypto.randomUUID(),
      lifecycle: fullLifecycle,
    })
    .select('id')
    .single();
  assert(err6 === null, 'INSERT with full lifecycle sub-envelope succeeds');

  // 7. UPDATE the envelope's fields jsonb → fails (immutability trigger)
  const { error: err7 } = await wh
    .from('document_extractions_v2')
    .update({ fields: { changed: true } })
    .eq('id', envelopeId);
  assert(err7 !== null, 'UPDATE fields blocked by immutability trigger');

  // 8. UPDATE human_review_status from 'not_reviewed' to 'accepted' → succeeds
  const { error: err8 } = await wh
    .from('document_extractions_v2')
    .update({ human_review_status: 'accepted' })
    .eq('id', envelopeId);
  assert(err8 === null, 'UPDATE human_review_status to accepted succeeds');

  // 9. UPDATE human_review_status with arbitrary string → fails (CHECK constraint)
  const { error: err9 } = await wh
    .from('document_extractions_v2')
    .update({ human_review_status: 'bogus_value' })
    .eq('id', envelopeId);
  assert(err9 !== null, 'UPDATE human_review_status with invalid value rejected by CHECK');

  // 10. DELETE the envelope → fails (GoBD trigger)
  const { error: err10 } = await wh
    .from('document_extractions_v2')
    .delete()
    .eq('id', envelopeId);
  assert(err10 !== null, 'DELETE envelope blocked (GoBD trigger)');

  // 11. Index lookup: query by source_document_id ordered by created_at DESC works
  const { data: latestEnv, error: err11 } = await wh
    .from('document_extractions_v2')
    .select('id, created_at')
    .eq('source_document_id', sourceDocId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  assert(err11 === null && latestEnv !== null, 'Query by source_document_id ordered by created_at DESC works');

  // 12. Index lookup: query by extraction_run_id works
  const { data: byRunId, error: err12 } = await wh
    .from('document_extractions_v2')
    .select('id')
    .eq('extraction_run_id', extractionRunId)
    .single();
  assert(err12 === null && byRunId !== null, 'Query by extraction_run_id works');

  console.log(`\n✓ ${passed} v2 extraction envelope migration assertions passed`);
  if (passed !== total) {
    throw new Error(`Expected ${total} assertions but only ${passed} passed`);
  }
}

run().catch((err) => {
  console.error(`\nFAILED after ${passed}/${total} assertions:`, err.message);
  process.exit(1);
});
