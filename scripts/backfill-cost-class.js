#!/usr/bin/env node
require("dotenv").config({ path: __dirname + "/../.env.local" });
/**
 * Backfill cost_class + umlagefaehig on existing document_intelligence rows
 * using keyword matching (no AI calls).
 *
 * Usage: node scripts/backfill-cost-class.js
 */

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  db: { schema: "warehouse" },
});

// --- keyword rules (order matters: first match wins) ---

const UMLAGEFAEHIG_KEYWORDS = [
  "grundsteuer", "wasser", "abwasser", "müll", "heizung",
  "schornsteinfeger", "versicherung", "hauswart", "winterdienst",
  "gartenpflege", "rauchmelder", "wartung", "beleuchtung",
];

const NICHT_IMMOBILIEN_KEYWORDS = [
  "restaurant", "pizzeria", "verpflegung", "reisekosten",
  "zugfahrkarte", "mietwagen", "privat", "einkauf", "kassenbon", "transport",
];

const ERWERBSKOSTEN_KEYWORDS = [
  "kaufvertrag", "grunderwerbsteuer", "courtage", "makler",
  "notar", "grundbuch", "eigentümer", "beurkundung",
];

const FINANZIERUNG_KEYWORDS = ["darlehen", "kredit", "grundschuld"];

const MIETEINGANG_KEYWORDS = ["mietzahlung", "mieteingang"];

const ABRECHNUNG_DOC_TYPES = ["nebenkostenabrechnung", "heizkostenabrechnung"];

function classify(row) {
  const text = [
    row.summary || "",
    ...(row.tags || []),
  ].join(" ").toLowerCase();

  const docType = (row.doc_type || "").toLowerCase();

  if (UMLAGEFAEHIG_KEYWORDS.some((k) => text.includes(k))) {
    return { cost_class: "betriebskosten", umlagefaehig: true };
  }
  if (NICHT_IMMOBILIEN_KEYWORDS.some((k) => text.includes(k))) {
    return { cost_class: "nicht_immobilien", umlagefaehig: false };
  }
  if (ERWERBSKOSTEN_KEYWORDS.some((k) => text.includes(k))) {
    return { cost_class: "erwerbskosten", umlagefaehig: false };
  }
  if (FINANZIERUNG_KEYWORDS.some((k) => text.includes(k))) {
    return { cost_class: "finanzierung", umlagefaehig: false };
  }
  if (MIETEINGANG_KEYWORDS.some((k) => text.includes(k))) {
    return { cost_class: "mieteingang", umlagefaehig: false };
  }
  if (ABRECHNUNG_DOC_TYPES.includes(docType)) {
    return { cost_class: "abrechnung", umlagefaehig: true };
  }
  // Fallback for rows that have an amount → non-apportionable operating cost
  if (row.amount != null) {
    return { cost_class: "betriebskosten", umlagefaehig: false };
  }
  return null; // no classification possible
}

async function main() {
  // Fetch rows where cost_class is NULL, join doc_type + amount from documents
  const { data: rows, error } = await supabase
    .from("document_intelligence")
    .select("id, document_id, summary, tags")
    .is("cost_class", null)
    .eq("is_current", true);

  if (error) {
    console.error("Failed to fetch intelligence rows:", error.message);
    process.exit(1);
  }

  console.log(`Found ${rows.length} rows with NULL cost_class`);
  if (rows.length === 0) return;

  // Batch fetch helper (Supabase URL length limits)
  async function batchIn(table, selectCols, colName, ids, extraFilters) {
    const BATCH = 100;
    const all = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      let q = supabase.from(table).select(selectCols).in(colName, ids.slice(i, i + BATCH));
      if (extraFilters) q = extraFilters(q);
      const { data, error } = await q;
      if (error) throw new Error(`Fetch ${table}: ${error.message}`);
      all.push(...data);
    }
    return all;
  }

  const docIds = rows.map((r) => r.document_id);
  const docs = await batchIn("documents", "id, doc_type", "id", docIds);
  const extractions = await batchIn(
    "document_extractions", "document_id, extracted_fields", "document_id", docIds,
    (q) => q.eq("is_current", true),
  );

  const docMap = Object.fromEntries(docs.map((d) => [d.id, d]));
  const extMap = Object.fromEntries(extractions.map((e) => [e.document_id, e]));

  const counts = {};
  let skipped = 0;
  let updated = 0;

  for (const row of rows) {
    const doc = docMap[row.document_id] || {};
    const ext = extMap[row.document_id];
    const amount = ext?.extracted_fields?.amount ?? null;
    const enriched = { ...row, doc_type: doc.doc_type, amount };
    const result = classify(enriched);

    if (!result) {
      skipped++;
      continue;
    }

    const { error: upErr } = await supabase
      .from("document_intelligence")
      .update({ cost_class: result.cost_class, umlagefaehig: result.umlagefaehig })
      .eq("id", row.id);

    if (upErr) {
      console.error(`Failed to update row ${row.id}:`, upErr.message);
      continue;
    }

    counts[result.cost_class] = (counts[result.cost_class] || 0) + 1;
    updated++;
  }

  console.log(`\nUpdated ${updated} rows, skipped ${skipped}`);
  console.log("Breakdown:");
  for (const [cls, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls}: ${count}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
