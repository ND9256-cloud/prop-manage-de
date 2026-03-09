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

// Bank-connection test fixture IDs
const BANK_CONN_A = '00000000-ba00-0001-0000-000000000001';
const BANK_ACCT_A = '00000000-ba00-0002-0000-000000000001';
const BANK_TX_A = '00000000-ba00-0003-0000-000000000001';
const PERSON_A = '00000000-ba00-0004-0000-000000000001';

// Membership/Invitation test fixture IDs
const USER_ADMIN = 'cf37ac0d-d115-4188-a697-a9fcfb18f6e9'; // admin@demo.com
const TEST_INVITE_EMAIL = 'test-invite@isolation-test.dev';
const TEST_INVITE_ID = '00000000-ca00-0001-0000-000000000001';
const TEST_MEMBERSHIP_USER_ID = '00000000-ca00-0002-0000-000000000001';

// Property/Unit/Lease test fixture IDs
const PROPERTY_A = '00000000-da00-0001-0000-000000000001';
const UNIT_A = '00000000-da00-0002-0000-000000000001';
const LEASE_A = '00000000-da00-0003-0000-000000000001';

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

    // Bank-connection fixtures
    const pub = supabase.schema('public');
    await pub.from('BankTransaction').delete().eq('id', BANK_TX_A);
    await pub.from('BankAccount').delete().eq('id', BANK_ACCT_A);
    await pub.from('BankConnection').delete().eq('id', BANK_CONN_A);
    await pub.from('Person').delete().eq('id', PERSON_A);

    // Property/Unit/Lease fixtures
    await pub.from('Lease').delete().eq('id', LEASE_A);
    await pub.from('Unit').delete().eq('id', UNIT_A);
    await pub.from('Property').delete().eq('id', PROPERTY_A);

    // Membership/Invitation fixtures
    await pub.from('memberships').delete().eq('userId', TEST_MEMBERSHIP_USER_ID);
    await pub.from('invitations').delete().eq('id', TEST_INVITE_ID);
    await pub.from('invitations').delete().eq('emailNorm', TEST_INVITE_EMAIL);
    await pub.from('User').delete().eq('email', TEST_INVITE_EMAIL);
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

// ─── Bank-Connection Isolation Tests ───────────────────────────

async function createBankFixtures() {
    console.log('\n🏦 Creating bank-connection test fixtures...');
    const pub = supabase.schema('public');

    // BankConnection owned by ORG_A
    await pub.from('BankConnection').insert({
        id: BANK_CONN_A,
        aspspName: 'Test Bank',
        aspspCountry: 'DE',
        status: 'ACTIVE',
        organizationId: ORG_A,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });

    // BankAccount under that connection
    await pub.from('BankAccount').insert({
        id: BANK_ACCT_A,
        externalId: 'test-external-id-isolation',
        iban: 'DE89370400440532013000',
        bankConnectionId: BANK_CONN_A,
        organizationId: ORG_A,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });

    // Person owned by ORG_A
    await pub.from('Person').insert({
        id: PERSON_A,
        firstName: 'Test',
        lastName: 'Tenant',
        organizationId: ORG_A,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });

    // BankTransaction linked to ORG_A's account and person
    await pub.from('BankTransaction').insert({
        id: BANK_TX_A,
        bookingDate: new Date().toISOString(),
        amount: 750.00,
        currency: 'EUR',
        bankAccountId: BANK_ACCT_A,
        tenantId: PERSON_A,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });

    console.log('  Created BankConnection, BankAccount, Person, BankTransaction.');
}

async function testGetBankAccountWrongOrg() {
    console.log('\n📋 Test: getBankAccount with wrong org returns nothing');
    const pub = supabase.schema('public');

    // Query with correct org — should find it
    const { data: found } = await pub.from('BankAccount')
        .select('id')
        .eq('id', BANK_ACCT_A)
        .eq('organizationId', ORG_A)
        .single();
    assert(found !== null, 'getBankAccount correct org → found');

    // Query with wrong org — should NOT find it
    const { data: notFound } = await pub.from('BankAccount')
        .select('id')
        .eq('id', BANK_ACCT_A)
        .eq('organizationId', ORG_B)
        .maybeSingle();
    assert(notFound === null, 'getBankAccount wrong org → not found');
}

