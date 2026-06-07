import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { STRUCTURED_PROMPTS } from "./extraction_schemas.ts";
import { hasV2Schema } from "../../../schemas/index.ts";
import { PROMPT_FRAGMENT as MIETVERTRAG_PROMPT, SCHEMA_VERSION as MIETVERTRAG_SCHEMA_VERSION } from "../../../schemas/mietvertrag/generated/prompt_fragment.ts";
import { validateEnvelope as validateMietvertragEnvelope } from "../../../schemas/mietvertrag/generated/envelope_validator.ts";
import { VERIFIERS } from "./verifiers/index.ts";
import type { FieldSpec, FieldEnvelope } from "./verifiers/index.ts";
import { classifyOcrResponse } from "./ocr-result.ts";
import { splitPdfIntoPages, extractAllPages, stitchPageOutputs, aggregateResults } from "./page-extraction.ts";
import { callAnthropic } from "./anthropic-client.ts";

// ─── Types ───────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type Job = any;
// deno-lint-ignore no-explicit-any
type Doc = any;

interface Classification {
    doc_type: string;
    doc_type_en: string;
    language: string;
    confidence: number;
}

interface CategorizeResult {
    category: string;
    subcategory: string | null;
    display_name: string;
    retention_until: string;
    property_id: string | null;
    cost_class: string;
}

// ─── Open taxonomy: doc_type → category / subcategory / extraction prompt / retention ───
const DOC_TYPE_MAP: Record<string, {
    category: string;
    subcategory: string | null;
    extraction_prompt_key: string;
    retention_years: number;
}> = {
    mietvertrag:                { category: "vertraege",          subcategory: "mietvertrag",      extraction_prompt_key: "lease",             retention_years: 30 },
    nebenkostenabrechnung:      { category: "kosten_rechnungen",  subcategory: "betriebskosten",   extraction_prompt_key: "invoice",           retention_years: 10 },
    betriebskostenabrechnung:   { category: "kosten_rechnungen",  subcategory: "betriebskosten",   extraction_prompt_key: "invoice",           retention_years: 10 },
    heizkostenabrechnung:       { category: "kosten_rechnungen",  subcategory: "heizkosten",       extraction_prompt_key: "invoice",           retention_years: 10 },
    rechnung:                   { category: "kosten_rechnungen",  subcategory: "sonstiges",        extraction_prompt_key: "invoice",           retention_years: 10 },
    handwerkerrechnung:         { category: "kosten_rechnungen",  subcategory: "instandhaltung",   extraction_prompt_key: "invoice",           retention_years: 10 },
    "mieterhöhung":             { category: "vertraege",          subcategory: "mietanpassung",    extraction_prompt_key: "lease",             retention_years: 30 },
    "kündigung":                { category: "vertraege",          subcategory: "kuendigung",       extraction_prompt_key: "lease",             retention_years: 30 },
    grundsteuerbescheid:        { category: "behoerden",          subcategory: "steuerbescheid",   extraction_prompt_key: "default",           retention_years: 10 },
    energieausweis:             { category: "medien",             subcategory: "energieausweis",   extraction_prompt_key: "default",           retention_years: 10 },
    "wohnungsübergabeprotokoll": { category: "instandhaltung",   subcategory: "uebergabe",        extraction_prompt_key: "inspection_report", retention_years: 10 },
    versicherungspolice:        { category: "kosten_rechnungen",  subcategory: "versicherung",     extraction_prompt_key: "default",           retention_years: 10 },
    hausgeldabrechnung:         { category: "kosten_rechnungen",  subcategory: "hausgeld",         extraction_prompt_key: "invoice",           retention_years: 10 },
    mahnung:                    { category: "kosten_rechnungen",  subcategory: "mahnung",          extraction_prompt_key: "invoice",           retention_years: 10 },
    mietbescheinigung:          { category: "vertraege",          subcategory: "bescheinigung",    extraction_prompt_key: "default",           retention_years: 10 },
};

const DOC_TYPE_DEFAULT = { category: "rechtliches", subcategory: null as string | null, extraction_prompt_key: "default", retention_years: 10 };

