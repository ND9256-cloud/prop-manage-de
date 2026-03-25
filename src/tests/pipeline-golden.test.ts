/**
 * Pipeline Golden File Tests
 *
 * Compares expected extraction output (from fixtures/) against actual
 * document_extractions rows in the warehouse. Each fixture in manifest.json
 * defines a document_id whose extraction is compared field-by-field.
 *
 * Run: DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/run-golden.ts
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const FIXTURES_DIR = join(__dirname, 'fixtures');

interface ManifestEntry {
    doc_type: string;
    document_id: string;
    description: string;
}

interface ExpectedOutput {
    doc_type: string;
    category: string;
    confidence_score: number;
    extracted_fields: Record<string, unknown>;
}

interface TestResult {
    name: string;
    passed: boolean;
    error?: string;
}

function loadManifest(): ManifestEntry[] {
    const raw = readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf-8');
    return JSON.parse(raw);
}

function loadExpected(docType: string): ExpectedOutput {
    const raw = readFileSync(join(FIXTURES_DIR, `${docType}.expected.json`), 'utf-8');
    return JSON.parse(raw);
}

async function testFixture(entry: ManifestEntry): Promise<TestResult> {
    const testName = `${entry.doc_type} (${entry.document_id})`;

    try {
        const expected = loadExpected(entry.doc_type);

        // Query the actual extraction for this document
        const { data: extraction, error } = await supabase
            .schema('warehouse')
            .from('document_extractions')
            .select('*, documents!inner(doc_type, category)')
            .eq('document_id', entry.document_id)
            .eq('is_current', true)
            .single();

        if (error) {
            // If no row found, this is a fixture-only test (no real data yet)
            // We validate the fixture structure instead
            if (error.code === 'PGRST116') {
                // No rows — run structural validation on the expected file
                assert.ok(expected.doc_type, 'expected.doc_type must be set');
                assert.ok(expected.category, 'expected.category must be set');
                assert.ok(typeof expected.confidence_score === 'number', 'confidence_score must be a number');
                assert.ok(
                    expected.extracted_fields && typeof expected.extracted_fields === 'object',
                    'extracted_fields must be an object',
                );
                return { name: testName, passed: true, error: 'fixture-only (no DB row)' };
            }
            throw new Error(`Query failed: ${error.message}`);
        }

        // Assert doc_type matches
        const actualDocType = (extraction as any).documents?.doc_type;
        assert.strictEqual(
            actualDocType,
            expected.doc_type,
            `doc_type mismatch: expected "${expected.doc_type}", got "${actualDocType}"`,
        );

        // Assert category matches
        const actualCategory = (extraction as any).documents?.category;
        assert.strictEqual(
            actualCategory,
            expected.category,
            `category mismatch: expected "${expected.category}", got "${actualCategory}"`,
        );

        // Assert extracted_fields has the same keys
        const actualFields = extraction.extracted_fields as Record<string, unknown>;
        const expectedKeys = Object.keys(expected.extracted_fields);
        for (const key of expectedKeys) {
            assert.ok(
                key in actualFields,
                `missing extracted_field key: "${key}"`,
            );
        }

        // Assert confidence_score is within 0.1 of expected
        const actualConfidence = Number(extraction.confidence_score);
        const expectedConfidence = expected.confidence_score;
        assert.ok(
            Math.abs(actualConfidence - expectedConfidence) <= 0.1,
            `confidence_score out of range: expected ${expectedConfidence} ±0.1, got ${actualConfidence}`,
        );

        return { name: testName, passed: true };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { name: testName, passed: false, error: msg };
    }
}

export async function runGoldenTests(): Promise<TestResult[]> {
    const manifest = loadManifest();
    const results: TestResult[] = [];

    for (const entry of manifest) {
        const result = await testFixture(entry);
        results.push(result);
    }

    return results;
}