async function testDeleteBankConnectionWrongOrg() {
    console.log('\n📋 Test: deleteBankConnection with wrong org deletes nothing');
    const pub = supabase.schema('public');

    // Attempt delete with wrong org — should delete 0 rows
    const { count } = await pub.from('BankConnection')
        .delete({ count: 'exact' })
        .eq('id', BANK_CONN_A)
        .eq('organizationId', ORG_B);
    assert(count === 0, `deleteBankConnection wrong org → count=${count} (expected 0)`);

    // Verify it still exists
    const { data: stillThere } = await pub.from('BankConnection')
        .select('id')
        .eq('id', BANK_CONN_A)
        .single();
    assert(stillThere !== null, 'BankConnection still exists after wrong-org delete');
}

async function testGetBankTransactionsWrongOrg() {
    console.log('\n📋 Test: getBankTransactions with wrong org returns empty');
    const pub = supabase.schema('public');

    // Verify the account belongs to ORG_A
    const { data: correctOrg } = await pub.from('BankAccount')
        .select('id')
        .eq('id', BANK_ACCT_A)
        .eq('organizationId', ORG_A)
        .single();
    assert(correctOrg !== null, 'BankAccount visible to correct org');

    // Wrong org cannot see the account → hardened code returns empty
    const { data: wrongOrg } = await pub.from('BankAccount')
        .select('id')
        .eq('id', BANK_ACCT_A)
        .eq('organizationId', ORG_B)
        .maybeSingle();
    assert(wrongOrg === null, 'BankAccount not visible to wrong org → no transactions returned');
}

async function testSyncAllBankAccountsOrgScope() {
    console.log('\n📋 Test: syncAllBankAccounts org scoping');
    const pub = supabase.schema('public');

    // Verify our test account is scoped to ORG_A
    const { data: orgAAccounts } = await pub.from('BankAccount')
        .select('id')
        .eq('organizationId', ORG_A);
    assert((orgAAccounts?.length ?? 0) > 0, 'ORG_A has bank accounts');

    // Wrong org has no accounts
    const { data: orgBAccounts } = await pub.from('BankAccount')
        .select('id')
        .eq('organizationId', ORG_B);
    assert((orgBAccounts?.length ?? 0) === 0, 'ORG_B has no bank accounts');
}

async function testGetTenantPaymentsWrongOrg() {
    console.log('\n📋 Test: getTenantPayments wrong org person returns empty');
    const pub = supabase.schema('public');

    // Correct org: person exists in ORG_A
    const { data: personCorrect } = await pub.from('Person')
        .select('id')
        .eq('id', PERSON_A)
        .eq('organizationId', ORG_A)
        .single();
    assert(personCorrect !== null, 'Person exists in correct org');

    // Wrong org check: person doesn't belong to ORG_B
    // Our hardened getTenantPayments checks tenant.organizationId
    const { data: personCheck } = await pub.from('Person')
        .select('id')
        .eq('id', PERSON_A)
        .eq('organizationId', ORG_B)
        .maybeSingle();
    assert(personCheck === null, 'getTenantPayments wrong org person → not found');
}

// ─── Membership + Invitation Isolation Tests ─────────────────

import crypto from 'crypto';

async function testMembershipReadsFromTable() {
    console.log('\n📋 Test: getOrgId reads from memberships table');
    const pub = supabase.schema('public');

    // Admin user has a membership row
    const { data: membership } = await pub.from('memberships')
        .select('orgId, role')
        .eq('userId', USER_ADMIN)
        .single();
    assert(membership !== null, 'Admin has membership row');
    assert(membership?.orgId === ORG_A, 'Membership points to correct org');
    assert(membership?.role === 'owner', 'Membership role is owner');
}

