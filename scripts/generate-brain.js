#!/usr/bin/env node
require("dotenv").config({ path: __dirname + "/../.env.local" });
/**
 * Generate property intelligence "brain" from document intelligence + extractions.
 *
 * Usage:
 *   node scripts/generate-brain.js --all
 *   node scripts/generate-brain.js --property <property_id>
 */

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

const publicSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- Prompt ---

const BRAIN_PROMPT = `Du bist ein erfahrener Immobilien-Analyst im Stil von Blackstone Real Estate. Du erhältst alle Dokumenten-Intelligenz und Extraktionsdaten einer Immobilie. Erstelle eine umfassende Analyse.

WICHTIG: Übergabeprotokolle können zwei Bedeutungen haben: (1) Mieterwechsel — ein Mieter zieht ein oder aus, (2) Eigentümerwechsel — die Immobilie wird verkauft und an einen neuen Eigentümer übergeben. Unterscheide diese anhand des Kontexts: Wenn das Protokoll einen Käufer/Verkäufer nennt oder im Zusammenhang mit einem Kaufvertrag steht, ist es ein Eigentümerwechsel. Die bestehenden Mieter bleiben in diesem Fall aktiv. Prüfe den Mietvertrag-Status: Wenn kein Kündigungsschreiben für einen Mieter existiert und der Mietvertrag noch läuft, ist der Mieter weiterhin aktiv — auch wenn ein Übergabeprotokoll existiert.

Antworte NUR mit validem JSON in dieser exakten 11-Abschnitt-Struktur:

{
  "property_overview": {
    "summary": "3-5 Sätze Gesamtüberblick der Immobilie basierend auf den Dokumenten",
    "document_coverage": "Bewertung der Dokumentenlage: vollständig / lückenhaft / kritisch",
    "confidence": "high / medium / low"
  },
  "financial_analysis": {
    "total_costs_identified": 0,
    "cost_breakdown": [{"category": "...", "amount": 0, "count": 0}],
    "recurring_costs": [{"description": "...", "amount": 0, "frequency": "monatlich/jährlich"}],
    "cost_trend": "steigend / stabil / sinkend / unklar"
  },
  "tenant_overview": {
    "identified_tenants": [{"name": "...", "unit_ref": "...", "status": "aktiv/ausgezogen/unklar"}],
    "vacancy_signals": ["..."],
    "lease_gaps": ["..."]
  },
  "insurance_status": {
    "policies": [{"type": "...", "provider": "...", "status": "aktiv/abgelaufen/unklar", "expiry": "YYYY-MM-DD|null"}],
    "coverage_gaps": ["..."],
    "risk_assessment": "gut versichert / Lücken vorhanden / kritisch unterversichert"
  },
  "maintenance_status": {
    "recent_work": [{"description": "...", "vendor": "...", "amount": 0, "date": "YYYY-MM-DD|null"}],
    "recurring_issues": ["..."],
    "deferred_maintenance": ["..."]
  },
  "legal_compliance": {
    "documents_found": ["..."],
    "missing_critical": ["..."],
    "regulatory_flags": ["..."]
  },
  "vendor_analysis": {
    "active_vendors": [{"name": "...", "service": "...", "document_count": 0}],
    "concentration_risk": "niedrig / mittel / hoch",
    "notes": "..."
  },
  "rent_roll": {
    "current_tenants": 0,
    "monthly_gross_cold": 0,
    "annual_gross_cold": 0,
    "tenants": [{"name": "...", "unit_ref": "...", "monthly_rent": 0}]
  },
  "unit_analysis": {
    "units_identified": [{"ref": "...", "tenant": "...", "document_count": 0, "status": "..."}],
    "data_quality": "gut / lückenhaft / schlecht"
  },
  "risk_signals": {
    "high": ["..."],
    "medium": ["..."],
    "low": ["..."]
  },
  "action_items": {
    "urgent": [{"action": "...", "reason": "...", "deadline": "YYYY-MM-DD|null"}],
    "soon": [{"action": "...", "reason": "..."}],
    "backlog": [{"action": "...", "reason": "..."}]
  },
  "suggested_views": [
    {"view_name": "...", "description": "...", "sql_hint": "..."}
  ]
}

REGELN:
- Alle Texte auf Deutsch
- Beträge in Euro (als Zahl, nicht String)
- Nur Fakten aus den Dokumenten — keine Annahmen
- rent_roll: current_tenants = Anzahl aktiver Mieter, monthly_gross_cold = Summe aller Kaltmieten/Monat, annual_gross_cold = monthly_gross_cold × 12
- suggested_views: Schlage 2-4 SQL-Views vor, die für diese Immobilie nützlich wären
- Wenn Daten fehlen, schreibe "keine Daten" statt zu raten
- Analysiere Muster über alle Dokumente hinweg`;