// ─── Cost classification: doc_type → cost_class ─────────────────
const COST_CLASS_MAP: Record<string, string> = {
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

// ─── v2 schema prompt + validator registry ──────────────────────

interface V2Config {
    prompt: string;
    schemaVersion: string;
    validate: (data: unknown) => void;
    fieldSpecs: Record<string, FieldSpec>;
}

const V2_PROMPTS: Record<string, V2Config> = {
    mietvertrag: {
        prompt: MIETVERTRAG_PROMPT,
        schemaVersion: MIETVERTRAG_SCHEMA_VERSION,
        validate: validateMietvertragEnvelope,
        fieldSpecs: {
            kaltmiete: { id: "kaltmiete", type: "money", severity: "critical" },
            unit_ref: { id: "unit_ref", type: "enum", enum_values: ["EG", "1.OG", "2.OG", "3.OG", "4.OG", "DG", "Keller", "Souterrain"], severity: "critical" },
            tenant_identity: { id: "tenant_identity", type: "structured", severity: "critical" },
            landlord_identity: { id: "landlord_identity", type: "structured", severity: "critical" },
            mietbeginn: { id: "mietbeginn", type: "date", severity: "critical" },
            mietende: { id: "mietende", type: "date", severity: "important" },
            nebenkostenvorauszahlung: { id: "nebenkostenvorauszahlung", type: "money", severity: "important" },
            kaution: { id: "kaution", type: "money", severity: "important" },
        },
    },
};

// Map field_id → verifier_refs (from schema.yaml)
const V2_VERIFIER_REFS: Record<string, Record<string, string[]>> = {
    mietvertrag: {
        kaltmiete: ["monetary-verbatim"],
        unit_ref: ["enum"],
        mietbeginn: ["date-format"],
        mietende: ["date-format"],
        nebenkostenvorauszahlung: ["monetary-verbatim"],
        kaution: ["monetary-verbatim"],
    },
};

// ─── Helpers ─────────────────────────────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 8192;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

function errorResponse(msg: string, jobId?: string, status = 500): Response {
    return new Response(
        JSON.stringify({ error: msg, ...(jobId ? { job_id: jobId } : {}) }),
        { status, headers: { "Content-Type": "application/json" } },
    );
}

// ─── 1. claimJob ─────────────────────────────────────────────────

async function claimJob(supabase: SupabaseClient): Promise<Job | null> {
    const { data: job, error: claimError } = await supabase.rpc("claim_next_job");

    if (claimError) {
        console.error("Error claiming job:", claimError.message);
        throw new Error(claimError.message);
    }

    return job ?? null;
}

// ─── 2. fetchDocument ────────────────────────────────────────────

async function fetchDocument(
    supabase: SupabaseClient,
    job: Job,
): Promise<{ doc: Doc; fileBuffer: ArrayBuffer }> {
    const { data: doc, error: docError } = await supabase
        .schema("warehouse")
        .from("documents")
        .select("*")
        .eq("id", job.document_id)
        .single();

    if (docError || !doc) {
        const errMsg = docError?.message || "Document not found";
        console.error(`fetchDocument failed (fetch doc): ${errMsg}`);
        await supabase.rpc("schedule_retry", {
            p_job_id: job.id,
            p_error: errMsg,
            p_stage: "download",
        });
        throw new Error(errMsg);
    }

    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
        .from("property-documents")
        .createSignedUrl(doc.storage_path, 60);

    if (signedUrlError || !signedUrlData?.signedUrl) {
        const errMsg = signedUrlError?.message || "Failed to create signed URL";
        console.error(`fetchDocument failed (signed URL): ${errMsg}`);
        await supabase.rpc("schedule_retry", {
            p_job_id: job.id,
            p_error: errMsg,
            p_stage: "download",
        });
        throw new Error(errMsg);
    }

    const fileResponse = await fetch(signedUrlData.signedUrl);
    if (!fileResponse.ok) {
        const errMsg = `File download failed: HTTP ${fileResponse.status}`;
        console.error(`fetchDocument failed: ${errMsg}`);
        await supabase.rpc("schedule_retry", {
            p_job_id: job.id,
            p_error: errMsg,
            p_stage: "download",
        });
        throw new Error(errMsg);
    }

    const fileBuffer = await fileResponse.arrayBuffer();
    console.log(`fetchDocument complete: downloaded ${fileBuffer.byteLength} bytes (${doc.mime_type})`);

    return { doc, fileBuffer };
}

// ─── 3. extractText ──────────────────────────────────────────────

async function extractText(
    supabase: SupabaseClient,
    doc: Doc,
    fileBuffer: ArrayBuffer,
    job: Job,
): Promise<string> {
    let extractedText = "";
    let ocrConfidence = 0;

    try {
        if (doc.mime_type === "application/pdf") {
            const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;

            // Split PDF into pages
            let pageBuffers: Uint8Array[];
            try {
                pageBuffers = await splitPdfIntoPages(fileBuffer);
                console.log(`extractText: split PDF into ${pageBuffers.length} pages for doc ${doc.id}`);
            } catch (splitErr) {
                const errMsg = splitErr instanceof Error ? splitErr.message : "PDF split failed";
                throw new Error(`PDF split failed: ${errMsg}`);
            }

            // Extract each page in parallel batches
            const pageResults = await extractAllPages(anthropicKey, pageBuffers, arrayBufferToBase64);

            // Aggregate + stitch
            const stitched = stitchPageOutputs(pageResults);
            const aggregated = aggregateResults(pageResults);
            extractedText = stitched;
            ocrConfidence = aggregated.confidence;

            if (aggregated.failedPages.length > 0) {
                console.warn(
                    `extractText: doc ${doc.id} — ${aggregated.failedPages.length}/${pageResults.length} pages failed: [${aggregated.failedPages.join(", ")}]`
                );
            }
            if (aggregated.anyTruncated) {
                console.warn(
                    `extractText: doc ${doc.id} — at least one page hit max_tokens=4000 (unexpected for single-page input)`
                );
            }

            console.log(`extractText: PDF text extracted via per-page (${extractedText.length} chars, confidence=${ocrConfidence})`);

        } else if (doc.mime_type.startsWith("image/")) {
            const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;
            const base64Data = arrayBufferToBase64(fileBuffer);

            const visionResult = await callAnthropic({
                model: "claude-haiku-4-5-20251001",
                maxTokens: 8000,  // Defensive headroom for dense scans
                apiKey: anthropicKey,
                callLabel: `image-ocr-${doc.id}`,
                messages: [{
                    role: "user",
                    content: [
                        {
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: doc.mime_type,
                                data: base64Data,
                            },
                        },
                        {
                            type: "text",
                            text: "Extract all text from this document image. Return only the raw text, nothing else.",
                        },
                    ],
                }],
            });

            const classified = classifyOcrResponse(visionResult, 85);
            extractedText = classified.text;
            ocrConfidence = classified.confidence;
            if (classified.truncated) {
                console.warn(
                    `extractText: image OCR hit max_tokens for doc ${doc.id}; ` +
                    `${extractedText.length} chars extracted (TRUNCATED). ocr_confidence set to 60.`
                );
            } else {
                console.log(`extractText: image OCR extracted (${extractedText.length} chars)`);
            }

        } else {
            extractedText = "";
            ocrConfidence = 0;
            console.log(`extractText: unsupported mime type ${doc.mime_type}, skipping OCR`);
        }
    } catch (ocrErr) {
        const errMsg = ocrErr instanceof Error ? ocrErr.message : "OCR failed";
        console.error(`extractText failed: ${errMsg}`);
        await supabase.rpc("schedule_retry", {
            p_job_id: job.id,
            p_error: errMsg,
            p_stage: "ocr",
        });
        throw new Error(errMsg);
    }

    // Update document with OCR results
    const { error: ocrUpdateError } = await supabase
        .schema("warehouse")
        .from("documents")
        .update({
            ocr_text: extractedText,
            ocr_confidence: ocrConfidence,
            updated_at: new Date().toISOString(),
        })
        .eq("id", doc.id);

    if (ocrUpdateError) {
        console.error(`extractText failed (update): ${ocrUpdateError.message}`);
        await supabase.rpc("schedule_retry", {
            p_job_id: job.id,
            p_error: ocrUpdateError.message,
            p_stage: "ocr",
        });
        throw new Error(ocrUpdateError.message);
    }

    console.log("extractText complete: ocr_text and ocr_confidence saved");
    return extractedText;
}

// ─── 4. classifyDocument ─────────────────────────────────────────