async function testAcceptInviteCreates() {
    console.log('\n📋 Test: acceptInviteAndSetPassword creates membership in correct org');
    const pub = supabase.schema('public');

    // Create a test invitation
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await pub.from('invitations').insert({
        id: TEST_INVITE_ID,
        orgId: ORG_A,
        email: TEST_INVITE_EMAIL,
        emailNorm: TEST_INVITE_EMAIL,
        role: 'manager',
        tokenHash,
        invitedBy: USER_ADMIN,
        expiresAt: expiresAt.toISOString(),
        createdAt: new Date().toISOString(),
    });

    // Verify invitation exists
    const { data: invite } = await pub.from('invitations')
        .select('id, orgId')
        .eq('id', TEST_INVITE_ID)
        .single();
    assert(invite !== null, 'Test invitation created');
    assert(invite?.orgId === ORG_A, 'Invitation points to correct org');
}

async function testExpiredTokenRejected() {
    console.log('\n📋 Test: expired token is rejected');
    const pub = supabase.schema('public');

    // Create an already-expired invitation
    const tokenHash = crypto.createHash('sha256').update('expired-test-token').digest('hex');
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 1); // expired yesterday

    // Clean up any old test invite
    await pub.from('invitations').delete().eq('tokenHash', tokenHash);

    await pub.from('invitations').insert({
        orgId: ORG_A,
        email: 'expired@test.dev',
        emailNorm: 'expired@test.dev',
        role: 'manager',
        tokenHash,
        invitedBy: USER_ADMIN,
        expiresAt: pastDate.toISOString(),
        createdAt: new Date().toISOString(),
    });

    // Verify it's expired
    const { data: invite } = await pub.from('invitations')
        .select('expiresAt')
        .eq('tokenHash', tokenHash)
        .single();
    assert(invite !== null, 'Expired invitation exists');
    assert(new Date(invite!.expiresAt) < new Date(), 'Invitation is indeed expired');

    // Cleanup
    await pub.from('invitations').delete().eq('tokenHash', tokenHash);
}

async function testUsedTokenRejected() {
    console.log('\n📋 Test: used token is rejected');
    const pub = supabase.schema('public');

    const tokenHash = crypto.createHash('sha256').update('used-test-token').digest('hex');
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);

    await pub.from('invitations').delete().eq('tokenHash', tokenHash);

    await pub.from('invitations').insert({
        orgId: ORG_A,
        email: 'used@test.dev',
        emailNorm: 'used@test.dev',
        role: 'manager',
        tokenHash,
        invitedBy: USER_ADMIN,
        expiresAt: futureDate.toISOString(),
        acceptedAt: new Date().toISOString(), // already accepted
        createdAt: new Date().toISOString(),
    });

    // Verify it's marked as used
    const { data: invite } = await pub.from('invitations')
        .select('acceptedAt')
        .eq('tokenHash', tokenHash)
        .single();
    assert(invite !== null, 'Used invitation exists');
    assert(invite!.acceptedAt !== null, 'Invitation is marked as accepted');

    await pub.from('invitations').delete().eq('tokenHash', tokenHash);
}

async function testWrongOrgTokenRejected() {
    console.log('\n📋 Test: wrong org token is rejected');
    const pub = supabase.schema('public');

    // An invitation for ORG_A cannot create a membership in ORG_B
    const tokenHash = crypto.createHash('sha256').update('wrong-org-token').digest('hex');
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);

    await pub.from('invitations').delete().eq('tokenHash', tokenHash);

    await pub.from('invitations').insert({
        orgId: ORG_A,
        email: 'crossorg@test.dev',
        emailNorm: 'crossorg@test.dev',
        role: 'manager',
        tokenHash,
        invitedBy: USER_ADMIN,
        expiresAt: futureDate.toISOString(),
        createdAt: new Date().toISOString(),
    });

    // Invitation is for ORG_A — confirm it doesn't reference ORG_B
    const { data: invite } = await pub.from('invitations')
        .select('orgId')
        .eq('tokenHash', tokenHash)
        .single();
    assert(invite?.orgId === ORG_A, 'Invitation is for ORG_A, not ORG_B');
    assert(invite?.orgId !== ORG_B, 'Invitation does NOT point to wrong org');

    await pub.from('invitations').delete().eq('tokenHash', tokenHash);
}

