// Sonnet Step 8b extractor — Node-callable mirror of generateV2Envelope.
//
// Why this exists: the production extractor lives in supabase/functions/
// process-document/index.ts and runs in Deno. It is reachable only via
// HTTP (the Edge Function entry point) and is wired into a job/queue
// model that the eval harness does not need. To grade extraction quality
// from a Node script, we re-host the core extraction logic — prompt
// build, JSON parse, schema validation, verifier sweep, lifecycle build —
// against the same prompt fragments, validator, and verifier modules
// the production function uses.
//
// What is shared with production (single source of truth):
//   - schemas/<doc_type>/generated/prompt_fragment.ts (PROMPT_FRAGMENT, SCHEMA_VERSION)
//   - schemas/<doc_type>/generated/envelope_validator.ts (validateEnvelope)
//   - supabase/functions/process-document/verifiers/* (VERIFIERS, types)
//
// What is intentionally duplicated:
//   - The V2_CONFIGS table (field specs + verifier refs). This is a
//     short hand-maintained mapping. If the production index.ts ever
//     starts driving these from the generated schema files, this file
//     should switch to that source.
//   - The system-instruction wrapper around PROMPT_FRAGMENT. It is
//     short and stable; if it ever drifts, drift it in both places.
//
// What is intentionally NOT here:
//   - Persistence to warehouse.document_extractions_v2 (eval writes
//     candidate envelopes to a local --out directory instead).
//   - Property-intelligence staleness flagging (no warehouse side effects).
//   - OCR. The eval harness consumes a pre-extracted source.txt; OCR is
//     handled by the production pipeline (steps 3 + 3a) before extraction.

import Anthropic from "@anthropic-ai/sdk";

import { PROMPT_FRAGMENT as MIETVERTRAG_PROMPT, SCHEMA_VERSION as MIETVERTRAG_SCHEMA_VERSION } from "../../schemas/mietvertrag/generated/prompt_fragment.ts";
import { validateEnvelope as validateMietvertragEnvelope } from "../../schemas/mietvertrag/generated/envelope_validator.ts";
import { VERIFIERS } from "../../supabase/functions/process-document/verifiers/index.ts";
import type { FieldSpec, FieldEnvelope as VerifierFieldEnvelope } from "../../supabase/functions/process-document/verifiers/types.ts";

import type { ExtractionEnvelope, FieldEnvelope } from "./types.ts";

// Pin to the same Sonnet model the production extractor uses (architecture §4).
// Opus is reserved for 4.5 (model diversity); Sonnet is the launch baseline.
export const SONNET_MODEL = "claude-sonnet-4-20250514";

// Matches the production OCR slice (process-document/index.ts:925).
const MAX_OCR_CHARS = 6000;

const MAX_OUTPUT_TOKENS = 3000;

interface V2Config {
  prompt: string;
  schemaVersion: string;
  validate: (data: unknown) => void;
  fieldSpecs: Record<string, FieldSpec>;
  verifierRefs: Record<string, string[]>;
}

// Mirror of V2_PROMPTS + V2_VERIFIER_REFS in supabase/functions/process-document/index.ts.
const V2_CONFIGS: Record<string, V2Config> = {
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
    verifierRefs: {
      kaltmiete: ["monetary-verbatim"],
      unit_ref: ["enum"],
      mietbeginn: ["date-format"],
      mietende: ["date-format"],
      nebenkostenvorauszahlung: ["monetary-verbatim"],
      kaution: ["monetary-verbatim"],
    },
  },
};

export function supportedDocTypes(): string[] {
  return Object.keys(V2_CONFIGS);
}

export function hasExtractorFor(docType: string): boolean {
  return Object.prototype.hasOwnProperty.call(V2_CONFIGS, docType);
}

// Dependency seam: the extractor takes a function that maps a prompt
// to Sonnet's raw response text. Live runs inject an Anthropic-backed
// implementation; tests inject a deterministic mock.
export interface ExtractorDeps {
  callSonnet(prompt: string): Promise<string>;
}

