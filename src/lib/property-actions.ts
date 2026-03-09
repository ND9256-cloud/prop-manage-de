
'use server';

import { prisma } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { PropertyType } from '@prisma/client';
import { getOrgContext, getOrgContextWritable } from '@/lib/org';

// ── Field whitelist for property updates ───────────────────
const ALLOWED_PROPERTY_FIELDS = ['name', 'address', 'city', 'zip', 'type', 'yearBuilt'] as const;

/**
 * Create a new property
 */
export async function createProperty(formData: FormData) {
    const ctx = await getOrgContextWritable();

    const name = formData.get('name') as string;
    const address = formData.get('address') as string;
    const city = formData.get('city') as string;
    const zip = formData.get('zip') as string;
    const type = formData.get('type') as PropertyType;
    const yearBuilt = formData.get('yearBuilt') as string | null;

    const property = await prisma.property.create({
        data: {
            name,
            address,
            city,
            zip,
            type,
            yearBuilt: yearBuilt ? parseInt(yearBuilt) : undefined,
            organizationId: ctx.orgId,
        },
    });

    revalidatePath('/dashboard/properties');
    return property;
}

/**
 * Update a property
 */
export async function updateProperty(propertyId: string, formData: FormData) {
    const ctx = await getOrgContextWritable();

    // Build data object from whitelist only
    const data: Record<string, unknown> = {};
    for (const field of ALLOWED_PROPERTY_FIELDS) {
        const val = formData.get(field);
        if (val !== null) {
            if (field === 'yearBuilt') {
                data[field] = val ? parseInt(val as string) : null;
            } else {
                data[field] = val as string;
            }
        }
    }

    const { count } = await prisma.property.updateMany({
        where: { id: propertyId, organizationId: ctx.orgId },
        data,
    });
    if (count === 0) throw new Error('Not found');

    revalidatePath('/dashboard/properties');
    revalidatePath(`/dashboard/properties/${propertyId}`);
}

/**
 * Delete a property
 */
export async function deleteProperty(propertyId: string) {
    const ctx = await getOrgContextWritable();

    const { count } = await prisma.property.deleteMany({
        where: { id: propertyId, organizationId: ctx.orgId },
    });
    if (count === 0) throw new Error('Not found');

    revalidatePath('/dashboard/properties');
}

/**
 * Get all properties for the current organization
 */
export async function getProperties() {
    const ctx = await getOrgContext();

    return prisma.property.findMany({
        where: { organizationId: ctx.orgId },
        include: {
            _count: { select: { units: true, documents: true } },
            units: {
                include: {
                    leases: {
                        where: { status: 'ACTIVE' },
                        select: { id: true },
                    },
                },
            },
        },
        orderBy: { createdAt: 'desc' },
    });
}

/**
 * Get a single property with details
 */
export async function getProperty(propertyId: string) {
    const ctx = await getOrgContext();

    return prisma.property.findFirst({
        where: {
            id: propertyId,
            organizationId: ctx.orgId,
        },
        include: {
            units: {
                include: {
                    leases: {
                        where: { status: 'ACTIVE' },
                        include: { mainTenant: true },
                    },
                },
                orderBy: { unitNumber: 'asc' },
            },
            _count: { select: { documents: true } },
        },
    });
}

/**
 * Create a new unit
 */
export async function createUnit(formData: FormData) {
    const ctx = await getOrgContextWritable();

    const propertyId = formData.get('propertyId') as string;

    // Verify property belongs to this org
    const property = await prisma.property.findFirst({
        where: { id: propertyId, organizationId: ctx.orgId },
        select: { id: true },
    });
    if (!property) throw new Error('Not found');

    const unitNumber = formData.get('unitNumber') as string;
    const floor = formData.get('floor') as string | null;
    const sizeSqm = parseFloat(formData.get('sizeSqm') as string);
    const rooms = formData.get('rooms') as string | null;
    const targetColdRent = formData.get('targetColdRent') as string | null;

    const unit = await prisma.unit.create({
        data: {
            propertyId,
            unitNumber,
            floor: floor ? parseInt(floor) : undefined,
            sizeSqm,
            rooms: rooms ? parseFloat(rooms) : undefined,
            targetColdRent: targetColdRent ? parseFloat(targetColdRent) : undefined,
        },
    });

    revalidatePath(`/dashboard/properties/${propertyId}`);
    return unit;
}

/**
 * Update a unit
 */
export async function updateUnit(unitId: string, formData: FormData) {
    const ctx = await getOrgContextWritable();

    const unitNumber = formData.get('unitNumber') as string;
    const floor = formData.get('floor') as string | null;
    const sizeSqm = parseFloat(formData.get('sizeSqm') as string);
    const rooms = formData.get('rooms') as string | null;
    const targetColdRent = formData.get('targetColdRent') as string | null;

    const { count } = await prisma.unit.updateMany({
        where: { id: unitId, property: { organizationId: ctx.orgId } },
        data: {
            unitNumber,
            floor: floor ? parseInt(floor) : null,
            sizeSqm,
            rooms: rooms ? parseFloat(rooms) : null,
            targetColdRent: targetColdRent ? parseFloat(targetColdRent) : null,
        },
    });
    if (count === 0) throw new Error('Not found');

    // Fetch propertyId for path revalidation
    const unit = await prisma.unit.findUnique({
        where: { id: unitId },
        select: { propertyId: true },
    });
    if (unit) revalidatePath(`/dashboard/properties/${unit.propertyId}`);
}

/**
 * Delete a unit and all its related records (leases, tickets)
 */
export async function deleteUnit(unitId: string) {
    const ctx = await getOrgContextWritable();

    // Verify ownership and get propertyId for revalidation
    const unit = await prisma.unit.findFirst({
        where: { id: unitId, property: { organizationId: ctx.orgId } },
        select: { id: true, propertyId: true },
    });
    if (!unit) throw new Error('Not found');

    // Delete related records first to avoid FK violations
    await prisma.lease.deleteMany({ where: { unitId } });

    // Delete the unit — scoped to org
    const { count } = await prisma.unit.deleteMany({
        where: { id: unitId, property: { organizationId: ctx.orgId } },
    });
    if (count === 0) throw new Error('Not found');

    revalidatePath(`/dashboard/properties/${unit.propertyId}`);
}