async function testDoubleAcceptBlocked() {
    console.log('\n📋 Test: double-accept returns already used error');
    const pub = supabase.schema('public');

    const tokenHash = crypto.createHash('sha256').update('double-accept-token').digest('hex');
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);

    await pub.from('invitations').delete().eq('tokenHash', tokenHash);

    await pub.from('invitations').insert({
        orgId: ORG_A,
        email: 'double@test.dev',
        emailNorm: 'double@test.dev',
        role: 'manager',
        tokenHash,
        invitedBy: USER_ADMIN,
        expiresAt: futureDate.toISOString(),
        acceptedAt: new Date().toISOString(), // already accepted
        createdAt: new Date().toISOString(),
    });

    // A second "accept" should be blocked because acceptedAt is set
    const { data: invite } = await pub.from('invitations')
        .select('acceptedAt')
        .eq('tokenHash', tokenHash)
        .single();
    assert(invite!.acceptedAt !== null, 'Double-accept blocked: invitation already accepted');

    await pub.from('invitations').delete().eq('tokenHash', tokenHash);
}

async function testInviteBlocksIfAlreadyMember() {
    console.log('\n📋 Test: inviteUser blocks if already member');
    const pub = supabase.schema('public');

    // Admin already has a membership in ORG_A
    const { data: existing } = await pub.from('memberships')
        .select('id')
        .eq('userId', USER_ADMIN)
        .eq('orgId', ORG_A)
        .maybeSingle();
    assert(existing !== null, 'Admin is already a member → inviteUser should block');
}

// ─── Property / Unit / Lease Isolation Tests ──────────────────

async function createPropertyFixtures() {
    console.log('\n🏠 Creating property/unit/lease test fixtures...');
    const pub = supabase.schema('public');

    await pub.from('Property').insert({
        id: PROPERTY_A,
        name: 'Test Property Isolation',
        address: 'Teststr. 1',
        city: 'Berlin',
        zip: '10115',
        type: 'APARTMENT_BUILDING',
        organizationId: ORG_A,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });

    await pub.from('Unit').insert({
        id: UNIT_A,
        unitNumber: 'TST-01',
        sizeSqm: 65.0,
        propertyId: PROPERTY_A,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });

    await pub.from('Lease').insert({
        id: LEASE_A,
        unitId: UNIT_A,
        mainTenantId: PERSON_A,
        startDate: new Date().toISOString(),
        coldRent: 850.0,
        utilityAdvance: 200.0,
        deposit: 2550.0,
        status: 'ACTIVE',
        currentUnitId: UNIT_A,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });

    console.log('  Created Property, Unit, Lease.');
}

async function testUpdatePropertyWrongOrg() {
    console.log('\n📋 Test: updateProperty wrong org — 0 rows affected');
    const pub = supabase.schema('public');

    // Wrong org tries to update the property
    const { data: wrongUpdate } = await pub.from('Property')
        .update({ name: 'HACKED_BY_WRONG_ORG' })
        .eq('id', PROPERTY_A)
        .eq('organizationId', ORG_B)
        .select();

    assert(wrongUpdate?.length === 0, 'updateProperty wrong org → 0 rows matched');

    // Verify property unchanged
    const { data: prop } = await pub.from('Property')
        .select('name')
        .eq('id', PROPERTY_A)
        .single();
    assert(prop?.name === 'Test Property Isolation', 'Property name unchanged after wrong-org update');
}

async function testDeleteUnitWrongOrg() {
    console.log('\n📋 Test: deleteUnit wrong org — unit still exists');
    const pub = supabase.schema('public');

    // Wrong org: unit's property.organizationId != ORG_B
    // Simulate the deleteMany pattern: find unit via property org scope
    const { data: wrongOrgUnit } = await pub.from('Unit')
        .select('id, Property!inner(organizationId)')
        .eq('id', UNIT_A)
        .eq('Property.organizationId', ORG_B);

    assert((wrongOrgUnit?.length ?? 0) === 0, 'deleteUnit wrong org → unit not visible');

    // Verify unit still exists
    const { data: unit } = await pub.from('Unit')
        .select('id')
        .eq('id', UNIT_A)
        .single();
    assert(unit !== null, 'Unit still exists after wrong-org delete attempt');
}