// --- Helpers ---

async function batchIn(table, selectCols, filterCol, ids, extraFilters = {}) {
  const BATCH = 50;
  const all = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    let q = supabase.from(table).select(selectCols).in(filterCol, chunk);
    for (const [k, v] of Object.entries(extraFilters)) {
      q = q.eq(k, v);
    }
    const { data, error } = await q;
    if (error) throw new Error(`${table} query failed: ${error.message}`);
    if (data) all.push(...data);
  }
  return all;
}

// --- Data fetching ---

async function getPropertyIds(propertyIdArg) {
  if (propertyIdArg) {
    return [propertyIdArg];
  }
  const { data, error } = await publicSupabase
    .from("Property")
    .select("id");
  if (error) throw new Error(`Failed to query properties: ${error.message}`);
  return (data || []).map((p) => p.id);
}

async function getPropertyName(propertyId) {
  const { data, error } = await publicSupabase
    .from("Property")
    .select("name, street, city")
    .eq("id", propertyId)
    .single();
  if (error) return propertyId;
  return `${data.name || ""} (${data.street || ""}, ${data.city || ""})`.trim();
}

async function fetchPropertyData(propertyId) {
  // Get documents for this property
  const { data: docs, error: docErr } = await supabase
    .from("documents")
    .select("id, file_name, doc_type, status, cost_class, created_at")
    .eq("property_id", propertyId)
    .eq("status", "applied")
    .order("created_at", { ascending: true });

  if (docErr) throw new Error(`Documents query failed: ${docErr.message}`);
  if (!docs || docs.length === 0) return null;

  const docIds = docs.map((d) => d.id);

  // Get intelligence for these documents (batched to avoid URL limits)
  const intel = await batchIn(
    "document_intelligence",
    "document_id, summary, tags, entity_name, entity_type, unit_ref, period_start, period_end, action_signals, viewer_safe, cost_class, umlagefaehig",
    "document_id", docIds, { is_current: true }
  );

  // Get extractions for these documents (batched)
  const extractions = await batchIn(
    "document_extractions",
    "document_id, extracted_fields",
    "document_id", docIds, { is_current: true }
  );

  // Merge into per-document records
  const intelMap = Object.fromEntries((intel || []).map((i) => [i.document_id, i]));
  const extMap = Object.fromEntries((extractions || []).map((e) => [e.document_id, e.extracted_fields]));

  const merged = docs.map((d) => ({
    file_name: d.file_name,
    doc_type: d.doc_type,
    cost_class: d.cost_class,
    intelligence: intelMap[d.id] || null,
    extracted_fields: extMap[d.id] || null,
  }));

  return { documents: merged, documentCount: docs.length };
}

// --- AI call ---

