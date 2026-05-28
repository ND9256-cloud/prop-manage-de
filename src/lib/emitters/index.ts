// Emitter registry. Maps doc_type → { emitter function, version }.
// The version string is written to DerivationRecord.emitter_version by
// the applier; it captures which version of the emitter produced the claims,
// so a future emitter bump can find affected claims via:
//
//   SELECT output_id FROM warehouse.derivation_records
//   WHERE emitter_version = 'X.Y.Z' AND output_type = 'claim'
//
// Bump the version when emission semantics change (new claim kind, changed
// value shape, new field consumed). Don't bump for non-behavioral changes.

import { emitMietvertragClaims } from "./mietvertrag.ts";
import { emitMieterhoehungClaims } from "./mieterhoehung.ts";
import { emitMietvertragsnachtragClaims } from "./mietvertragsnachtrag.ts";
import { emitWohnungsuebergabeprotokollClaims } from "./wohnungsuebergabeprotokoll.ts";
import type { EmissionResult, EmitterContext } from "./types.ts";

export type EmitterFn = (envelope: any, context: EmitterContext) => EmissionResult;

export interface EmitterEntry {
  fn: EmitterFn;
  version: string;
}

export const EMITTERS: Record<string, EmitterEntry> = {
  mietvertrag: { fn: emitMietvertragClaims as EmitterFn, version: "1.0.0" },
  mieterhoehung: { fn: emitMieterhoehungClaims as EmitterFn, version: "1.0.0" },
  mietvertragsnachtrag: {
    fn: emitMietvertragsnachtragClaims as EmitterFn,
    version: "1.0.0",
  },
  wohnungsuebergabeprotokoll: {
    fn: emitWohnungsuebergabeprotokollClaims as EmitterFn,
    version: "1.0.0",
  },
};

export function getEmitter(doc_type: string): EmitterEntry | null {
  return EMITTERS[doc_type] ?? null;
}