async function classifyDocument(
    supabase: SupabaseClient,
    extractedText: string,
    doc: Doc,
    job: Job,
): Promise<Classification> {
    let classification: Classification = { doc_type: "unknown", doc_type_en: "unknown", language: "de", confidence: 0 };

    try {
        const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;
        const classifyResult = await callAnthropic({
            model: "claude-haiku-4-5-20251001",
            maxTokens: 200,
            apiKey: anthropicKey,
            callLabel: `classify-${doc.id}`,
            messages: [{
                role: "user",
                content: `You are classifying a document from a German Hausverwaltung (property management company).\nReturn the most specific German document type term.\nExamples: mietvertrag, mietvertragsnachtrag, nebenkostenabrechnung, mieterhöhung, kündigung, rechnung, grundsteuerbescheid, energieausweis, handwerkerrechnung, betriebskostenabrechnung, heizkostenabrechnung, wohnungsübergabeprotokoll, versicherungspolice, hausgeldabrechnung, mahnung, mietbescheinigung.\nIMPORTANT: If the text is short but contains an amount, price, or payment reference with a company or vendor name, classify as rechnung. Screenshots of payment confirmations, bank transactions, or ticket purchases are rechnung.\nmieterhoehung vs mietvertragsnachtrag: classify by WHAT the document changes, not its title. If the PRIMARY change is the Kaltmiete (rent amount) and the document is a unilateral landlord notice citing §558 (Vergleichsmieten) or §559 (Modernisierung), classify as mieterhöhung. If the document is a bilateral amendment (both parties sign) changing ANY term — including rent, but also deposit, ancillary costs, lease term, permitted use (pets/parking/subletting/commercial use), or party details (name change, co-tenant change) — classify as mietvertragsnachtrag. A document titled "Nachtrag" that only raises rent via §558 is still mieterhöhung. A document titled "Mieterhöhung" that actually changes parking rights is mietvertragsnachtrag. When the primary change is non-rent, always choose mietvertragsnachtrag.\nReturn ONLY valid JSON, no markdown, no explanation:\n{"doc_type":"<german_term>","doc_type_en":"<english_translation>","language":"de|en|mixed|unknown","confidence":0}\n\nDocument text:\n${extractedText.slice(0, 3000)}`,
            }],
        });

        const classifyText = classifyResult.content?.[0]?.text || "";
        const classifyMatch = classifyText.match(/\{[\s\S]*\}/);
        if (classifyMatch) {
            classification = JSON.parse(classifyMatch[0]);
        }

        console.log(`classifyDocument: classified as ${classification.doc_type} (${classification.language}, confidence: ${classification.confidence})`);
    } catch (classifyErr) {
        const errMsg = classifyErr instanceof Error ? classifyErr.message : "Classification failed";
        console.error(`classifyDocument failed: ${errMsg}`);
        await supabase.rpc("schedule_retry", {
            p_job_id: job.id,
            p_error: errMsg,
            p_stage: "extraction",
        });
        throw new Error(errMsg);
    }

    // Update document with classification
    const { error: classUpdateError } = await supabase
        .schema("warehouse")
        .from("documents")
        .update({
            doc_type: classification.doc_type,
            language: classification.language,
            updated_at: new Date().toISOString(),
        })
        .eq("id", doc.id);

    if (classUpdateError) {
        console.error(`classifyDocument failed (update): ${classUpdateError.message}`);
        await supabase.rpc("schedule_retry", {
            p_job_id: job.id,
            p_error: classUpdateError.message,
            p_stage: "extraction",
        });
        throw new Error(classUpdateError.message);
    }

    console.log("classifyDocument complete: doc_type and language saved");
    return classification;
}

// ─── 5. extractFields ────────────────────────────────────────────

async function extractFields(
    supabase: SupabaseClient,
    extractedText: string,
    classification: Classification,
    job: Job,
    // deno-lint-ignore no-explicit-any
): Promise<Record<string, any>> {
    // v2 path: skip Haiku entirely. No legacy extraction is written.
    // The v2 envelope will be written by Step 8b instead.
    if (hasV2Schema(classification.doc_type)) {
        console.log(`extractFields: skipping Haiku for v2 doc_type "${classification.doc_type}"`);
        return { _v2_skipped: true, confidence_score: 0, missing_fields: [] };
    }

    // deno-lint-ignore no-explicit-any
    let extractedFields: Record<string, any> = { confidence_score: 0, missing_fields: ["parse_error"] };

    const germanInstruction = "IMPORTANT: All free-text field values (description, summary, key_dates, key_amounts, missing_fields, condition_summary, damages, parties_mentioned, address_hint) MUST be written in German, even if the source document is in English.";

    const prompts: Record<string, string> = {
        invoice: `Extract from this German or English invoice.\n${germanInstruction}\nReturn ONLY valid JSON, no markdown, no explanation:\n{"vendor_name":"","amount":0,"currency":"EUR","invoice_date":"YYYY-MM-DD","invoice_number":null,"description":"","category_hint":"maintenance|utilities|insurance|management|cleaning|other","address_hint":null,"unit_hint":null,"confidence_score":0,"missing_fields":[]}\n\nDocument text:\n${extractedText.slice(0, 6000)}`,
        lease: `Extract from this German or English lease agreement.\n${germanInstruction}\nReturn ONLY valid JSON, no markdown, no explanation:\n{"tenant_first_name":"","tenant_last_name":"","tenant_email":null,"address_street":"","address_number":"","address_zip":"","address_city":"","unit_ref":"","rent_cold":0,"rent_warm":null,"deposit":null,"lease_start":"YYYY-MM-DD","lease_end":null,"confidence_score":0,"missing_fields":[]}\n\nDocument text:\n${extractedText.slice(0, 6000)}`,
        inspection_report: `Extract from this German or English inspection report.\n${germanInstruction}\nReturn ONLY valid JSON, no markdown, no explanation:\n{"inspection_date":"YYYY-MM-DD","unit_ref":null,"address_hint":null,"condition_summary":"","meter_readings":{"electricity":null,"gas":null,"water":null},"damages":[],"confidence_score":0,"missing_fields":[]}\n\nDocument text:\n${extractedText.slice(0, 6000)}`,
    };

    const defaultPrompt = `Extract any relevant property management fields.\n${germanInstruction}\nReturn ONLY valid JSON, no markdown, no explanation:\n{"summary":"","key_dates":[],"key_amounts":[],"parties_mentioned":[],"address_hint":null,"confidence_score":0,"missing_fields":[]}\n\nDocument text:\n${extractedText.slice(0, 6000)}`;

    try {
        const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;
        const promptKey = (DOC_TYPE_MAP[classification.doc_type] ?? DOC_TYPE_DEFAULT).extraction_prompt_key;
        const extractPrompt = prompts[promptKey] || defaultPrompt;

        const extractResult = await callAnthropic({
            model: "claude-haiku-4-5-20251001",
            maxTokens: 800,
            apiKey: anthropicKey,
            callLabel: `extract-fields-${job.document_id}`,
            messages: [{
                role: "user",
                content: extractPrompt,
            }],
        });

        const extractText = extractResult.content?.[0]?.text || "";
        const extractMatch = extractText.match(/\{[\s\S]*\}/);
        if (extractMatch) {
            extractedFields = JSON.parse(extractMatch[0]);
        }

        console.log(
            `extractFields: extracted ${Object.keys(extractedFields).length} fields ` +
            `(confidence: ${extractedFields.confidence_score ?? "unknown"})`
        );
    } catch (extractErr) {
        const errMsg = extractErr instanceof Error ? extractErr.message : "Extraction failed";
        console.error(`extractFields failed: ${errMsg}`);
        await supabase.rpc("schedule_retry", {
            p_job_id: job.id,
            p_error: errMsg,
            p_stage: "extraction",
        });
        throw new Error(errMsg);
    }

    console.log("extractFields complete: structured fields extracted");
    return extractedFields;
}

