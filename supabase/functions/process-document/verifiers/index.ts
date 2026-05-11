import type { Verifier } from "./types.ts";
import { monetaryVerbatim } from "./monetary-verbatim.ts";
import { enumVerifier } from "./enum.ts";
import { dateFormat } from "./date-format.ts";

// Verifier registry keyed by the verifier_ref strings used in schemas.
// Schema fields declare verifier_refs: ["monetary-verbatim"] and the
// pipeline looks up the implementation here.

export const VERIFIERS: Record<string, Verifier> = {
  "monetary-verbatim": monetaryVerbatim,
  "enum": enumVerifier,
  "date-format": dateFormat,
};

export type { Verifier, VerifierResult, VerifierContext, FieldSpec, FieldEnvelope } from "./types.ts";
