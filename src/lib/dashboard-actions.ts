'use server';

import { getOrgContext } from '@/lib/org';
import { prisma } from '@/lib/db';
import { warehouseDb } from '@/lib/warehouse/db';
import { composePropertySnapshot } from '@/lib/composer/property-snapshot';
import type { RentRollSnapshot, RentRollRow } from '@/lib/composer/modules/rent-roll';
import { extractLegacyTenants, type LegacyRentRollRow } from '@/lib/legacy-brain/extract-tenants';
import { renderEvidence } from '@/lib/evidence';
import type { Evidence } from '@/lib/evidence';

export interface LastVisitStats {
    newDocs: number;
    needsReview: number;
}

export async function getLastVisitStats(): Promise<LastVisitStats> {
    const ctx = await getOrgContext();
    if (!ctx) return { newDocs: 0, needsReview: 0 };

    // Read last_seen_at before updating it
    const membership = await prisma.membership.findUnique({
        where: { userId_orgId: { userId: ctx.userId, orgId: ctx.orgId } },
        select: { lastSeenAt: true },
    });

    const lastSeen = membership?.lastSeenAt;

    // Update last_seen_at to now (force, no throttle)
    // @tenant-isolation-disable-next-line -- reason: dashboard last_seen_at timestamp update via executeRaw for membership tracking, org-scoped upstream via getOrgContext session; raw SQL pending iteration-2 wrapper
    await prisma.$executeRaw`
        UPDATE memberships SET last_seen_at = now()
        WHERE "userId" = ${ctx.userId}::uuid AND "orgId" = ${ctx.orgId}::uuid
    `;

    if (!lastSeen) return { newDocs: 0, needsReview: 0 };

    const db = warehouseDb(ctx.orgId);

    const [totalRes, reviewRes] = await Promise.all([
        db
            .from('documents')
            .select('id', { count: 'exact', head: true })
            .eq('org_id', ctx.orgId)
            .gt('created_at', lastSeen.toISOString()),
        db
            .from('documents')
            .select('id', { count: 'exact', head: true })
            .eq('org_id', ctx.orgId)
            .gt('created_at', lastSeen.toISOString())
            .eq('status', 'needs_review'),
    ]);

    return {
        newDocs: totalRes.count ?? 0,
        needsReview: reviewRes.count ?? 0,
    };
}

export interface RentRoll {
    current_tenants: number;
    monthly_gross_cold: number;
    annual_gross_cold: number;
}

export interface BrainSummary {
    propertyId: string;
    analysis: Record<string, unknown>;
    isStale: boolean;
    generatedAt: string;
    rentRoll: RentRoll;
    shortCode: string | null;
    address: string;
    city: string;
    zip: string;
    totalSqm: number | null;
    propertyName: string;
}

export async function getBrainSummaries(): Promise<BrainSummary[]> {
    const ctx = await getOrgContext();
    if (!ctx) return [];

    const db = warehouseDb(ctx.orgId);

    // Fetch brain data and property metadata in parallel
    const [brainResult, propertyExtras] = await Promise.all([
        db
            .from('property_intelligence')
            .select('property_id, analysis, is_stale, generated_at')
            .eq('org_id', ctx.orgId)
            .eq('is_current', true),
        // @tenant-isolation-disable-next-line -- reason: holdings table query using quoted Property table name for Prisma model name mismatch, org-scoped upstream via getOrgContext session; raw SQL pending iteration-2 wrapper
        prisma.$queryRaw<{ id: string; name: string; address: string; city: string | null; zip: string | null; short_code: string | null; total_sqm: number | null }[]>`
            SELECT id, name, address, city, zip, short_code, total_sqm::float8 as total_sqm
            FROM "Property" WHERE "organizationId" = ${ctx.orgId}::uuid
        `.catch(() => [] as { id: string; name: string; address: string; city: string | null; zip: string | null; short_code: string | null; total_sqm: number | null }[]),
    ]);

    if (brainResult.error || !brainResult.data) return [];

    // Build property lookup
    const propMap = new Map(propertyExtras.map(p => [p.id, p]));

    return brainResult.data.map((row: { property_id: string; analysis: Record<string, unknown>; is_stale: boolean; generated_at: string }) => {
        const analysis = row.analysis as Record<string, unknown>;
        const rentRoll = extractRentRoll(analysis);
        const prop = propMap.get(row.property_id);
        return {
            propertyId: row.property_id,
            analysis,
            isStale: row.is_stale,
            generatedAt: row.generated_at,
            rentRoll,
            shortCode: prop?.short_code ?? null,
            address: prop?.address ?? '',
            city: prop?.city ?? '',
            zip: prop?.zip ?? '',
            totalSqm: prop?.total_sqm ?? null,
            propertyName: prop?.name ?? '',
        };
    });
}