// ─── 6. categorize ───────────────────────────────────────────────

async function categorize(
    supabase: SupabaseClient,
    // deno-lint-ignore no-explicit-any
    extractedFields: Record<string, any>,
    classification: Classification,
    orgId: string,
    doc: Doc,
): Promise<CategorizeResult> {
    // 1. CATEGORISE via DOC_TYPE_MAP lookup
    const mapping = DOC_TYPE_MAP[classification.doc_type] ?? DOC_TYPE_DEFAULT;
    const category = mapping.category;
    const subcategory = mapping.subcategory;

    // 2. GET PROPERTY SHORT CODE via fuzzy address match
    let shortCode = "XXXXX";
    let propertyId: string | null = null;
    const addressHint = String(
        extractedFields.address_hint ??
        extractedFields.address_street ??
        ""
    ).trim();

    if (addressHint.length > 0) {
        // Take first meaningful word from address hint (street name)
        const firstWord = addressHint
            .replace(/[^a-zA-ZäöüÄÖÜß\s]/g, "")
            .split(/\s+/)
            .filter((w: string) => w.length > 2)[0];

        if (firstWord) {
            const { data: propRows } = await supabase
                .from("Property")
                .select("id, short_code, address")
                .eq("organizationId", orgId)
                .ilike("address", `%${firstWord}%`)
                .limit(1);

            if (propRows && propRows.length > 0) {
                shortCode = propRows[0].short_code || "XXXXX";
                propertyId = propRows[0].id;
            }
        }
    }

    // 3. GENERATE display_name — only for generic camera/scanner filenames
    const rawName = (doc.file_name ?? "").replace(/\.[^.]+$/, ""); // strip extension
    const isGenericName = /^(IMG_|image|document|scan)/i.test(rawName) || /^\d+$/.test(rawName);

    let displayName: string;
    if (isGenericName) {
        const dateSrc =
            extractedFields.invoice_date ??
            extractedFields.lease_start ??
            extractedFields.inspection_date ??
            null;
        const dateObj = dateSrc ? new Date(dateSrc) : new Date();
        const datePart = [
            dateObj.getFullYear(),
            String(dateObj.getMonth() + 1).padStart(2, "0"),
            String(dateObj.getDate()).padStart(2, "0"),
        ].join("");

        const vendorRaw = String(
            extractedFields.vendor_name ??
            extractedFields.tenant_last_name ??
            "Unbekannt"
        )
            .replace(/\s+/g, "-")
            .replace(/[^A-Za-z0-9äöüÄÖÜß-]/g, "")
            .slice(0, 20);

        // German translation map for category_hint
        const descMapDe: Record<string, string> = {
            utilities: "Betriebskosten",
            maintenance: "Instandhaltung",
            insurance: "Versicherung",
            management: "Verwaltung",
            cleaning: "Reinigung",
            other: "Sonstiges",
        };

        const language = classification.language ?? "de";
        const hintRaw = String(extractedFields.category_hint ?? classification.doc_type ?? "Dokument");
        const descResolved =
            language === "de" && descMapDe[hintRaw.toLowerCase()]
                ? descMapDe[hintRaw.toLowerCase()]
                : hintRaw;
        const descPart =
            descResolved.charAt(0).toUpperCase() +
            descResolved
                .slice(1)
                .replace(/\s+/g, "-")
                .replace(/[^A-Za-z0-9äöüÄÖÜß-]/g, "")
                .slice(0, 19);

        displayName = `${datePart}_${vendorRaw}_${shortCode}_${descPart}`
            .replace(/\s+/g, "-")
            .replace(/[^A-Za-z0-9äöüÄÖÜß_-]/g, "")
            .slice(0, 80);

        if (!displayName) displayName = `${datePart}_Dokument`;
    } else {
        displayName = doc.file_name;
    }

    // 4. CALCULATE retention_until
    const baseDate = extractedFields.invoice_date
        ? new Date(extractedFields.invoice_date)
        : new Date();
    const retentionYears = mapping.retention_years;
    const retentionDate = new Date(baseDate);
    retentionDate.setFullYear(retentionDate.getFullYear() + retentionYears);
    const retentionUntil = retentionDate.toISOString().split("T")[0];

    // 5. COST CLASS from COST_CLASS_MAP
    const costClass = COST_CLASS_MAP[classification.doc_type] ?? "nicht_zugeordnet";

    const metadata: CategorizeResult = {
        category,
        subcategory,
        display_name: displayName,
        retention_until: retentionUntil,
        property_id: propertyId,
        cost_class: costClass,
    };

    // Update the document
    try {
        const updatePayload: Record<string, unknown> = {
            display_name: metadata.display_name,
            category: metadata.category,
            subcategory: metadata.subcategory,
            retention_until: metadata.retention_until,
            cost_class: metadata.cost_class,
            updated_at: new Date().toISOString(),
        };
        if (metadata.property_id) {
            updatePayload.property_id = metadata.property_id;
        }

        const { error: metaUpdateError } = await supabase
            .schema("warehouse")
            .from("documents")
            .update(updatePayload)
            .eq("id", doc.id);

        if (metaUpdateError) {
            console.error(`categorize failed (update): ${metaUpdateError.message}`);
        } else {
            console.log(
                `categorize complete: category=${metadata.category}, ` +
                `display_name=${metadata.display_name}, ` +
                `property_id=${metadata.property_id ?? "none"}, ` +
                `cost_class=${metadata.cost_class}, ` +
                `retention=${metadata.retention_until}`
            );
        }
    } catch (metaErr) {
        const errMsg = metaErr instanceof Error ? metaErr.message : "Classify failed";
        console.error(`categorize failed: ${errMsg}`);
        // Non-fatal: continue pipeline even if classification fails
    }

    return metadata;
}

