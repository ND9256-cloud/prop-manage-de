// src/lib/presenter/render.ts
//
// LLM-bounded render layer. Architecture §5.4.6.
//
// This file is a LIBRARY, NOT a server action. Do NOT add "use server" to it.
// It receives composer/resolver output as plain values and returns German
// prose strings. It NEVER reads claims, OCR, the DB, or document metadata;
// the purity gate (src/tests/presenter/presenter-purity.test.ts) enforces
// the import boundary.
//
// The Presenter is a translator, not an analyst:
//   - structured German (a ResolvedFact or PropertySnapshot)
//     → fluent German prose
//   - inventions, conflict resolution, gap-filling all belong to the
//     composer or resolvers, not here

import Anthropic from "@anthropic-ai/sdk";
import type { ResolvedFact } from "../resolvers/types";
import type { PropertySnapshot } from "../composer/types";
import {
  PRESENTER_SYSTEM_PROMPT,
  PRESENTER_USER_PROMPT_PREFIX,
} from "./prompts";
import type { RenderHints } from "./types";

export const PRESENTER_VERSION = "1.0.0";

// Model identifier. Centralised at the top so swapping is a one-line change.
// Sonnet is sufficient for render-only work; the safety boundary lives in the
// system prompt, not in the choice of model. Architecture §9.3 notes that
// the presenter is allowed to specify Sonnet — it's a render layer, not a
// correctness gate, so provider-agnostic constraints that apply to verifiers
// do not apply here.
export const PRESENTER_MODEL = "claude-sonnet-4-6";

const MAX_TOKENS = 800;

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * Render a single ResolvedFact as German prose. Mirrors the resolver's
 * value, confidence, status, and conflicts; never resolves them.
 *
 * If `hints.documents` includes entries whose `id` matches an item in
 * `fact.source_document_ids`, the prose may reference the document by
 * doc_type ("laut hinterlegtem Mietvertrag"). Without hints, sources are
 * referenced generically ("der hinterlegten Quelle").
 *
 * The caller resolves source_document_ids → doc_type. The presenter never
 * touches the database.
 */
export async function renderResolvedFact<T>(
  fact: ResolvedFact<T>,
  hints?: RenderHints,
): Promise<string> {
  const payload = JSON.stringify(
    { kind: "ResolvedFact", fact, hints: hints ?? null },
    null,
    2,
  );
  return callPresenter(payload);
}

/**
 * Render a PropertySnapshot as a multi-sentence German summary. Mentions
 * short_code/address, unit count, occupancy summary, total resolved rent,
 * and per-unit notes that distinguish vacancy_reason "no_data" from
 * "tenancy_ended" (mirroring the rent-roll module's vocabulary). Modules
 * with completeness "unavailable" are skipped, not invented around.
 */
export async function renderPropertySnapshot(
  snapshot: PropertySnapshot,
  hints?: RenderHints,
): Promise<string> {
  const payload = JSON.stringify(
    { kind: "PropertySnapshot", snapshot, hints: hints ?? null },
    null,
    2,
  );
  return callPresenter(payload);
}

async function callPresenter(payload: string): Promise<string> {
  const client = getClient();
  // @tenant-isolation-disable-next-line -- reason: client.messages.create is the Anthropic SDK, not a Prisma model; presenter touches no DB
  const res = await client.messages.create({
    model: PRESENTER_MODEL,
    max_tokens: MAX_TOKENS,
    system: PRESENTER_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `${PRESENTER_USER_PROMPT_PREFIX}${payload}`,
      },
    ],
  });
  return res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}

// ---------------------------------------------------------------------------
// Future-caching boundary (NOT implemented in v1).
// ---------------------------------------------------------------------------
//
// A caching layer keyed on
//   (claim_snapshot_version, PRESENTER_VERSION, sha256(payload))
// would be valuable once dashboard/chat surfaces start calling the renderer
// frequently. v1 ships uncached on purpose — premature caching can hide
// correctness regressions. The cache key inputs are stable: PRESENTER_VERSION
// is exported above; claim_snapshot_version is on PropertySnapshot.metadata;
// the payload hash is derivable from the JSON the presenter already builds.