function extractRentRoll(analysis: Record<string, unknown>): RentRoll {
    const rentRoll = analysis?.rent_roll as {
        current_tenants?: number | unknown[];
        tenants?: unknown[];
        monthly_gross_cold?: number;
        annual_gross_cold?: number;
    } | undefined;

    if (rentRoll) {
        // Resolve tenant count: current_tenants can be a number or an array;
        // fall back to tenants array length if current_tenants is missing or zero.
        let tenantCount = 0;
        if (Array.isArray(rentRoll.current_tenants)) {
            tenantCount = rentRoll.current_tenants.length;
        } else if (typeof rentRoll.current_tenants === 'number' && rentRoll.current_tenants > 0) {
            tenantCount = rentRoll.current_tenants;
        } else if (Array.isArray(rentRoll.tenants)) {
            tenantCount = rentRoll.tenants.length;
        }

        const monthly = typeof rentRoll.monthly_gross_cold === 'number' ? rentRoll.monthly_gross_cold : 0;
        const annual = typeof rentRoll.annual_gross_cold === 'number' ? rentRoll.annual_gross_cold : monthly * 12;

        return {
            current_tenants: tenantCount,
            monthly_gross_cold: monthly,
            annual_gross_cold: annual,
        };
    }

    // Fallback: no rent_roll section at all — return zeros
    return {
        current_tenants: 0,
        monthly_gross_cold: 0,
        annual_gross_cold: 0,
    };
}

// ---------------------------------------------------------------------------
// Composer-driven rent roll (Task 3.3)
// ---------------------------------------------------------------------------
//
// The first customer-facing surface that renders from resolved facts. For each
// property in the org we compose a RentRollSnapshot and surface enough
// provenance metadata for the click-through modal in the UI.
//
// "Composer-first, legacy fallback" — if the composer has no resolved value
// for a unit but the legacy document_intelligence brain has a tenant for that
// same unit_ref, the dashboard renders the legacy value with a "Legacy" tag.
// This is the dark-launch path during the 3.4 shadow-mode transition and
// gets removed once parity is proven.

export interface ProvenanceDocument {
    id: string;
    file_name: string;
    doc_type: string | null;
    category: string | null;
    status: string | null;
}

export interface ProvenanceClaim {
    id: string;
    valid_from: string | null;
    confidence: 'high' | 'medium' | 'low' | null;
    source_field_path: string | null;
    source_document_id: string | null;
    // Human-readable GERMAN source for the click-through (Task 4.3c-b-ii-A).
    // direct_quote → the quote; table_cell → "Tabellenzelle — …". Null when the
    // claim carries no evidence object. Today no emitter attaches a table_cell
    // (emission is 4.3c-b-ii-B), so this is the byte-unchanged direct_quote path;
    // the wiring is in place so a table_cell claim renders readable source, not
    // a blank quote, the moment emission lands.
    evidence_rendered: string | null;
}

// A claim's value jsonb may carry an evidence object (a single Evidence or an
// array of them) under `evidence`. Render the first valid one to a German
// provenance string; return null when none is present.
function renderClaimEvidence(value: unknown): string | null {
    if (typeof value !== 'object' || value === null) return null;
    const raw = (value as { evidence?: unknown }).evidence;
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (typeof first !== 'object' || first === null) return null;
    try {
        return renderEvidence(first as Evidence);
    } catch {
        return null;
    }
}


export interface RentRollSnapshotPayload {
    propertyId: string;
    propertyName: string;
    shortCode: string | null;
    address: string;
    city: string;
    zip: string;
    snapshot: RentRollSnapshot;
    legacyByUnitRef: Record<string, LegacyRentRollRow>;
    provenance: {
        documents: Record<string, ProvenanceDocument>;
        claims: Record<string, ProvenanceClaim>;
    };
}

function collectIds(rows: RentRollRow[]): { docIds: string[]; claimIds: string[] } {
    const docs = new Set<string>();
    const claims = new Set<string>();
    for (const r of rows) {
        for (const id of r.current_kaltmiete.source_document_ids) docs.add(id);
        for (const id of r.current_kaltmiete.source_claim_ids) claims.add(id);
    }
    return { docIds: [...docs], claimIds: [...claims] };
}