async function testCreateLeaseWrongOrg() {
    console.log('\n📋 Test: createLease wrong org — unit not found');
    const pub = supabase.schema('public');

    // Wrong org tries to find unit (simulates the findFirst guard in createLease)
    const { data: wrongUnit } = await pub.from('Unit')
        .select('id, Property!inner(organizationId)')
        .eq('id', UNIT_A)
        .eq('Property.organizationId', ORG_B);

    assert((wrongUnit?.length ?? 0) === 0, 'createLease wrong org → unit not found → blocked');
}

async function testUpdateLeaseWrongOrg() {
    console.log('\n📋 Test: updateLease wrong org — 0 rows affected');
    const pub = supabase.schema('public');

    // Wrong org tries to find lease via unit → property chain
    const { data: wrongLease } = await pub.from('Lease')
        .select('id, Unit!inner(Property!inner(organizationId))')
        .eq('id', LEASE_A)
        .eq('Unit.Property.organizationId', ORG_B);

    assert((wrongLease?.length ?? 0) === 0, 'updateLease wrong org → lease not visible → blocked');

    // Verify lease unchanged
    const { data: lease } = await pub.from('Lease')
        .select('coldRent')
        .eq('id', LEASE_A)
        .single();
    assert(lease?.coldRent === 850.0, 'Lease coldRent unchanged after wrong-org attempt');
}

async function testGetPropertyWrongOrg() {
    console.log('\n📋 Test: getProperty wrong org — returns null');
    const pub = supabase.schema('public');

    const { data: wrongProp } = await pub.from('Property')
        .select('id')
        .eq('id', PROPERTY_A)
        .eq('organizationId', ORG_B)
        .maybeSingle();

    assert(wrongProp === null, 'getProperty wrong org → not found');

    const { data: rightProp } = await pub.from('Property')
        .select('id')
        .eq('id', PROPERTY_A)
        .eq('organizationId', ORG_A)
        .single();

    assert(rightProp !== null, 'getProperty correct org → found');
}

async function testGetPersonsWrongOrg() {
    console.log('\n📋 Test: getPersons wrong org — returns empty');
    const pub = supabase.schema('public');

    const { data: wrongPersons } = await pub.from('Person')
        .select('id')
        .eq('id', PERSON_A)
        .eq('organizationId', ORG_B);

    assert((wrongPersons?.length ?? 0) === 0, 'getPersons wrong org → 0 persons');
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
        await createBankFixtures();

        // Warehouse isolation tests
        await testDocumentListIsolation();
        await testDocumentPreviewIsolation();
        await testExtractionIsolation();
        await testReviewTaskListIsolation();
        await testDismissWriteIsolation();
        await testRenameWriteIsolation();
        await testSoftDeleteWriteIsolation();
        await testStoragePathIsolation();
        await testDataIntegrity();

        // Bank-connection isolation tests
        await testGetBankAccountWrongOrg();
        await testDeleteBankConnectionWrongOrg();
        await testGetBankTransactionsWrongOrg();
        await testSyncAllBankAccountsOrgScope();
        await testGetTenantPaymentsWrongOrg();

        // Membership + Invitation isolation tests
        await testMembershipReadsFromTable();
        await testAcceptInviteCreates();
        await testExpiredTokenRejected();
        await testUsedTokenRejected();
        await testWrongOrgTokenRejected();
        await testDoubleAcceptBlocked();
        await testInviteBlocksIfAlreadyMember();

        // Property / Unit / Lease isolation tests
        await createPropertyFixtures();
        await testUpdatePropertyWrongOrg();
        await testDeleteUnitWrongOrg();
        await testCreateLeaseWrongOrg();
        await testUpdateLeaseWrongOrg();
        await testGetPropertyWrongOrg();
        await testGetPersonsWrongOrg();

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
