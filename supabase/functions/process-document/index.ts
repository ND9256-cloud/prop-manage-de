import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

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

// ─── classifyAndName helper ─────────────────────────────────────
async function classifyAndName(
    supabase: SupabaseClient,
    // deno-lint-ignore no-explicit-any
    extractedFields: Record<string, any>,
    docType: string,
    orgId: string,
    language: string,
): Promise<{
    category: string;
    subcategory: string | null;
    display_name: string;
    retention_until: string;
    property_id: string | null;
}> {
    // 1. CATEGORISE via DOC_TYPE_MAP lookup
    const mapping = DOC_TYPE_MAP[docType] ?? DOC_TYPE_DEFAULT;
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

    // 3. GENERATE display_name
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

    const hintRaw = String(extractedFields.category_hint ?? docType ?? "Dokument");
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

    let displayName = `${datePart}_${vendorRaw}_${shortCode}_${descPart}`
        .replace(/\s+/g, "-")
        .replace(/[^A-Za-z0-9äöüÄÖÜß_-]/g, "")
        .slice(0, 80);

    // Ensure it's not empty
    if (!displayName) displayName = `${datePart}_Dokument`;

    // 4. CALCULATE retention_until
    const baseDate = extractedFields.invoice_date
        ? new Date(extractedFields.invoice_date)
        : new Date();
    const retentionYears = mapping.retention_years;
    const retentionDate = new Date(baseDate);
    retentionDate.setFullYear(retentionDate.getFullYear() + retentionYears);
    const retentionUntil = retentionDate.toISOString().split("T")[0];

    return {
        category,
        subcategory,
        display_name: displayName,
        retention_until: retentionUntil,
        property_id: propertyId,
    };
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

    // Helper: chunked base64 encoding (avoids stack overflow on large files)
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

    try {
        // Step 1: Claim a queued job via RPC (FOR UPDATE SKIP LOCKED)
        const { data: job, error: claimError } = await supabase.rpc("claim_next_job");

        if (claimError) {
            console.error("Error claiming job:", claimError.message);
            return new Response(
                JSON.stringify({ error: claimError.message }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
        }

        if (!job) {
            return new Response(
                JSON.stringify({ message: "no jobs" }),
                { status: 200, headers: { "Content-Type": "application/json" } }
            );
        }

        console.log(`Processing job ${job.id} for document ${job.document_id}`);

        // Step 2: Fetch document metadata and download file
        const { data: doc, error: docError } = await supabase
            .schema("warehouse")
            .from("documents")
            .select("*")
            .eq("id", job.document_id)
            .single();

        if (docError || !doc) {
            const errMsg = docError?.message || "Document not found";
            console.error(`Step 2 failed (fetch doc): ${errMsg}`);
            await supabase.rpc("schedule_retry", {
                p_job_id: job.id,
                p_error: errMsg,
                p_stage: "download",
            });
            return new Response(
                JSON.stringify({ error: errMsg, job_id: job.id }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
        }

        const { data: signedUrlData, error: signedUrlError } = await supabase.storage
            .from("property-documents")
            .createSignedUrl(doc.storage_path, 60);

        if (signedUrlError || !signedUrlData?.signedUrl) {
            const errMsg = signedUrlError?.message || "Failed to create signed URL";
            console.error(`Step 2 failed (signed URL): ${errMsg}`);
            await supabase.rpc("schedule_retry", {
                p_job_id: job.id,
                p_error: errMsg,
                p_stage: "download",
            });
            return new Response(
                JSON.stringify({ error: errMsg, job_id: job.id }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
        }

        const fileResponse = await fetch(signedUrlData.signedUrl);
        if (!fileResponse.ok) {
            const errMsg = `File download failed: HTTP ${fileResponse.status}`;
            console.error(`Step 2 failed: ${errMsg}`);
            await supabase.rpc("schedule_retry", {
                p_job_id: job.id,
                p_error: errMsg,
                p_stage: "download",
            });
            return new Response(
                JSON.stringify({ error: errMsg, job_id: job.id }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
        }

        const fileBuffer = await fileResponse.arrayBuffer();
        console.log(`Step 2 complete: downloaded ${fileBuffer.byteLength} bytes (${doc.mime_type})`);

        // Step 3: Extract text from file
        let extractedText = "";
        let ocrConfidence = 0;

        try {
            if (doc.mime_type === "application/pdf") {
                const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;
                const base64Pdf = arrayBufferToBase64(fileBuffer);

                const pdfResponse = await fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: {
                        "x-api-key": anthropicKey,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({
                        model: "claude-haiku-4-5-20251001",
                        max_tokens: 4000,
                        messages: [{
                            role: "user",
                            content: [
                                {
                                    type: "document",
                                    source: {
                                        type: "base64",
                                        media_type: "application/pdf",
                                        data: base64Pdf,
                                    },
                                },
                                {
                                    type: "text",
                                    text: "Extract all text from this PDF document. Return only the raw text content, preserving the original structure. No commentary.",
                                },
                            ],
                        }],
                    }),
                });

                if (!pdfResponse.ok) {
                    throw new Error(`Claude PDF API error: ${pdfResponse.status} ${await pdfResponse.text()}`);
                }

                const pdfResult = await pdfResponse.json();
                extractedText = pdfResult.content?.[0]?.text || "";
                ocrConfidence = 90;
                console.log(`Step 3: PDF text extracted via Claude (${extractedText.length} chars)`);

            } else if (doc.mime_type.startsWith("image/")) {
                const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;
                const base64Data = arrayBufferToBase64(fileBuffer);

                const visionResponse = await fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: {
                        "x-api-key": anthropicKey,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({
                        model: "claude-haiku-4-5-20251001",
                        max_tokens: 2000,
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
                    }),
                });

                if (!visionResponse.ok) {
                    throw new Error(`Claude vision API error: ${visionResponse.status} ${await visionResponse.text()}`);
                }

                const visionResult = await visionResponse.json();
                extractedText = visionResult.content?.[0]?.text || "";
                ocrConfidence = 85;
                console.log(`Step 3: image OCR extracted (${extractedText.length} chars)`);

            } else {
                extractedText = "";
                ocrConfidence = 0;
                console.log(`Step 3: unsupported mime type ${doc.mime_type}, skipping OCR`);
            }
        } catch (ocrErr) {
            const errMsg = ocrErr instanceof Error ? ocrErr.message : "OCR failed";
            console.error(`Step 3 failed: ${errMsg}`);
            await supabase.rpc("schedule_retry", {
                p_job_id: job.id,
                p_error: errMsg,
                p_stage: "ocr",
            });
            return new Response(
                JSON.stringify({ error: errMsg, job_id: job.id }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
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
            console.error(`Step 3 failed (update): ${ocrUpdateError.message}`);
            await supabase.rpc("schedule_retry", {
                p_job_id: job.id,
                p_error: ocrUpdateError.message,
                p_stage: "ocr",
            });
            return new Response(
                JSON.stringify({ error: ocrUpdateError.message, job_id: job.id }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
        }

        console.log("Step 3 complete: ocr_text and ocr_confidence saved");

        // Step 4: Classify document type via Claude Haiku (open taxonomy)
        // deno-lint-ignore no-explicit-any
        let classification: any = { doc_type: "unknown", doc_type_en: "unknown", language: "de", confidence: 0 };

        try {
            const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;
            const classifyResponse = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "x-api-key": anthropicKey,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: "claude-haiku-4-5-20251001",
                    max_tokens: 200,
                    messages: [{
                        role: "user",
                        content: `You are classifying a document from a German Hausverwaltung (property management company).\nReturn the most specific German document type term.\nExamples: mietvertrag, nebenkostenabrechnung, mieterhöhung, kündigung, rechnung, grundsteuerbescheid, energieausweis, handwerkerrechnung, betriebskostenabrechnung, heizkostenabrechnung, wohnungsübergabeprotokoll, versicherungspolice, hausgeldabrechnung, mahnung, mietbescheinigung.\nReturn ONLY valid JSON, no markdown, no explanation:\n{"doc_type":"<german_term>","doc_type_en":"<english_translation>","language":"de|en|mixed|unknown","confidence":0}\n\nDocument text:\n${extractedText.slice(0, 3000)}`,
                    }],
                }),
            });

            if (!classifyResponse.ok) {
                throw new Error(`Claude classify API error: ${classifyResponse.status} ${await classifyResponse.text()}`);
            }

            const classifyResult = await classifyResponse.json();
            const classifyText = classifyResult.content?.[0]?.text || "";
            const classifyMatch = classifyText.match(/\{[\s\S]*\}/);
            if (classifyMatch) {
                classification = JSON.parse(classifyMatch[0]);
            }

            console.log(`Step 4: classified as ${classification.doc_type} (${classification.language}, confidence: ${classification.confidence})`);
        } catch (classifyErr) {
            const errMsg = classifyErr instanceof Error ? classifyErr.message : "Classification failed";
            console.error(`Step 4 failed: ${errMsg}`);
            await supabase.rpc("schedule_retry", {
                p_job_id: job.id,
                p_error: errMsg,
                p_stage: "extraction",
            });
            return new Response(
                JSON.stringify({ error: errMsg, job_id: job.id }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
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
            console.error(`Step 4 failed (update): ${classUpdateError.message}`);
            await supabase.rpc("schedule_retry", {
                p_job_id: job.id,
                p_error: classUpdateError.message,
                p_stage: "extraction",
            });
            return new Response(
                JSON.stringify({ error: classUpdateError.message, job_id: job.id }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
        }

        console.log("Step 4 complete: doc_type and language saved");

        // Step 5: Extract structured fields via Claude Haiku
        // deno-lint-ignore no-explicit-any
        let extractedFields: any = { confidence_score: 0, missing_fields: ["parse_error"] };

        const prompts: Record<string, string> = {
            invoice: `Extract from this German or English invoice.\nReturn ONLY valid JSON, no markdown, no explanation:\n{"vendor_name":"","amount":0,"currency":"EUR","invoice_date":"YYYY-MM-DD","invoice_number":null,"description":"","category_hint":"maintenance|utilities|insurance|management|cleaning|other","address_hint":null,"unit_hint":null,"confidence_score":0,"missing_fields":[]}\n\nDocument text:\n${extractedText.slice(0, 6000)}`,
            lease: `Extract from this German or English lease agreement.\nReturn ONLY valid JSON, no markdown, no explanation:\n{"tenant_first_name":"","tenant_last_name":"","tenant_email":null,"address_street":"","address_number":"","address_zip":"","address_city":"","unit_ref":"","rent_cold":0,"rent_warm":null,"deposit":null,"lease_start":"YYYY-MM-DD","lease_end":null,"confidence_score":0,"missing_fields":[]}\n\nDocument text:\n${extractedText.slice(0, 6000)}`,
            inspection_report: `Extract from this German or English inspection report.\nReturn ONLY valid JSON, no markdown, no explanation:\n{"inspection_date":"YYYY-MM-DD","unit_ref":null,"address_hint":null,"condition_summary":"","meter_readings":{"electricity":null,"gas":null,"water":null},"damages":[],"confidence_score":0,"missing_fields":[]}\n\nDocument text:\n${extractedText.slice(0, 6000)}`,
        };

        const defaultPrompt = `Extract any relevant property management fields.\nReturn ONLY valid JSON, no markdown, no explanation:\n{"summary":"","key_dates":[],"key_amounts":[],"parties_mentioned":[],"address_hint":null,"confidence_score":0,"missing_fields":[]}\n\nDocument text:\n${extractedText.slice(0, 6000)}`;

        try {
            const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;
            const promptKey = (DOC_TYPE_MAP[classification.doc_type] ?? DOC_TYPE_DEFAULT).extraction_prompt_key;
            const extractPrompt = prompts[promptKey] || defaultPrompt;

            const extractResponse = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "x-api-key": anthropicKey,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: "claude-haiku-4-5-20251001",
                    max_tokens: 800,
                    messages: [{
                        role: "user",
                        content: extractPrompt,
                    }],
                }),
            });

            if (!extractResponse.ok) {
                throw new Error(`Claude extract API error: ${extractResponse.status} ${await extractResponse.text()}`);
            }

            const extractResult = await extractResponse.json();
            const extractText = extractResult.content?.[0]?.text || "";
            const extractMatch = extractText.match(/\{[\s\S]*\}/);
            if (extractMatch) {
                extractedFields = JSON.parse(extractMatch[0]);
            }

            console.log(
                `Step 5: extracted ${Object.keys(extractedFields).length} fields ` +
                `(confidence: ${extractedFields.confidence_score ?? "unknown"})`
            );
        } catch (extractErr) {
            const errMsg = extractErr instanceof Error ? extractErr.message : "Extraction failed";
            console.error(`Step 5 failed: ${errMsg}`);
            await supabase.rpc("schedule_retry", {
                p_job_id: job.id,
                p_error: errMsg,
                p_stage: "extraction",
            });
            return new Response(
                JSON.stringify({ error: errMsg, job_id: job.id }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
        }

        console.log("Step 5 complete: structured fields extracted");

        // Step 5b: Classify, auto-name, and set retention
        try {
            const metadata = await classifyAndName(
                supabase,
                extractedFields,
                classification.doc_type,
                job.org_id,
                classification.language ?? "de",
            );

            const updatePayload: Record<string, unknown> = {
                display_name: metadata.display_name,
                category: metadata.category,
                subcategory: metadata.subcategory,
                retention_until: metadata.retention_until,
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
                console.error(`Step 5b failed (update): ${metaUpdateError.message}`);
            } else {
                console.log(
                    `Step 5b complete: category=${metadata.category}, ` +
                    `display_name=${metadata.display_name}, ` +
                    `property_id=${metadata.property_id ?? "none"}, ` +
                    `retention=${metadata.retention_until}`
                );
            }
        } catch (metaErr) {
            const errMsg = metaErr instanceof Error ? metaErr.message : "Classify failed";
            console.error(`Step 5b failed: ${errMsg}`);
            // Non-fatal: continue pipeline even if classification fails
        }

        // Step 6: Store extraction result in database
        // 6a. Mark previous extractions as not current
        await supabase
            .schema("warehouse")
            .from("document_extractions")
            .update({ is_current: false })
            .eq("document_id", job.document_id);

        // 6b. Insert new extraction
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
            console.error(`Step 6 failed: ${errMsg}`);
            await supabase.rpc("schedule_retry", {
                p_job_id: job.id,
                p_error: errMsg,
                p_stage: "storing",
            });
            return new Response(
                JSON.stringify({ error: errMsg, job_id: job.id }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
        }

        const extractionId = extraction.id;
        console.log(`Step 6 complete: extraction ${extractionId} saved`);

        // Step 7: Entity matching via connector.resolve()
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
                    console.error(`Step 7: resolve failed for ${entityType}:`, error.message);
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

                console.log(`Step 7: resolved ${entityType} → ${data?.match_type ?? "unresolved"}`);
                return data;
            } catch (resolveErr) {
                console.error(`Step 7: resolve error for ${entityType}:`, resolveErr);
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

            console.log(`Step 7 complete: ${allMatches.length} entity matches`);
        } catch (matchErr) {
            const errMsg = matchErr instanceof Error ? matchErr.message : "Matching failed";
            console.error(`Step 7 failed: ${errMsg}`);
            await supabase.rpc("schedule_retry", {
                p_job_id: job.id,
                p_error: errMsg,
                p_stage: "matching",
            });
            return new Response(
                JSON.stringify({ error: errMsg, job_id: job.id }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
        }

        // Step 8: Route by confidence
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
                console.error(`Step 8: apply failed: ${applyError.message}`);
            } else {
                finalStatus = "applied";
                console.log(`Step 8: auto-applied (${applyAction})`);
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

            console.log("Step 8: routed to review (low_confidence)");

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

            console.log("Step 8: routed to review (new_asset_detected)");
        }

        // Step 9: Mark job as done
        await supabase
            .schema("warehouse")
            .from("processing_jobs")
            .update({ status: "done", updated_at: new Date().toISOString() })
            .eq("id", job.id);

        console.log(`Step 9: job ${job.id} marked as done`);

        return new Response(
            JSON.stringify({
                message: "processed",
                job_id: job.id,
                document_id: job.document_id,
                doc_type: classification.doc_type,
                confidence: overallConfidence,
                status: finalStatus,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
        );
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        console.error("Pipeline error:", errMsg);

        return new Response(
            JSON.stringify({ error: errMsg }),
            { status: 500, headers: { "Content-Type": "application/json" } }
        );
    }
});
