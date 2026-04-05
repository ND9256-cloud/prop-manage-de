require('dotenv').config({ path: '.env.local' });

/**
 * Brain Contract Tests
 *
 * Validates that every property_intelligence row has the JSON structure
 * the dashboard expects: rent_roll, risk_signals, action_items with
 * required nested fields.
 *
 * Run: npx tsx src/tests/run-golden.ts
 */

import assert from 'node:assert';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

interface TestResult {
    name: string;
    passed: boolean;
    error?: string;
}

export async function runBrainContractTests(): Promise<TestResult[]> {
    const results: TestResult[] = [];

    const { data: brains, error } = await supabase
        .schema('warehouse')
        .from('property_intelligence')
        .select('property_id, analysis')
        .eq('is_current', true);

    if (error) {
        return [{ name: 'brain-contract: query', passed: false, error: error.message }];
    }

    if (!brains || brains.length === 0) {
        return [{ name: 'brain-contract: no rows', passed: false, error: 'No property_intelligence rows with is_current=true' }];
    }

    for (const row of brains) {
        const testName = `brain-contract: ${row.property_id}`;
        try {
            const analysis = row.analysis as Record<string, unknown>;
            assert.ok(analysis, 'analysis must not be null');

            // rent_roll
            const rentRoll = analysis.rent_roll as Record<string, unknown> | undefined;
            assert.ok(rentRoll && typeof rentRoll === 'object', 'rent_roll must exist and be an object');
            assert.ok(
                typeof rentRoll.monthly_gross_cold === 'number',
                `rent_roll.monthly_gross_cold must be a number, got ${typeof rentRoll.monthly_gross_cold}`,
            );
            assert.ok(
                Array.isArray(rentRoll.tenants),
                `rent_roll.tenants must be an array, got ${typeof rentRoll.tenants}`,
            );

            // risk_signals
            const riskSignals = analysis.risk_signals as Record<string, unknown> | undefined;
            assert.ok(riskSignals && typeof riskSignals === 'object', 'risk_signals must exist and be an object');
            assert.ok(
                Array.isArray(riskSignals.high),
                `risk_signals.high must be an array, got ${typeof riskSignals.high}`,
            );

            // action_items
            const actionItems = analysis.action_items as Record<string, unknown> | undefined;
            assert.ok(actionItems && typeof actionItems === 'object', 'action_items must exist and be an object');
            assert.ok(
                Array.isArray(actionItems.urgent),
                `action_items.urgent must be an array, got ${typeof actionItems.urgent}`,
            );

            results.push({ name: testName, passed: true });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ name: testName, passed: false, error: msg });
        }
    }

    return results;
}