export async function getRentRollSnapshots(): Promise<RentRollSnapshotPayload[]> {
    const ctx = await getOrgContext();
    if (!ctx) return [];

    // @tenant-isolation-disable-next-line -- reason: dashboard 3.3 enumerates Property rows for the current org via explicit organizationId parameter; composer downstream re-verifies org_id before reading units/claims
    const properties = await prisma.$queryRaw<{
        id: string;
        name: string;
        address: string;
        city: string | null;
        zip: string | null;
        short_code: string | null;
    }[]>`
        SELECT id, name, address, city, zip, short_code
        FROM "Property"
        WHERE "organizationId" = ${ctx.orgId}::uuid
        ORDER BY short_code NULLS LAST, name
    `.catch(() => [] as { id: string; name: string; address: string; city: string | null; zip: string | null; short_code: string | null }[]);

    if (properties.length === 0) return [];

    // Legacy brain map for fallback per (property_id, unit_ref).
    const db = warehouseDb(ctx.orgId);
    const brainRes = await db
        .from('property_intelligence')
        .select('property_id, analysis')
        .eq('org_id', ctx.orgId)
        .eq('is_current', true);

    const legacyByProperty = new Map<string, Map<string, LegacyRentRollRow>>();
    if (brainRes.data) {
        for (const row of brainRes.data as { property_id: string; analysis: Record<string, unknown> }[]) {
            const tenants = extractLegacyTenants(row.analysis ?? {});
            const m = new Map<string, LegacyRentRollRow>();
            for (const t of tenants) m.set(t.unit_ref, t);
            legacyByProperty.set(row.property_id, m);
        }
    }

    const payloads: RentRollSnapshotPayload[] = [];

    for (const p of properties) {
        let snapshot: RentRollSnapshot;
        try {
            const composed = await composePropertySnapshot({
                property_id: p.id,
                org_id: ctx.orgId,
                modules: ['rent_roll'],
            });
            const m = composed.modules.rent_roll;
            if (!m || !m.data) continue;
            snapshot = m.data as RentRollSnapshot;
        } catch (err) {
            console.warn(`[dashboard] composePropertySnapshot failed for ${p.id}`, err);
            continue;
        }

        const { docIds, claimIds } = collectIds(snapshot.rows);

        const documents: Record<string, ProvenanceDocument> = {};
        if (docIds.length > 0) {
            const docRes = await db
                .from('documents')
                .select('id, file_name, doc_type, category, status')
                .eq('org_id', ctx.orgId)
                .in('id', docIds);
            if (docRes.data) {
                for (const d of docRes.data as ProvenanceDocument[]) {
                    documents[d.id] = d;
                }
            }
        }

        const claims: Record<string, ProvenanceClaim> = {};
        if (claimIds.length > 0) {
            // @tenant-isolation-disable-next-line -- reason: dashboard 3.3 provenance read; claim ids are derived from a snapshot whose property was already org-verified by composer buildCore; JOIN to Property re-enforces org isolation
            const claimRows = await prisma.$queryRaw<{
                id: string;
                valid_from: Date | null;
                confidence: 'high' | 'medium' | 'low' | null;
                source_field_path: string | null;
                source_document_id: string | null;
                value: unknown;
            }[]>`
                SELECT c.id, c.valid_from, c.confidence, c.source_field_path, c.source_document_id, c.value
                FROM warehouse.claims c
                JOIN "Property" prop ON prop.id = c.property_id
                WHERE c.id = ANY(${claimIds}::uuid[])
                  AND prop."organizationId" = ${ctx.orgId}::uuid
            `.catch(() => [] as never);
            for (const c of claimRows) {
                claims[c.id] = {
                    id: c.id,
                    valid_from: c.valid_from ? c.valid_from.toISOString().slice(0, 10) : null,
                    confidence: c.confidence,
                    source_field_path: c.source_field_path,
                    source_document_id: c.source_document_id,
                    evidence_rendered: renderClaimEvidence(c.value),
                };
            }
        }

        const legacyMap = legacyByProperty.get(p.id) ?? new Map();
        const legacyByUnitRef: Record<string, LegacyRentRollRow> = {};
        for (const [k, v] of legacyMap) legacyByUnitRef[k] = v;

        payloads.push({
            propertyId: p.id,
            propertyName: p.name,
            shortCode: p.short_code,
            address: p.address,
            city: p.city ?? '',
            zip: p.zip ?? '',
            snapshot,
            legacyByUnitRef,
            provenance: { documents, claims },
        });
    }

    return payloads;
}