// ─── 7. storeExtraction ──────────────────────────────────────────

async function storeExtraction(
    supabase: SupabaseClient,
    job: Job,
    // deno-lint-ignore no-explicit-any
    extractedFields: Record<string, any>,
): Promise<string> {
    // Mark previous extractions as not current
    await supabase
        .schema("warehouse")
        .from("document_extractions")
        .update({ is_current: false })
        .eq("document_id", job.document_id);

    // Insert new extraction
    const { data: extraction, error: extractionError } = await supabase
        .schema("warehouse")
        .from("document_extractions")
        .insert({
            document_id: job.document_id,
            org_id: job.org_id,
            model: "claude-haiku-4-5-20251001",
            prompt_version: "v1.0",
            extracted_fields: extractedFields,
            confidence_score: extractedFields.confidence_score ?? 0,
            flags: extractedFields.missing_fields ?? [],
            is_current: true,
            created_at: new Date().toISOString(),
        })
        .select("id")
        .single();

    if (extractionError || !extraction) {
        const errMsg = extractionError?.message || "Failed to insert extraction";
        console.error(`storeExtraction failed: ${errMsg}`);
        await supabase.rpc("schedule_retry", {
            p_job_id: job.id,
            p_error: errMsg,
            p_stage: "storing",
        });
        throw new Error(errMsg);
    }

    console.log(`storeExtraction complete: extraction ${extraction.id} saved`);
    return extraction.id;
}

// ─── 8. matchEntities ────────────────────────────────────────────

async function matchEntities(
    supabase: SupabaseClient,
    job: Job,
    classification: Classification,
    // deno-lint-ignore no-explicit-any
    extractedFields: Record<string, any>,
    extractionId: string,
    // deno-lint-ignore no-explicit-any
): Promise<any[]> {
    // deno-lint-ignore no-explicit-any
    const allMatches: any[] = [];

    // deno-lint-ignore no-explicit-any
    async function resolveAndStore(entityType: string, fields: Record<string, unknown>): Promise<any> {
        try {
            const { data, error } = await supabase.rpc("resolve", {
                p_org_id: job.org_id,
                p_entity_type: entityType,
                p_fields: fields,
                p_confidence_threshold: 90.0,
            });

            if (error) {
                console.error(`matchEntities: resolve failed for ${entityType}:`, error.message);
                return null;
            }

            await supabase
                .schema("warehouse")
                .from("suggested_matches")
                .insert({
                    document_id: job.document_id,
                    extraction_id: extractionId,
                    org_id: job.org_id,
                    entity_type: entityType,
                    match_result: data,
                    confidence_score: data?.candidates?.[0]?.confidence ?? 0,
                    match_type: data?.match_type ?? "unresolved",
                });

            console.log(`matchEntities: resolved ${entityType} → ${data?.match_type ?? "unresolved"}`);
            return data;
        } catch (resolveErr) {
            console.error(`matchEntities: resolve error for ${entityType}:`, resolveErr);
            return null;
        }
    }

    const resolveKey = (DOC_TYPE_MAP[classification.doc_type] ?? DOC_TYPE_DEFAULT).extraction_prompt_key;

    try {
        if (resolveKey === "invoice") {
            if (extractedFields.address_hint) {
                const m = await resolveAndStore("property", {
                    address_street: extractedFields.address_hint,
                });
                if (m) allMatches.push(m);
            }

        } else if (resolveKey === "lease") {
            const propertyMatch = await resolveAndStore("property", {
                address_street: extractedFields.address_street,
                address_number: extractedFields.address_number,
                address_zip: extractedFields.address_zip,
            });
            if (propertyMatch) allMatches.push(propertyMatch);

            const unitMatch = await resolveAndStore("unit", {
                unit_ref: extractedFields.unit_ref,
                property_id: propertyMatch?.best_match?.pm_entity_id ?? null,
            });
            if (unitMatch) allMatches.push(unitMatch);

            const tenantMatch = await resolveAndStore("tenant", {
                tenant_name: `${extractedFields.tenant_first_name} ${extractedFields.tenant_last_name}`,
            });
            if (tenantMatch) allMatches.push(tenantMatch);

        } else if (resolveKey === "inspection_report") {
            const propMatch = await resolveAndStore("property", {
                address_street: extractedFields.address_hint,
            });
            if (propMatch) allMatches.push(propMatch);

            if (extractedFields.unit_ref) {
                const unitMatch = await resolveAndStore("unit", {
                    unit_ref: extractedFields.unit_ref,
                });
                if (unitMatch) allMatches.push(unitMatch);
            }
        }
        // For 'default' prompt key: skip resolve calls

        console.log(`matchEntities complete: ${allMatches.length} entity matches`);
    } catch (matchErr) {
        const errMsg = matchErr instanceof Error ? matchErr.message : "Matching failed";
        console.error(`matchEntities failed: ${errMsg}`);
        await supabase.rpc("schedule_retry", {
            p_job_id: job.id,
            p_error: errMsg,
            p_stage: "matching",
        });
        throw new Error(errMsg);
    }

    return allMatches;
}

// ─── 9. routeByConfidence ────────────────────────────────────────