export function buildPrompt(ocrText: string, docType: string): string {
  const cfg = V2_CONFIGS[docType];
  if (!cfg) throw new Error(`extractor: no V2 config for doc_type "${docType}"`);
  const trimmed = ocrText.slice(0, MAX_OCR_CHARS);
  // Verbatim wrapper from process-document/index.ts:934-944.
  return `Du bist ein präziser Dokumentenanalyse-Assistent für deutsche Hausverwaltung.
Analysiere das folgende Dokument und extrahiere die angeforderten Felder.
Antworte NUR mit validem JSON. Kein Markdown, keine Erklärung.

Das JSON muss ein Objekt sein, dessen Schlüssel die Feld-IDs sind.
Jedes Feld ist ein Objekt mit: raw_value, normalized_value, evidence (Array von {quote, page, bbox}), confidence ("high"|"medium"|"low"), absence_state, validation_status ("valid"), severity.

${cfg.prompt}

Dokumenttext:
${trimmed}`;
}

export async function extractEnvelope(
  ocrText: string,
  docType: string,
  deps: ExtractorDeps,
): Promise<ExtractionEnvelope> {
  const cfg = V2_CONFIGS[docType];
  if (!cfg) throw new Error(`extractor: no V2 config for doc_type "${docType}"`);

  const prompt = buildPrompt(ocrText, docType);
  const text = await deps.callSonnet(prompt);

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`extractor: Sonnet returned non-JSON response (first 200 chars: ${text.slice(0, 200)})`);

  let fields: Record<string, FieldEnvelope>;
  try {
    fields = JSON.parse(match[0]) as Record<string, FieldEnvelope>;
  } catch (e) {
    throw new Error(`extractor: JSON parse failed: ${(e as Error).message}`);
  }

  // Inject schema-declared severity. Mirrors index.ts:976-983.
  for (const [fieldId, fieldEnvelope] of Object.entries(fields)) {
    if (fieldEnvelope && typeof fieldEnvelope === "object") {
      const fdef = cfg.fieldSpecs[fieldId];
      if (fdef?.severity) (fieldEnvelope as Record<string, unknown>).severity = fdef.severity;
    }
  }

  // Schema-shape validation. Throws on malformed envelopes.
  cfg.validate(fields);

  // Verifier sweep — modifies envelope in place per architecture §10.2.
  const trimmedOcr = ocrText.slice(0, MAX_OCR_CHARS);
  for (const [fieldId, refs] of Object.entries(cfg.verifierRefs)) {
    const field = fields[fieldId] as VerifierFieldEnvelope | undefined;
    if (!field || field.absence_state !== "present") continue;

    const fieldSpec = cfg.fieldSpecs[fieldId];
    if (!fieldSpec) continue;

    for (const ref of refs) {
      const verifier = VERIFIERS[ref];
      if (!verifier) continue;
      const vResult = verifier({ ocr_text: trimmedOcr, field_spec: fieldSpec, field_envelope: field });
      if (!vResult.passes) {
        field.validation_status = ref === "monetary-verbatim" ? "failed_verifier" : "failed_format";
        field.confidence = "low";
        field.absence_state = ref === "monetary-verbatim" ? "contradicted" : "ambiguous";
        (field as Record<string, unknown>).verifier_failure = { ref, reason: vResult.reason };
      }
    }
  }

  // Minimal lifecycle (Phase 1: mirrors index.ts:1042-1053).
  const mietbeginnEntry = fields.mietbeginn as FieldEnvelope | undefined;
  const mietendeEntry = fields.mietende as FieldEnvelope | undefined;
  const mietbeginn = mietbeginnEntry?.normalized_value ?? null;
  const mietende = mietendeEntry?.normalized_value ?? null;
  const lifecycle = {
    issue_date: mietbeginn,
    effective_date: mietbeginn,
    signed_date: null,
    expiry_date: mietende && mietendeEntry?.absence_state === "present" ? mietende : null,
    document_status: "active",
    supersedes_document_id: null,
    amended_by_document_id: null,
    lifecycle_evidence: null,
  };

  return {
    doc_type: docType,
    schema_version: cfg.schemaVersion,
    prompt_version: cfg.schemaVersion,
    model: SONNET_MODEL,
    fields,
    lifecycle,
  };
}

// Live deps factory. Kept separate so test code never imports the
// Anthropic SDK transitively.
export function makeAnthropicDeps(apiKey: string): ExtractorDeps {
  if (!apiKey) throw new Error("extractor: ANTHROPIC_API_KEY required for live extraction");
  const client = new Anthropic({ apiKey });
  return {
    async callSonnet(prompt: string) {
      const resp = await client.messages.create({
        model: SONNET_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: "user", content: prompt }],
      });
      const block = resp.content[0];
      if (!block || block.type !== "text") {
        throw new Error("extractor: Sonnet response missing text content block");
      }
      return block.text;
    },
  };
}
