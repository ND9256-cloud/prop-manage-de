#!/usr/bin/env node
require("dotenv").config({path: __dirname + "/../.env.local"});
/**
 * Batch generate document intelligence for applied documents
 * that don't yet have a current intelligence row.
 *
 * Usage: ANTHROPIC_API_KEY=sk-... node scripts/generate-intelligence.js
 * Resumes from scripts/.intelligence-state.json if present.
 */

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
  console.error("Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  db: { schema: "warehouse" },
});

const STATE_PATH = path.join(__dirname, ".intelligence-state.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { completed: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPendingDocuments(completedIds) {
  // Get IDs that already have current intelligence
  const { data: existingRows, error: existErr } = await supabase
    .from("document_intelligence")
    .select("document_id")
    .eq("is_current", true);

  if (existErr) throw new Error(`Failed to query intelligence: ${existErr.message}`);

  const existingIds = new Set((existingRows || []).map((r) => r.document_id));
  const skipIds = new Set([...existingIds, ...completedIds]);

  // Get applied, non-foto documents
  const { data: docs, error: docErr } = await supabase
    .from("documents")
    .select("id, file_name, ocr_text, doc_type, org_id")
    .eq("status", "applied")
    .neq("doc_type", "foto")
    .order("created_at", { ascending: true });

  if (docErr) throw new Error(`Failed to query documents: ${docErr.message}`);

  return (docs || []).filter((d) => !skipIds.has(d.id));
}

async function fetchExtractedFields(documentId) {
  const { data, error } = await supabase
    .from("document_extractions")
    .select("extracted_fields")
    .eq("document_id", documentId)
    .eq("is_current", true)
    .limit(1)
    .single();

  if (error || !data) return {};
  return data.extracted_fields || {};
}

async function callAnthropic(ocrText, docType, extractedFields) {
  const contextBlock = JSON.stringify({
    doc_type: docType,
    extracted_fields: extractedFields,
  });

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      messages: [
        {
          role: "user",
          content: `Du bist ein deutscher Hausverwaltungs-Assistent. Analysiere dieses Dokument. Antworte NUR mit validem JSON:\n{"summary":"2-3 Sätze","tags":[],"entity_name":"Hauptperson/Firma","entity_type":"mieter|vermieter|dienstleister|behoerde|versicherung|bank|notar|sonstiges","unit_ref":"EG|1.OG|DG|Keller|null","period_start":"YYYY-MM-DD|null","period_end":"YYYY-MM-DD|null","action_signals":[],"viewer_safe":true}\n\nWICHTIG zu unit_ref: Bekannte Einheiten sind EG, 1.OG, DG, Keller. Wenn der Mieter oder die Adresse auf eine bestimmte Einheit hinweist, gib diese an. Normalisiere immer zu: EG, 1.OG, DG, Keller.\nWICHTIG zu viewer_safe: NUR false für persönliche Dokumente (Gehaltsabrechnung, Kontoauszug, Personalausweis, Reisepass, Bonitätsauskunft, Selbstauskunft). Alle Immobilien-bezogenen Dokumente (Mietverträge, Nebenkostenabrechnungen, Rechnungen, Versicherungen, Bescheide, Übergabeprotokolle) sind IMMER viewer_safe: true.\n\nKontext: ${contextBlock}\n\nDokumenttext:\n${ocrText}`,
        },
      ],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${body}`);
  }

  const result = await resp.json();
  const text = result.content?.[0]?.text || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in response");

  return JSON.parse(match[0]);
}

async function storeIntelligence(documentId, orgId, intel) {
  // Mark previous as not current
  await supabase
    .from("document_intelligence")
    .update({ is_current: false })
    .eq("document_id", documentId);

  const { error } = await supabase.from("document_intelligence").insert({
    document_id: documentId,
    org_id: orgId,
    summary: intel.summary ?? "",
    tags: intel.tags ?? [],
    entity_name: intel.entity_name ?? null,
    entity_type: intel.entity_type ?? null,
    unit_ref: intel.unit_ref ?? null,
    period_start: intel.period_start ?? null,
    period_end: intel.period_end ?? null,
    action_signals: intel.action_signals ?? [],
    viewer_safe: intel.viewer_safe ?? true,
    is_current: true,
  });

  if (error) throw new Error(`Insert failed: ${error.message}`);
}

async function main() {
  const state = loadState();
  console.log(`Loaded state: ${state.completed.length} previously completed`);

  const docs = await fetchPendingDocuments(state.completed);
  const total = docs.length;
  console.log(`Found ${total} documents to process\n`);

  if (total === 0) {
    console.log("Nothing to do.");
    return;
  }

  let processed = 0;
  let failed = 0;

  for (const doc of docs) {
    processed++;
    const ocrText = (doc.ocr_text ?? "").slice(0, 4000);

    if (!ocrText) {
      console.log(`[${processed}/${total}] ${doc.file_name} — skipped (no OCR text)`);
      state.completed.push(doc.id);
      saveState(state);
      continue;
    }

    try {
      const extractedFields = await fetchExtractedFields(doc.id);
      const intel = await callAnthropic(ocrText, doc.doc_type, extractedFields);
      await storeIntelligence(doc.id, doc.org_id, intel);

      console.log(`[${processed}/${total}] ${doc.file_name} — done`);
      state.completed.push(doc.id);
      saveState(state);
    } catch (err) {
      failed++;
      console.error(`[${processed}/${total}] ${doc.file_name} — ERROR: ${err.message}`);
    }

    // Rate limit: 1 request/second
    if (processed < total) await sleep(1000);
  }

  console.log(`\nComplete: ${processed - failed} succeeded, ${failed} failed out of ${total}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