async function routeByConfidence(
    supabase: SupabaseClient,
    job: Job,
    classification: Classification,
    // deno-lint-ignore no-explicit-any
    extractedFields: Record<string, any>,
    extractionId: string,
    // deno-lint-ignore no-explicit-any
    allMatches: any[],
): Promise<string> {
    const overallConfidence = allMatches.length > 0
        ? Math.min(...allMatches.map((m: { confidence_score?: number }) => m.confidence_score ?? 0))
        : (extractedFields.confidence_score ?? 0);

    const allExisting = allMatches.every(
        (m: { match_type?: string }) => m.match_type === "existing"
    );
    const hasAmbiguous = allMatches.some(
        (m: { match_type?: string }) => m.match_type === "ambiguous"
    );
    const hasNew = allMatches.some(
        (m: { match_type?: string }) => m.match_type === "new"
    );

    let finalStatus = "needs_review";
    const resolveKey = (DOC_TYPE_MAP[classification.doc_type] ?? DOC_TYPE_DEFAULT).extraction_prompt_key;

    if (overallConfidence >= 85 && allExisting && !hasNew) {
        // Auto-apply: high confidence, all entities exist
        const applyAction = resolveKey === "lease"
            ? "lease.create"
            : "ledger.append";

        const { error: applyError } = await supabase.rpc("apply", {
            p_org_id: job.org_id,
            p_document_id: job.document_id,
            p_extraction_id: extractionId,
            p_action: applyAction,
            p_payload: extractedFields,
            p_triggered_by: null,
            p_trigger_type: "auto",
            p_idempotency_key: `${job.document_id}_${extractionId}`,
        });

        if (applyError) {
            console.error(`routeByConfidence: apply failed: ${applyError.message}`);
        } else {
            finalStatus = "applied";
            console.log(`routeByConfidence: auto-applied (${applyAction})`);
        }

        await supabase
            .schema("warehouse")
            .from("documents")
            .update({ status: finalStatus, updated_at: new Date().toISOString() })
            .eq("id", job.document_id);

    } else if (overallConfidence >= 65 || hasAmbiguous) {
        // Needs review: moderate confidence or ambiguous matches
        finalStatus = "needs_review";

        await supabase
            .schema("warehouse")
            .from("review_tasks")
            .insert({
                document_id: job.document_id,
                org_id: job.org_id,
                reason: "Low confidence — please review",
                reason_code: "low_confidence",
                status: "open",
            });

        await supabase
            .schema("warehouse")
            .from("documents")
            .update({ status: "needs_review", updated_at: new Date().toISOString() })
            .eq("id", job.document_id);

        console.log("routeByConfidence: routed to review (low_confidence)");

    } else {
        // New asset or very low confidence
        finalStatus = "needs_review";

        await supabase
            .schema("warehouse")
            .from("review_tasks")
            .insert({
                document_id: job.document_id,
                org_id: job.org_id,
                reason: "New asset detected — please confirm",
                reason_code: "new_asset_detected",
                status: "open",
            });

        await supabase
            .schema("warehouse")
            .from("documents")
            .update({ status: "needs_review", updated_at: new Date().toISOString() })
            .eq("id", job.document_id);

        console.log("routeByConfidence: routed to review (new_asset_detected)");
    }

    return finalStatus;
}

// ─── 8b-v2. generateV2Envelope (FATAL on failure) ───────────

async function generateV2Envelope(
    supabase: SupabaseClient,
    job: Job,
    doc: Doc,
    classification: Classification,
): Promise<string> {
    const docType = classification.doc_type;
    const v2Config = V2_PROMPTS[docType];
    if (!v2Config) {
        throw new Error(`generateV2Envelope: no V2_PROMPTS config for doc_type "${docType}"`);
    }

    const ocrText = (doc.ocr_text ?? "").slice(0, 6000);
    if (!ocrText) {
        throw new Error("generateV2Envelope: no ocr_text available — cannot extract v2 envelope");
    }

    const extractionRunId = crypto.randomUUID();
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;

    // Build prompt: system instruction + schema prompt fragment + document text
    const fullPrompt = `Du bist ein präziser Dokumentenanalyse-Assistent für deutsche Hausverwaltung.
Analysiere das folgende Dokument und extrahiere die angeforderten Felder.
Antworte NUR mit validem JSON. Kein Markdown, keine Erklärung.

Das JSON muss ein Objekt sein, dessen Schlüssel die Feld-IDs sind.
Jedes Feld ist ein Objekt mit: raw_value, normalized_value, evidence (Array; jedes Element ist entweder ein direct_quote {quote, page, bbox} oder eine table_cell {evidence_type: "table_cell", page, table_cell: {row_anchor?, column_anchor, cell_value_raw, derivation_rule}}), confidence ("high"|"medium"|"low"), absence_state, validation_status ("valid"), severity.

${v2Config.prompt}

Dokumenttext:
${ocrText}`;

    // Call Sonnet via shared rate-limited client
    const result = await callAnthropic({
        model: "claude-sonnet-4-20250514",
        maxTokens: 3000,
        apiKey: anthropicKey,
        callLabel: `v2-envelope-${docType}-${job.document_id}`,
        messages: [{
            role: "user",
            content: fullPrompt,
        }],
    });

    const text = result.content?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
        console.error(`generateV2Envelope: raw response: ${text.slice(0, 500)}`);
        throw new Error("generateV2Envelope: Sonnet returned non-JSON response");
    }

    // deno-lint-ignore no-explicit-any
    let envelope: Record<string, any>;
    try {
        envelope = JSON.parse(match[0]);
    } catch (parseErr) {
        throw new Error(`generateV2Envelope: JSON parse failed: ${(parseErr as Error).message}`);
    }

    // Inject schema-declared severity into each field of the envelope (architecture §3.1:
    // "copied into extraction for eval"). Sonnet doesn't know what the schema says; the
    // pipeline copies severity from FIELD_DEFS so the validator can confirm it's correct.
    for (const [fieldId, fieldEnvelope] of Object.entries(envelope)) {
        if (fieldEnvelope && typeof fieldEnvelope === "object") {
            const fieldDef = v2Config.fieldSpecs[fieldId];
            if (fieldDef && fieldDef.severity) {
                (fieldEnvelope as Record<string, unknown>).severity = fieldDef.severity;
            }
        }
    }

    // Validate envelope shape
    try {
        v2Config.validate(envelope);
    } catch (validationErr) {
        console.error(`generateV2Envelope: envelope validation failed:`, (validationErr as Error).message);
        throw new Error(`generateV2Envelope: envelope validation failed: ${(validationErr as Error).message}`);
    }

    // Run verifiers per field
    const verifierRefs = V2_VERIFIER_REFS[docType] ?? {};
    for (const [fieldId, refs] of Object.entries(verifierRefs)) {
        const fieldEnvelope = envelope[fieldId] as FieldEnvelope | undefined;
        if (!fieldEnvelope || fieldEnvelope.absence_state !== "present") continue;

        const fieldSpec = v2Config.fieldSpecs[fieldId];
        if (!fieldSpec) continue;

        for (const ref of refs) {
            const verifier = VERIFIERS[ref];
            if (!verifier) {
                console.warn(`generateV2Envelope: unknown verifier ref "${ref}" for field "${fieldId}"`);
                continue;
            }

            try {
                const vResult = verifier({
                    ocr_text: ocrText,
                    field_spec: fieldSpec,
                    field_envelope: fieldEnvelope,
                });

                if (!vResult.passes) {
                    console.warn(
                        `generateV2Envelope: verifier "${ref}" failed for field "${fieldId}": ${vResult.reason}`
                    );
                    // Downgrade the field per architecture §10.2
                    fieldEnvelope.validation_status = ref === "monetary-verbatim"
                        ? "failed_verifier"
                        : "failed_format";
                    fieldEnvelope.confidence = "low";
                    // Override absence_state based on failure type
                    if (ref === "monetary-verbatim") {
                        fieldEnvelope.absence_state = "contradicted";
                    } else {
                        fieldEnvelope.absence_state = "ambiguous";
                    }
                    fieldEnvelope.verifier_failure = { ref, reason: vResult.reason };
                }
            } catch (verifierErr) {
                throw new Error(
                    `generateV2Envelope: verifier "${ref}" threw on field "${fieldId}": ${(verifierErr as Error).message}`
                );
            }
        }
    }

    // Build lifecycle from fields (Phase 1: minimal)
    const mietbeginn = envelope.mietbeginn?.normalized_value ?? null;
    const mietende = envelope.mietende?.normalized_value ?? null;
    const lifecycle = {
        issue_date: mietbeginn,
        effective_date: mietbeginn,
        signed_date: null,
        expiry_date: (mietende && envelope.mietende?.absence_state === "present") ? mietende : null,
        document_status: "active",
        supersedes_document_id: null,
        amended_by_document_id: null,
        lifecycle_evidence: null,
    };

    // Write to warehouse.document_extractions_v2
    const { error: insertError } = await supabase
        .schema("warehouse")
        .from("document_extractions_v2")
        .insert({
            source_document_id: job.document_id,
            doc_type: docType,
            schema_version: v2Config.schemaVersion,
            prompt_version: v2Config.schemaVersion,
            model: "claude-sonnet-4-20250514",
            extraction_run_id: extractionRunId,
            fields: envelope,
            lifecycle: lifecycle,
            human_review_status: "not_reviewed",
        });

    if (insertError) {
        throw new Error(`generateV2Envelope: insert to document_extractions_v2 failed: ${insertError.message}`);
    }

    // Flag property brain as stale
    if (job.property_id) {
        const { error: staleError } = await supabase
            .schema("warehouse")
            .from("property_intelligence")
            .update({ is_stale: true })
            .eq("property_id", job.property_id)
            .eq("is_current", true);

        if (staleError) {
            console.error(`generateV2Envelope: staleness flag failed: ${staleError.message}`);
            // Non-fatal: brain staleness is a convenience, not a correctness concern
        }
    }

    console.log(
        `generateV2Envelope complete: v2 envelope written for ${docType} ` +
        `(extraction_run_id=${extractionRunId}, schema_version=${v2Config.schemaVersion})`
    );

    return extractionRunId;
}