async function callAnthropic(propertyName, propertyData) {
  const dataBlock = JSON.stringify(propertyData.documents, null, 1);

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `${BRAIN_PROMPT}\n\nImmobilie: ${propertyName}\nAnzahl Dokumente: ${propertyData.documentCount}\n\nDokumentendaten:\n${dataBlock}`,
        },
      ],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${body}`);
  }

  const result = await resp.json();
  const usage = result.usage || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cost = (inputTokens * 3 / 1_000_000) + (outputTokens * 15 / 1_000_000);

  const text = result.content?.[0]?.text || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in response");

  return {
    parsed: JSON.parse(match[0]),
    inputTokens,
    outputTokens,
    cost,
  };
}

// --- Validation ---

const REQUIRED_FIELDS = [
  { path: "rent_roll.monthly_gross_cold", type: "number" },
  { path: "rent_roll.current_tenants", type: "number" },
  { path: "rent_roll.tenants", type: "array" },
  { path: "risk_signals.high", type: "array" },
  { path: "action_items.urgent", type: "array" },
  { path: "property_overview.summary", type: "string" },
];

function validateBrain(analysis) {
  for (const { path, type } of REQUIRED_FIELDS) {
    const parts = path.split(".");
    let value = analysis;
    for (const p of parts) {
      value = value?.[p];
    }
    if (value === undefined || value === null) {
      return `missing ${path}`;
    }
    if (type === "array" && !Array.isArray(value)) {
      return `missing ${path} (expected array, got ${typeof value})`;
    }
    if (type !== "array" && typeof value !== type) {
      return `missing ${path} (expected ${type}, got ${typeof value})`;
    }
  }
  return null;
}

// --- Regression check ---

async function checkRegression(propertyId, newAnalysis) {
  const { data: existing } = await supabase
    .from("property_intelligence")
    .select("analysis")
    .eq("property_id", propertyId)
    .eq("is_current", true)
    .single();

  if (!existing?.analysis?.rent_roll) return null;

  const oldRoll = existing.analysis.rent_roll;
  const newRoll = newAnalysis.rent_roll || {};

  if (oldRoll.current_tenants > 0 && (newRoll.current_tenants || 0) === 0) {
    return `New brain has fewer tenants than existing brain. Old: ${oldRoll.current_tenants}, New: 0. Keeping old brain.`;
  }

  if (oldRoll.monthly_gross_cold > 0 && (newRoll.monthly_gross_cold || 0) === 0) {
    return `New brain has zero monthly_gross_cold vs existing ${oldRoll.monthly_gross_cold}. Keeping old brain.`;
  }

  return null;
}

// --- Store ---

async function storeBrain(propertyId, orgId, analysis, suggestedViews, documentCount) {
  // Mark previous as not current
  await supabase
    .from("property_intelligence")
    .update({ is_current: false })
    .eq("property_id", propertyId);

  const { error } = await supabase.from("property_intelligence").insert({
    property_id: propertyId,
    org_id: orgId,
    analysis,
    suggested_views: suggestedViews,
    document_count: documentCount,
    is_current: true,
  });

  if (error) throw new Error(`Insert failed: ${error.message}`);
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const allFlag = args.includes("--all");
  const propIdx = args.indexOf("--property");
  const propertyIdArg = propIdx >= 0 ? args[propIdx + 1] : null;

  if (!allFlag && !propertyIdArg) {
    console.error("Usage: node scripts/generate-brain.js --all | --property <id>");
    process.exit(1);
  }

  const propertyIds = await getPropertyIds(propertyIdArg);
  console.log(`Processing ${propertyIds.length} properties\n`);

  // Get org_id from first property
  const { data: orgData } = await publicSupabase
    .from("Property")
    .select("organizationId")
    .eq("id", propertyIds[0])
    .single();
  const orgId = orgData?.organizationId;

  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;

  for (const propertyId of propertyIds) {
    const name = await getPropertyName(propertyId);
    console.log(`--- ${name} ---`);

    const data = await fetchPropertyData(propertyId);
    if (!data) {
      console.log("  No applied documents, skipping.\n");
      continue;
    }
    console.log(`  ${data.documentCount} documents found`);

    try {
      let stored = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const { parsed, inputTokens, outputTokens, cost } = await callAnthropic(name, data);

        totalInput += inputTokens;
        totalOutput += outputTokens;
        totalCost += cost;

        const suggestedViews = parsed.suggested_views || [];
        const analysis = { ...parsed };
        delete analysis.suggested_views;

        const validationError = validateBrain(analysis);
        if (validationError) {
          console.log(`  VALIDATION FAILED: ${validationError} (attempt ${attempt}/2)`);
          if (attempt < 2) {
            console.log("  Retrying...");
            continue;
          }
          console.log("  Skipping — keeping existing brain.\n");
          break;
        }

        const regressionWarning = await checkRegression(propertyId, analysis);
        if (regressionWarning) {
          console.log(`  WARNING: ${regressionWarning}`);
          console.log("  Skipping insert.\n");
          break;
        }

        await storeBrain(propertyId, orgId, analysis, suggestedViews, data.documentCount);
        stored = true;
        console.log(`  Stored. Tokens: ${inputTokens} in / ${outputTokens} out ($${cost.toFixed(4)})\n`);
        break;
      }
    } catch (err) {
      console.error(`  ERROR: ${err.message}\n`);
    }
  }

  console.log(`\nTotal: ${totalInput} input + ${totalOutput} output tokens = $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
