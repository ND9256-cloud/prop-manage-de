require('dotenv').config({ path: '.env.local' });

/**
 * Golden file test runner
 *
 * Run: npx tsx src/tests/run-golden.ts
 */

import { runGoldenTests } from './pipeline-golden.test';
import { runBrainContractTests } from './brain-contract.test';

async function main() {
    console.log('=== Pipeline Golden File Tests ===\n');

    const goldenResults = await runGoldenTests();

    console.log('\n=== Brain Contract Tests ===\n');

    const brainResults = await runBrainContractTests();

    const results = [...goldenResults, ...brainResults];

    let passed = 0;
    let failed = 0;

    for (const r of results) {
        if (r.passed) {
            passed++;
            const note = r.error ? ` (${r.error})` : '';
            console.log(`  ✓ ${r.name}${note}`);
        } else {
            failed++;
            console.log(`  ✗ ${r.name}`);
            console.log(`    ${r.error}`);
        }
    }

    console.log(`\n${passed} passed, ${failed} failed, ${results.length} total`);

    if (failed > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