// ─── 8b. generateIntelligence (NON-FATAL) ────────────────────

async function generateIntelligence(
    supabase: SupabaseClient,
    job: Job,
    doc: Doc,
    classification: Classification,
    // deno-lint-ignore no-explicit-any
    extractedFields: Record<string, any>,
): Promise<void> {
    try {
        const ocrText = (doc.ocr_text ?? "").slice(0, 4000);
        if (!ocrText) {
            console.log("generateIntelligence: no ocr_text, skipping");
            return;
        }

        const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;
        const contextBlock = JSON.stringify({
            doc_type: classification.doc_type,
            extracted_fields: extractedFields,
        });

        const docTypeFragment = STRUCTURED_PROMPTS[classification.doc_type]?.() ?? "";

        const result = await callAnthropic({
            model: "claude-sonnet-4-20250514",
            maxTokens: 1500,
            apiKey: anthropicKey,
            callLabel: `intelligence-${job.document_id}`,
            messages: [{
                role: "user",
                content: `Du bist ein deutscher Hausverwaltungs-Assistent. Analysiere dieses Dokument. Antworte NUR mit validem JSON:\n{"summary":"2-3 Sätze","tags":[],"entity_name":"Hauptperson/Firma","entity_type":"mieter|vermieter|dienstleister|behoerde|versicherung|bank|notar|sonstiges","unit_ref":"EG|1.OG|DG|Keller|null","period_start":"YYYY-MM-DD|null","period_end":"YYYY-MM-DD|null","action_signals":[],"viewer_safe":true,"cost_class":"betriebskosten|erwerbskosten|abrechnung|finanzierung|mieteingang|nicht_immobilien|nicht_zugeordnet","umlagefaehig":true|false|null,"structured_fields":null}\n\ncost_class: Klassifiziere die Kostenart. nicht_zugeordnet wenn unklar.\numlagefaehig: true wenn Kosten nach BetrKV auf Mieter umlegbar (Grundsteuer, Wasser, Abwasser, Müllabfuhr, Versicherung, Schornsteinfeger, Winterdienst, Hausmeister, Gartenpflege, Aufzug, Gemeinschaftsstrom, Kabelanschluss). false wenn nicht umlegbar (Instandhaltung, Reparaturen, Verwaltungskosten). null wenn kein Kostendokument.\n${docTypeFragment ? "\n" + docTypeFragment + "\n" : ""}\nKontext: ${contextBlock}\n\nDokumenttext:\n${ocrText}`,
            }],
        });

        const text = result.content?.[0]?.text || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            console.error("generateIntelligence: no JSON in response");
            return;
        }

        const intel = JSON.parse(match[0]);
        const structuredFields = intel.structured_fields ?? null;

        // Diff protection: don't overwrite richer structured_fields
        const { data: existingRows } = await supabase
            .schema("warehouse")
            .from("document_intelligence")
            .select("structured_fields")
            .eq("document_id", job.document_id)
            .eq("is_current", true)
            .limit(1);

        if (existingRows?.[0]?.structured_fields && structuredFields) {
            const existingKeys = Object.keys(existingRows[0].structured_fields).filter(
                (k) => existingRows[0].structured_fields[k] != null,
            );
            const newKeys = Object.keys(structuredFields).filter(
                (k) => structuredFields[k] != null,
            );
            if (existingKeys.length > newKeys.length) {
                console.warn(
                    `generateIntelligence: existing structured_fields has ${existingKeys.length} populated keys vs ${newKeys.length} new — skipping insert to protect richer data`,
                );
                return;
            }
        }

        // Mark previous intelligence rows as not current
        await supabase
            .schema("warehouse")
            .from("document_intelligence")
            .update({ is_current: false })
            .eq("document_id", job.document_id);

        // Insert new intelligence
        const { error: insertError } = await supabase
            .schema("warehouse")
            .from("document_intelligence")
            .insert({
                document_id: job.document_id,
                org_id: job.org_id,
                summary: intel.summary ?? "",
                tags: intel.tags ?? [],
                entity_name: intel.entity_name ?? null,
                entity_type: intel.entity_type ?? null,
                unit_ref: intel.unit_ref ?? null,
                period_start: intel.period_start ?? null,
                period_end: intel.period_end ?? null,
                action_signals: intel.action_signals ?? [],
                viewer_safe: intel.viewer_safe ?? true,
                cost_class: intel.cost_class ?? null,
                umlagefaehig: intel.umlagefaehig ?? null,
                structured_fields: structuredFields,
                is_current: true,
            });

        if (insertError) {
            console.error(`generateIntelligence: insert failed: ${insertError.message}`);
            return;
        }

        // Flag property brain as stale so it gets regenerated
        const { error: staleError } = await supabase
            .schema("warehouse")
            .from("property_intelligence")
            .update({ is_stale: true })
            .eq("property_id", job.property_id)
            .eq("is_current", true);

        if (staleError) {
            console.error(`generateIntelligence: staleness flag failed: ${staleError.message}`);
        }

        console.log(`generateIntelligence complete: summary=${(intel.summary ?? "").slice(0, 60)}...`);
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Intelligence generation failed";
        console.error(`generateIntelligence failed (non-fatal): ${errMsg}`);
        // NON-FATAL: do not throw, do not retry — pipeline continues
    }
}

