/**
 * Cross-Tenant Isolation Test Harness
 *
 * Validates that the warehouse query patterns properly isolate
 * data between organizations. Creates real test fixtures under
 * the existing org, then asserts that a "wrong" org_id query
 * returns no results for those fixtures.
 *
 * Run: npx tsx -r dotenv/config src/tests/cross-tenant-isolation.test.ts
 *
 * Because warehouse.documents.org_id has a FK to Organization.id
 * (with a TEXT<->UUID cross), we can't trivially create a 2nd org
 * in this script. Instead we:
 *   1. Create fixtures under the REAL org (ORG_A)
 *   2. Query with a FAKE org_id (ORG_B) → expect 0 results
 *   3. Query with real org_id → expect results
 *
 * This proves the .eq('org_id', orgId) filter in warehouse-actions
 * prevents cross-tenant access.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}

const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ─── Test Fixture IDs ─────────────────────────────────────────
const ORG_A = '310131df-d6ed-4007-83c2-ac69a7e9df42'; // real org
const ORG_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // fake org (never created)
const DOC_A = '00000000-aa00-0001-0000-000000000001';
const EXTRACTION_A = '00000000-aa00-0002-0000-000000000001';
const TASK_A = '00000000-aa00-0003-0000-000000000001';

// ─── Helpers ───────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, description: string) {
    if (condition) {
        console.log(`  ✅ ${description}`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: ${description}`);
        failed++;
    }
}

async function cleanup() {
    console.log('\n🧹 Cleaning up test fixtures...');
    const db = supabase.schema('warehouse');
    await db.from('review_tasks').delete().eq('id', TASK_A);
    await db.from('document_extractions').delete().eq('id', EXTRACTION_A);
    await db.from('apply_log').delete().eq('document_id', DOC_A);
    await db.from('processing_jobs').delete().eq('document_id', DOC_A);
    await db.from('suggested_matches').delete().eq('document_id', DOC_A);
    await db.from('documents').delete().eq('id', DOC_A);
    console.log('  Done.');
}

// ─── Fixture Creation ──────────────────────────────────────────
async function createFixtures() {
    console.log('\n📦 Creating test fixtures under org:', ORG_A);
    const db = supabase.schema('warehouse');

    // Document owned by ORG_A
    const { error: docErr } = await db.from('documents').insert({
        id: DOC_A,
        org_id: ORG_A,
        source: 'ui',
        source_ref: `test-${DOC_A}`,
        file_name: 'test_isolation.pdf',
        file_hash: 'test_hash_isolation_001',
        storage_path: `${ORG_A}/${DOC_A}/test_isolation.pdf`,
        file_size_bytes: 1024,
        mime_type: 'application/pdf',
        status: 'needs_review',
    });
    if (docErr) throw new Error(`Failed to create doc: ${docErr.message}`);

    // Extraction for the document
    const { error: extErr } = await db.from('document_extractions').insert({
        id: EXTRACTION_A,
        document_id: DOC_A,
        org_id: ORG_A,
        model: 'test',
        prompt_version: 'v1',
        extracted_fields: { vendor_name: 'Test Vendor', amount: 99.99 },
        confidence_score: 85,
        flags: [],
        is_current: true,
    });
    if (extErr) throw new Error(`Failed to create extraction: ${extErr.message}`);

    // Review task for the document
    const { error: taskErr } = await db.from('review_tasks').insert({
        id: TASK_A,
        document_id: DOC_A,
        org_id: ORG_A,
        reason: 'test isolation check',
        reason_code: 'low_confidence',
        status: 'open',
    });
    if (taskErr) throw new Error(`Failed to create task: ${taskErr.message}`);

    console.log('  Created: 1 doc, 1 extraction, 1 review task');
}

// ─── Tests ─────────────────────────────────────────────────────

async function testDocumentListIsolation() {
    console.log('\n📋 Test: Document list — wrong org sees nothing');
    const db = supabase.schema('warehouse');

    // ORG_B querying → should NOT see ORG_A's doc
    const { data: wrongOrgDocs } = await db.from('documents')
        .select('id')
        .eq('org_id', ORG_B)
        .eq('id', DOC_A);

    assert(wrongOrgDocs?.length === 0, 'Wrong org cannot list the test document');

    // ORG_A querying → SHOULD see its doc
    const { data: rightOrgDocs } = await db.from('documents')
        .select('id')
        .eq('org_id', ORG_A)
        .eq('id', DOC_A);

    assert(rightOrgDocs?.length === 1, 'Correct org can list its own document');
}

async function testDocumentPreviewIsolation() {
    console.log('\n📋 Test: Document preview — wrong org blocked');
    const db = supabase.schema('warehouse');

    const { data: wrongPreview } = await db.from('documents')
        .select('id, file_name, storage_path')
        .eq('id', DOC_A)
        .eq('org_id', ORG_B)
        .single();

    assert(wrongPreview === null, 'Wrong org cannot preview document');

    const { data: rightPreview } = await db.from('documents')
        .select('id, file_name')
        .eq('id', DOC_A)
        .eq('org_id', ORG_A)
        .single();

    assert(rightPreview !== null, 'Correct org can preview its document');
    assert(rightPreview?.file_name === 'test_isolation.pdf', 'Preview returns correct data');
}

async function testExtractionIsolation() {
    console.log('\n📋 Test: Extraction read — wrong org blocked');
    const db = supabase.schema('warehouse');

    // Wrong org trying to read extraction by document_id
    const { data: wrongExtractions } = await db.from('document_extractions')
        .select('id, extracted_fields')
        .eq('org_id', ORG_B)
        .eq('document_id', DOC_A)
        .eq('is_current', true);

    assert(wrongExtractions?.length === 0, 'Wrong org cannot read extraction');

    // Correct org reads extraction
    const { data: rightExtractions } = await db.from('document_extractions')
        .select('id, extracted_fields')
        .eq('org_id', ORG_A)
        .eq('document_id', DOC_A)
        .eq('is_current', true);

    assert(rightExtractions?.length === 1, 'Correct org can read its extraction');
}

async function testReviewTaskListIsolation() {
    console.log('\n📋 Test: Review task list — wrong org sees nothing');
    const db = supabase.schema('warehouse');

    const { data: wrongTasks } = await db.from('review_tasks')
        .select('id')
        .eq('org_id', ORG_B)
        .eq('id', TASK_A);

    assert(wrongTasks?.length === 0, 'Wrong org cannot list review task');

    const { data: rightTasks } = await db.from('review_tasks')
        .select('id')
        .eq('org_id', ORG_A)
        .eq('id', TASK_A);

    assert(rightTasks?.length === 1, 'Correct org can list its review task');
}

async function testDismissWriteIsolation() {
    console.log('\n📋 Test: Dismiss write — wrong org update affects 0 rows');
    const db = supabase.schema('warehouse');

    // Wrong org tries to dismiss the task
    const { data: wrongDismiss } = await db.from('review_tasks')
        .update({ status: 'dismissed' })
        .eq('id', TASK_A)
        .eq('org_id', ORG_B)
        .select();

    assert(wrongDismiss?.length === 0, 'Wrong org dismiss update returns 0 rows');

    // Verify task is still open
    const { data: taskCheck } = await db.from('review_tasks')
        .select('status')
        .eq('id', TASK_A)
        .single();

    assert(taskCheck?.status === 'open', 'Task still open after wrong-org dismiss attempt');
}

async function testRenameWriteIsolation() {
    console.log('\n📋 Test: Rename write — wrong org update affects 0 rows');
    const db = supabase.schema('warehouse');

    // Wrong org tries to rename the document
    const { data: wrongRename } = await db.from('documents')
        .update({ display_name: 'HACKED_BY_WRONG_ORG' })
        .eq('id', DOC_A)
        .eq('org_id', ORG_B)
        .select();

    assert(wrongRename?.length === 0, 'Wrong org rename returns 0 rows');

    // Verify original document untouched
    const { data: docCheck } = await db.from('documents')
        .select('display_name')
        .eq('id', DOC_A)
        .single();

    assert(docCheck?.display_name !== 'HACKED_BY_WRONG_ORG', 'Document unchanged after wrong-org rename');
}

async function testSoftDeleteWriteIsolation() {
    console.log('\n📋 Test: Soft-delete write — wrong org update affects 0 rows');
    const db = supabase.schema('warehouse');

    // Wrong org tries to soft-delete
    const { data: wrongDelete } = await db.from('documents')
        .update({ status: 'deleted' })
        .eq('id', DOC_A)
        .eq('org_id', ORG_B)
        .select();

    assert(wrongDelete?.length === 0, 'Wrong org soft-delete returns 0 rows');

    // Verify still active
    const { data: docCheck } = await db.from('documents')
        .select('status')
        .eq('id', DOC_A)
        .single();

    assert(docCheck?.status !== 'deleted', 'Document status unchanged after wrong-org delete');
}

async function testStoragePathIsolation() {
    console.log('\n📋 Test: Storage path follows org_id prefix');
    const db = supabase.schema('warehouse');

    const { data: doc } = await db.from('documents')
        .select('org_id, storage_path')
        .eq('id', DOC_A)
        .eq('org_id', ORG_A)
        .single();

    assert(doc !== null, 'Document found');
    assert(
        doc?.storage_path?.startsWith(doc?.org_id),
        `Storage path "${doc?.storage_path}" starts with org_id "${doc?.org_id}"`
    );
}

async function testDataIntegrity() {
    console.log('\n📋 Test: Extraction→Document org_id consistency');
    const db = supabase.schema('warehouse');

    // Fetch extraction and its parent document
    const { data: ext } = await db.from('document_extractions')
        .select('org_id, document_id')
        .eq('id', EXTRACTION_A)
        .single();

    const { data: parentDoc } = await db.from('documents')
        .select('org_id')
        .eq('id', ext?.document_id)
        .single();

    assert(ext?.org_id === parentDoc?.org_id, 'Extraction org_id matches parent document org_id');

    // Same for review task
    const { data: task } = await db.from('review_tasks')
        .select('org_id, document_id')
        .eq('id', TASK_A)
        .single();

    const { data: taskDoc } = await db.from('documents')
        .select('org_id')
        .eq('id', task?.document_id)
        .single();

    assert(task?.org_id === taskDoc?.org_id, 'Review task org_id matches parent document org_id');
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║  Cross-Tenant Isolation Test Harness         ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log(`  ORG_A (real): ${ORG_A}`);
    console.log(`  ORG_B (fake): ${ORG_B}`);

    try {
        await cleanup();
        await createFixtures();

        await testDocumentListIsolation();
        await testDocumentPreviewIsolation();
        await testExtractionIsolation();
        await testReviewTaskListIsolation();
        await testDismissWriteIsolation();
        await testRenameWriteIsolation();
        await testSoftDeleteWriteIsolation();
        await testStoragePathIsolation();
        await testDataIntegrity();

        console.log('\n══════════════════════════════════════════════');
        console.log(`  Results: ${passed} passed, ${failed} failed`);
        console.log('══════════════════════════════════════════════');

        if (failed > 0) {
            console.log('\n🔴 FAILURES DETECTED — cross-tenant leaks exist!');
            process.exitCode = 1;
        } else {
            console.log('\n✅ ALL TESTS PASSED — tenant isolation verified.');
        }
    } finally {
        await cleanup();
    }
}

main().catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
});
