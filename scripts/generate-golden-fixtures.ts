/**
 * Generate golden file test fixtures from warehouse data.
 *
 * Queries warehouse.documents + document_extractions for 16 doc types,
 * picks the smallest document per type, and writes fixture files.
 *
 * Run: DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/generate-golden-fixtures.ts
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const DOC_TYPES = [
    'rechnung',
    'handwerkerrechnung',
    'mietvertrag',
    'nebenkostenabrechnung',
    'heizkostenabrechnung',
    'grundsteuerbescheid',
    'versicherungspolice',
    'kündigung',
    'mieterhöhung',
    'grundbuchauszug',
    'energieausweis',
    'gesellschaftsvertrag',
    'wohnungsübergabeprotokoll',
    'darlehensvertrag',
    'foto',
    'unknown',
];

const FIXTURES_DIR = join(__dirname, '..', 'src', 'tests', 'fixtures');

interface ManifestEntry {
    document_id: string;
    doc_type: string;
    file_name: string;
}

async function main() {
    mkdirSync(FIXTURES_DIR, { recursive: true });

    const manifest: ManifestEntry[] = [];

    for (const docType of DOC_TYPES) {
        console.log(`Querying ${docType}...`);

        // Get smallest document of this type
        const { data: docs, error: docError } = await supabase
            .schema('warehouse')
            .from('documents')
            .select('id, doc_type, category, subcategory')
            .eq('doc_type', docType)
            .order('file_size_bytes', { ascending: true })
            .limit(1);

        if (docError) {
            console.error(`  Error querying documents for ${docType}: ${docError.message}`);
            continue;
        }

        if (!docs || docs.length === 0) {
            console.warn(`  No documents found for ${docType}, skipping`);
            continue;
        }

        const doc = docs[0];

        // Get current extraction (doc_type/category/subcategory live on documents, not extractions)
        const { data: extraction, error: extError } = await supabase
            .schema('warehouse')
            .from('document_extractions')
            .select('extracted_fields, confidence_score')
            .eq('document_id', doc.id)
            .eq('is_current', true)
            .single();

        if (extError) {
            console.warn(`  No current extraction for ${docType} (${doc.id}): ${extError.message}`);
            // Write a stub fixture from document-level data
            const stub = {
                doc_type: doc.doc_type,
                category: doc.category || null,
                subcategory: doc.subcategory || null,
                extracted_fields: {},
                confidence_score: 0,
            };
            const fileName = `${docType}.expected.json`;
            writeFileSync(join(FIXTURES_DIR, fileName), JSON.stringify(stub, null, 2) + '\n');
            manifest.push({ document_id: doc.id, doc_type: docType, file_name: fileName });
            console.log(`  Wrote stub fixture: ${fileName}`);
            continue;
        }

        const fixture = {
            doc_type: doc.doc_type,
            category: doc.category || null,
            subcategory: doc.subcategory || null,
            extracted_fields: extraction.extracted_fields || {},
            confidence_score: extraction.confidence_score ?? 0,
        };

        const fileName = `${docType}.expected.json`;
        writeFileSync(join(FIXTURES_DIR, fileName), JSON.stringify(fixture, null, 2) + '\n');
        manifest.push({ document_id: doc.id, doc_type: docType, file_name: fileName });
        console.log(`  Wrote fixture: ${fileName} (doc ${doc.id})`);
    }

    writeFileSync(join(FIXTURES_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`\nWrote manifest.json with ${manifest.length} entries`);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