// ─── 10. completeJob ─────────────────────────────────────────────

async function completeJob(supabase: SupabaseClient, job: Job): Promise<void> {
    await supabase
        .schema("warehouse")
        .from("processing_jobs")
        .update({ status: "done", updated_at: new Date().toISOString() })
        .eq("id", job.id);

    console.log(`completeJob: job ${job.id} marked as done`);
}

// ─── Main pipeline ──────────────────────────────────────────────

serve(async (req: Request) => {
    if (req.method !== "POST") {
        return new Response(
            JSON.stringify({ error: "Method not allowed" }),
            { status: 405, headers: { "Content-Type": "application/json" } }
        );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        // 1. Claim job
        const job = await claimJob(supabase);
        if (!job) {
            return new Response(
                JSON.stringify({ message: "no jobs" }),
                { status: 200, headers: { "Content-Type": "application/json" } }
            );
        }
        console.log(`Processing job ${job.id} for document ${job.document_id}`);

        // 2. Fetch document + file
        const { doc, fileBuffer } = await fetchDocument(supabase, job);

        // 3. Extract text (OCR)
        const extractedText = await extractText(supabase, doc, fileBuffer, job);

        // 4. Classify document type
        const classification = await classifyDocument(supabase, extractedText, doc, job);

        // 5. Extract structured fields (skipped for v2 doc types)
        const fields = await extractFields(supabase, extractedText, classification, job);
        const isV2 = hasV2Schema(classification.doc_type);

        // 6. Categorize, name, retention (runs for both paths)
        await categorize(supabase, fields, classification, job.org_id, doc);

        let finalStatus = "needs_review";
        let step9ApplyStatus: string | undefined;

        if (isV2) {
            // ── v2 path: Sonnet envelope → document_extractions_v2 ──
            // Step 7/8/9 legacy skipped. Step 8b-v2 replaces them.
            // FATAL on failure — do NOT fall back to legacy extraction.
            const extractionRunId = await generateV2Envelope(supabase, job, doc, classification);

            // --- Step 9: bridge to Node-side emitter + applier -----------------------
            // After the v2 envelope is committed, POST to the Node API route which
            // loads the emitter, produces claims, and runs the applier. Phase 1
            // failure mode: if the bridge call fails, log and proceed — the envelope
            // persists; a manual retry script can replay later.

            let applyResult: unknown = null;
            let applyStatus = "skipped_no_url";

            const appUrl = Deno.env.get("NEXT_PUBLIC_APP_URL");
            const internalSecret = Deno.env.get("PIPELINE_INTERNAL_SECRET");

            if (appUrl && internalSecret) {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s hard cap
                try {
                    const bridgeRes = await fetch(`${appUrl}/api/pipeline/apply-emission`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "x-internal-secret": internalSecret,
                        },
                        body: JSON.stringify({ extraction_run_id: extractionRunId }),
                        signal: controller.signal,
                    });
                    clearTimeout(timeoutId);
                    const bridgeBody = await bridgeRes.json();
                    if (!bridgeRes.ok) {
                        applyStatus = "bridge_http_error";
                        applyResult = { http_status: bridgeRes.status, body: bridgeBody };
                        console.warn("[step9] bridge HTTP error", bridgeRes.status, bridgeBody);
                    } else {
                        applyStatus = bridgeBody.status;
                        applyResult = bridgeBody;
                    }
                } catch (err) {
                    clearTimeout(timeoutId);
                    const isTimeout = (err as Error)?.name === "AbortError";
                    applyStatus = isTimeout ? "bridge_timeout" : "bridge_network_error";
                    applyResult = { error: String(err) };
                    console.warn(`[step9] ${applyStatus}`, err);
                }
            } else {
                console.warn("[step9] NEXT_PUBLIC_APP_URL or PIPELINE_INTERNAL_SECRET missing; skipping apply");
            }

            // Route v2 documents to needs_review (triage UI dual-read is Task 1.6)
            await supabase
                .schema("warehouse")
                .from("documents")
                .update({ status: "needs_review", updated_at: new Date().toISOString() })
                .eq("id", job.document_id);

            await supabase
                .schema("warehouse")
                .from("review_tasks")
                .insert({
                    document_id: job.document_id,
                    org_id: job.org_id,
                    reason: "v2 extraction — review envelope",
                    reason_code: "v2_extraction",
                    status: "open",
                });

            console.log(`[step9] apply_status=${applyStatus}`, JSON.stringify(applyResult));
            step9ApplyStatus = applyStatus;

            finalStatus = "needs_review";
        } else {
            // ── Legacy path: unchanged for non-v2 doc types ──

            // 7. Store extraction
            const extractionId = await storeExtraction(supabase, job, fields);

            // 8. Match entities
            const allMatches = await matchEntities(supabase, job, classification, fields, extractionId);

            // 9. Route by confidence
            finalStatus = await routeByConfidence(supabase, job, classification, fields, extractionId, allMatches);

            // 9b. Generate intelligence (non-fatal)
            await generateIntelligence(supabase, job, doc, classification, fields);
        }

        // 10. Complete job
        await completeJob(supabase, job);

        return new Response(
            JSON.stringify({
                message: "processed",
                job_id: job.id,
                document_id: job.document_id,
                doc_type: classification.doc_type,
                path: isV2 ? "v2_envelope" : "legacy",
                status: finalStatus,
                ...(step9ApplyStatus ? { step9_apply_status: step9ApplyStatus } : {}),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
        );
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        console.error("Pipeline error:", errMsg);

        return errorResponse(errMsg);
    }
});
