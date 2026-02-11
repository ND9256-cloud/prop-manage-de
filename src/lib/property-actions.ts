
'use server';

import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { PropertyType } from '@prisma/client';

/**
 * Create a new property
 */
export async function createProperty(formData: FormData) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) throw new Error('User not in organization');

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
            organizationId: user.organizationId,
        },
    });

    revalidatePath('/dashboard/properties');
    return property;
}

/**
 * Update a property
 */
export async function updateProperty(propertyId: string, formData: FormData) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) throw new Error('User not in organization');

    const name = formData.get('name') as string;
    const address = formData.get('address') as string;
    const city = formData.get('city') as string;
    const zip = formData.get('zip') as string;
    const type = formData.get('type') as PropertyType;
    const yearBuilt = formData.get('yearBuilt') as string | null;

    const property = await prisma.property.update({
        where: { id: propertyId },
        data: {
            name,
            address,
            city,
            zip,
            type,
            yearBuilt: yearBuilt ? parseInt(yearBuilt) : undefined,
        },
    });

    revalidatePath('/dashboard/properties');
    revalidatePath(`/dashboard/properties/${propertyId}`);
    return property;
}

/**
 * Delete a property
 */
export async function deleteProperty(propertyId: string) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) throw new Error('User not in organization');

    await prisma.property.delete({
        where: { id: propertyId },
    });

    revalidatePath('/dashboard/properties');
}

/**
 * Get all properties for the current organization
 */
export async function getProperties() {
    const session = await auth();
    if (!session?.user?.email) return [];

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) return [];

    return prisma.property.findMany({
        where: { organizationId: user.organizationId },
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
    const session = await auth();
    if (!session?.user?.email) return null;

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) return null;

    return prisma.property.findFirst({
        where: {
            id: propertyId,
            organizationId: user.organizationId,
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
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const propertyId = formData.get('propertyId') as string;
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
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const unitNumber = formData.get('unitNumber') as string;
    const floor = formData.get('floor') as string | null;
    const sizeSqm = parseFloat(formData.get('sizeSqm') as string);
    const rooms = formData.get('rooms') as string | null;
    const targetColdRent = formData.get('targetColdRent') as string | null;

    const unit = await prisma.unit.update({
        where: { id: unitId },
        data: {
            unitNumber,
            floor: floor ? parseInt(floor) : null,
            sizeSqm,
            rooms: rooms ? parseFloat(rooms) : null,
            targetColdRent: targetColdRent ? parseFloat(targetColdRent) : null,
        },
    });

    revalidatePath(`/dashboard/properties/${unit.propertyId}`);
    return unit;
}

/**
 * Delete a unit and all its related records (leases, tickets)
 */
export async function deleteUnit(unitId: string) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    // Delete related records first to avoid FK violations
    // 1. Delete leases linked to this unit
    await prisma.lease.deleteMany({
        where: { unitId: unitId },
    });

    // 2. Now delete the unit
    const unit = await prisma.unit.delete({
        where: { id: unitId },
    });

    revalidatePath(`/dashboard/properties/${unit.propertyId}`);
}

/**
 * Delete a lease
 */
export async function deleteLease(leaseId: string) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const lease = await prisma.lease.delete({
        where: { id: leaseId },
    });

    revalidatePath('/dashboard/rent-roll');
}
