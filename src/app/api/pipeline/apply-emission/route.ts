// POST /api/pipeline/apply-emission
//
// Internal-only endpoint called by the Deno Edge Function after Step 8b
// commits a v2 envelope. Loads the envelope, dispatches to the appropriate
// emitter, calls the applier.
//
// Auth: x-internal-secret header must equal env.PIPELINE_INTERNAL_SECRET
// (timing-safe comparison).
//
// Body: { extraction_run_id: string }
//
// Response:
//   200 { status: "applied", apply_result: ApplyResult, doc_type, schema_version }
//   200 { status: "no_emitter_for_doc_type", doc_type }
//   400 { error: "..." }   — invalid body, envelope not found, etc.
//   401 { error: "unauthorized" }
//   500 { error: "..." }   — applier threw

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { getEmitter } from "@/lib/emitters";
import { applyEmission } from "@/lib/claim-store/applier";
import type { ApplyContext } from "@/lib/claim-store/types";

export const dynamic = "force-dynamic";

function constantTimeEqual(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers. We pad both to a fixed
  // length so length itself doesn't leak via early-return.
  const aBuf = Buffer.from(a.padEnd(128, "\0"));
  const bBuf = Buffer.from(b.padEnd(128, "\0"));
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf) && a.length === b.length;
}

export async function POST(req: NextRequest) {
  // --- Auth -----------------------------------------------------------------
  const secret = req.headers.get("x-internal-secret");
  const expected = process.env.PIPELINE_INTERNAL_SECRET;
  if (!secret || !expected || !constantTimeEqual(secret, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // --- Body parse -----------------------------------------------------------
  let body: { extraction_run_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const extraction_run_id = body.extraction_run_id;
  if (!extraction_run_id || typeof extraction_run_id !== "string") {
    return NextResponse.json(
      { error: "extraction_run_id required" },
      { status: 400 }
    );
  }

  // --- Load envelope --------------------------------------------------------
  const envelopeRows = await prisma.$queryRaw<
    {
      id: string;
      source_document_id: string;
      doc_type: string;
      schema_version: string;
      extraction_run_id: string;
      fields: any;
      lifecycle: any;
    }[]
  >`
    SELECT id, source_document_id, doc_type, schema_version,
           extraction_run_id, fields, lifecycle
    FROM warehouse.document_extractions_v2
    WHERE extraction_run_id = ${extraction_run_id}::uuid
    LIMIT 1
  `;
  if (envelopeRows.length === 0) {
    return NextResponse.json(
      { error: `no envelope for extraction_run_id=${extraction_run_id}` },
      { status: 400 }
    );
  }
  const envelope = envelopeRows[0];

  // --- Resolve emitter ------------------------------------------------------
  const entry = getEmitter(envelope.doc_type);
  if (!entry) {
    console.warn(
      `[apply-emission] no_emitter_for_doc_type doc_type=${envelope.doc_type} extraction_run_id=${extraction_run_id}`
    );
    return NextResponse.json({
      status: "no_emitter_for_doc_type",
      doc_type: envelope.doc_type,
    });
  }

  // --- Look up property + org for context ----------------------------------
  // @tenant-isolation-disable-next-line -- reason: apply-emission route resolves property/org from warehouse.documents for applier context, scoped by extraction envelope's source_document_id
  const propertyRows = await prisma.$queryRaw<
    { property_id: string; organizationId: string }[]
  >`
    SELECT d.property_id, p."organizationId"
    FROM warehouse.documents d
    JOIN "Property" p ON p.id = d.property_id
    WHERE d.id = ${envelope.source_document_id}::uuid
    LIMIT 1
  `;
  if (propertyRows.length === 0) {
    return NextResponse.json(
      { error: `no property mapping for document=${envelope.source_document_id}` },
      { status: 400 }
    );
  }
  const { property_id, organizationId } = propertyRows[0];

  // --- Run emitter ----------------------------------------------------------
  const emissionResult = entry.fn(
    {
      doc_type: envelope.doc_type,
      schema_version: envelope.schema_version,
      fields: envelope.fields,
      lifecycle: envelope.lifecycle,
    },
    {
      property_id,
      source_document_id: envelope.source_document_id,
      source_extraction_run_id: envelope.extraction_run_id,
      evidence_id_for_field: () => null, // evidence wiring is a future task
    }
  );

  // --- Apply ---------------------------------------------------------------
  const applyContext: ApplyContext = {
    property_id,
    org_id: organizationId,
    extraction_run_id: envelope.extraction_run_id,
    emitter_version: entry.version,
  };

  try {
    const apply_result = await applyEmission(emissionResult, applyContext);
    return NextResponse.json({
      status: "applied",
      apply_result,
      doc_type: envelope.doc_type,
      schema_version: envelope.schema_version,
    });
  } catch (e: any) {
    console.error(
      `[apply-emission] applier threw extraction_run_id=${extraction_run_id}`,
      e
    );
    return NextResponse.json(
      { error: e.message ?? String(e) },
      { status: 500 }
    );
  }
}
