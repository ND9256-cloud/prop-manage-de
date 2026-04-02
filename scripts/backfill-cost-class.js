#!/usr/bin/env node
require("dotenv").config({ path: __dirname + "/../.env.local" });
/**
 * Backfill cost_class on warehouse.documents for all applied documents.
 *
 * Logic:
 * 1. Use COST_CLASS_MAP (same as pipeline) for doc_type → cost_class.
 * 2. For doc_type=rechnung, check filename for personal cost patterns →
 *    nicht_immobilien. If amount > 10000 → erwerbskosten. Otherwise betriebskosten.
 * 3. Fallback: nicht_zugeordnet.
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

// Same as pipeline (supabase/functions/process-document/index.ts)
const COST_CLASS_MAP = {
  handwerkerrechnung:             "betriebskosten",
  grundsteuerbescheid:            "betriebskosten",
  versicherungspolice:            "betriebskosten",
  wartungsvertrag:                "betriebskosten",
  schornsteinfegerbescheinigung:  "betriebskosten",
  legionellenuntersuchung:        "betriebskosten",
  nebenkostenabrechnung:          "abrechnung",
  heizkostenabrechnung:           "abrechnung",
  betriebskostenabrechnung:       "abrechnung",
  notarieller_kaufvertrag:        "erwerbskosten",
  grunderwerbsteuerbescheid:      "erwerbskosten",
  courtagerechnung:               "erwerbskosten",
  maklervereinbarung:             "erwerbskosten",
  grundschuldbestellung:          "erwerbskosten",
  darlehensvertrag:               "finanzierung",
  kreditangebot:                  "finanzierung",
  grundschuld:                    "finanzierung",
};

// Filename patterns that indicate personal / non-property costs
const PERSONAL_COST_PATTERNS = [
  "db ticket", "deutsche bahn",
  "restaurant", "pizzeria", "café", "cafe",
  "verpflegung",
  "sixt", "mietwagen",
  "öbb", "obb",
  "geschenk",
  "thinkimmo", "think immo",
  "ohne makler", "ohnemakler",
];

// Tenant name patterns (miete + tenant-like context in filename)
const MIETE_TENANT_PATTERNS = [
  /miete\s*[a-zäöüß]+/i,  // "Miete Müller", "Miete Schmidt"
];

function classifyRechnung(fileName, amount) {
  const fn = (fileName || "").toLowerCase();

  // Check personal cost patterns
  if (PERSONAL_COST_PATTERNS.some((p) => fn.includes(p))) {
    return "nicht_immobilien";
  }

  // Check miete + tenant name pattern
  if (MIETE_TENANT_PATTERNS.some((re) => re.test(fn))) {
    return "nicht_immobilien";
  }

  // High-value invoices are acquisition costs
  if (amount != null && amount > 10000) {
    return "erwerbskosten";
  }

  // Default for rechnung
  return "betriebskosten";
}

function classify(doc, amount) {
  const docType = (doc.doc_type || "").toLowerCase();

  // Special handling for rechnung
  if (docType === "rechnung") {
    return classifyRechnung(doc.file_name, amount);
  }

  // Use COST_CLASS_MAP (same as pipeline)
  if (COST_CLASS_MAP[docType]) {
    return COST_CLASS_MAP[docType];
  }

  return "nicht_zugeordnet";
}

async function main() {
  // Fetch all applied documents with NULL cost_class
  const { data: docs, error } = await supabase
    .from("documents")
    .select("id, doc_type, file_name, property_id, status")
    .eq("status", "applied")
    .is("cost_class", null);

  if (error) {
    console.error("Failed to fetch documents:", error.message);
    process.exit(1);
  }

  console.log(`Found ${docs.length} applied documents with NULL cost_class`);
  if (docs.length === 0) return;

  // Fetch extraction amounts for these documents
  const docIds = docs.map((d) => d.id);
  const amountMap = {};

  const BATCH = 100;
  for (let i = 0; i < docIds.length; i += BATCH) {
    const batch = docIds.slice(i, i + BATCH);
    const { data: exts, error: extErr } = await supabase
      .from("document_extractions")
      .select("document_id, extracted_fields")
      .in("document_id", batch)
      .eq("is_current", true);

    if (extErr) {
      console.error("Failed to fetch extractions:", extErr.message);
      process.exit(1);
    }
    for (const ext of exts) {
      const amt = ext.extracted_fields?.amount;
      if (amt != null) amountMap[ext.document_id] = parseFloat(amt);
    }
  }

  // Fetch property names for reporting
  const propertyIds = [...new Set(docs.map((d) => d.property_id).filter(Boolean))];
  const propertyNames = {};
  if (propertyIds.length > 0) {
    const { data: props } = await supabase
      .from("documents")
      .select("property_id")
      .in("property_id", propertyIds);
    // Get property names from public schema
    const pubSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    for (const pid of propertyIds) {
      const { data: prop } = await pubSupabase
        .from("Property")
        .select("name, code")
        .eq("id", pid)
        .single();
      if (prop) propertyNames[pid] = prop.code || prop.name || pid;
    }
  }

  // Classify and update
  const classCounts = {};
  const propertyAmounts = {}; // { propertyId: { class: totalAmount } }
  let updated = 0;

  for (const doc of docs) {
    const amount = amountMap[doc.id] ?? null;
    const costClass = classify(doc, amount);

    const { error: upErr } = await supabase
      .from("documents")
      .update({ cost_class: costClass })
      .eq("id", doc.id);

    if (upErr) {
      console.error(`Failed to update doc ${doc.id}:`, upErr.message);
      continue;
    }

    classCounts[costClass] = (classCounts[costClass] || 0) + 1;
    updated++;

    // Track amounts per property per class
    if (doc.property_id && amount != null) {
      if (!propertyAmounts[doc.property_id]) propertyAmounts[doc.property_id] = {};
      const pa = propertyAmounts[doc.property_id];
      pa[costClass] = (pa[costClass] || 0) + amount;
    }
  }

  console.log(`\nUpdated ${updated} documents`);

  console.log("\n--- Counts per class ---");
  for (const [cls, count] of Object.entries(classCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls}: ${count}`);
  }

  console.log("\n--- Amounts per class per property ---");
  for (const [pid, classes] of Object.entries(propertyAmounts)) {
    const label = propertyNames[pid] || pid;
    console.log(`\n  ${label}:`);
    for (const [cls, total] of Object.entries(classes).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${cls}: €${total.toLocaleString("de-DE", { minimumFractionDigits: 2 })}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
