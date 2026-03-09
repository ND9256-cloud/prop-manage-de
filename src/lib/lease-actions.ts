
'use server';

import { prisma } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { LeaseStatus } from '@prisma/client';
import { getOrgContext, getOrgContextWritable } from '@/lib/org';

/**
 * Create a new person (tenant/contact)
 */
export async function createPerson(formData: FormData) {
    const ctx = await getOrgContextWritable();

    const firstName = formData.get('firstName') as string;
    const lastName = formData.get('lastName') as string;
    const email = formData.get('email') as string | null;
    const phone = formData.get('phone') as string | null;

    const person = await prisma.person.create({
        data: {
            firstName,
            lastName,
            email: email || undefined,
            phone: phone || undefined,
            organizationId: ctx.orgId,
        },
    });

    revalidatePath('/dashboard/rent-roll');
    return person;
}

/**
 * Get all persons in the organization
 */
export async function getPersons() {
    const ctx = await getOrgContext();

    return prisma.person.findMany({
        where: { organizationId: ctx.orgId },
        include: {
            leases: {
                where: { status: 'ACTIVE' },
                include: {
                    unit: {
                        include: { property: true },
                    },
                },
            },
        },
        orderBy: { lastName: 'asc' },
    });
}

/**
 * Create a new lease
 */
export async function createLease(formData: FormData) {
    const ctx = await getOrgContextWritable();

    const unitId = formData.get('unitId') as string;
    const mainTenantId = formData.get('mainTenantId') as string;
    const startDate = new Date(formData.get('startDate') as string);
    const endDateStr = formData.get('endDate') as string | null;
    const coldRent = parseFloat(formData.get('coldRent') as string);
    const utilityAdvance = parseFloat(formData.get('utilityAdvance') as string);
    const deposit = parseFloat(formData.get('deposit') as string);
    const parkingRent = formData.get('parkingRent') as string | null;

    // Verify unit belongs to this org
    const unit = await prisma.unit.findFirst({
        where: { id: unitId, property: { organizationId: ctx.orgId } },
        include: { property: true },
    });
    if (!unit) throw new Error('Not found');

    const lease = await prisma.lease.create({
        data: {
            unitId,
            mainTenantId,
            startDate,
            endDate: endDateStr ? new Date(endDateStr) : undefined,
            coldRent,
            utilityAdvance,
            deposit,
            parkingRent: parkingRent ? parseFloat(parkingRent) : undefined,
            status: 'ACTIVE',
            currentUnitId: unitId,
        },
    });

    revalidatePath(`/dashboard/properties/${unit.propertyId}`);
    revalidatePath('/dashboard/rent-roll');
    return lease;
}

/**
 * Update a lease
 */
export async function updateLease(leaseId: string, formData: FormData) {
    const ctx = await getOrgContextWritable();

    // Verify ownership and get propertyId for revalidation
    const existing = await prisma.lease.findFirst({
        where: { id: leaseId, unit: { property: { organizationId: ctx.orgId } } },
        select: { id: true, unit: { select: { propertyId: true } } },
    });
    if (!existing) throw new Error('Not found');

    const endDateStr = formData.get('endDate') as string | null;
    const coldRent = parseFloat(formData.get('coldRent') as string);
    const utilityAdvance = parseFloat(formData.get('utilityAdvance') as string);
    const status = formData.get('status') as LeaseStatus;
    const parkingRent = formData.get('parkingRent') as string | null;

    const { count } = await prisma.lease.updateMany({
        where: {
            id: leaseId,
            unit: { property: { organizationId: ctx.orgId } },
        },
        data: {
            endDate: endDateStr ? new Date(endDateStr) : null,
            coldRent,
            utilityAdvance,
            parkingRent: parkingRent ? parseFloat(parkingRent) : null,
            status,
            currentUnitId: status === 'ACTIVE' ? undefined : null,
        },
    });
    if (count === 0) throw new Error('Not found');

    revalidatePath(`/dashboard/properties/${existing.unit.propertyId}`);
    revalidatePath('/dashboard/rent-roll');
}

/**
 * End a lease
 */
export async function endLease(leaseId: string) {
    const ctx = await getOrgContextWritable();

    // Verify ownership and get propertyId for revalidation
    const existing = await prisma.lease.findFirst({
        where: { id: leaseId, unit: { property: { organizationId: ctx.orgId } } },
        select: { id: true, unit: { select: { propertyId: true } } },
    });
    if (!existing) throw new Error('Not found');

    const { count } = await prisma.lease.updateMany({
        where: {
            id: leaseId,
            unit: { property: { organizationId: ctx.orgId } },
        },
        data: {
            status: 'ENDED',
            endDate: new Date(),
            currentUnitId: null,
        },
    });
    if (count === 0) throw new Error('Not found');

    revalidatePath(`/dashboard/properties/${existing.unit.propertyId}`);
    revalidatePath('/dashboard/rent-roll');
}

/**
 * Get all leases for a property
 */
export async function getPropertyLeases(propertyId: string) {
    const ctx = await getOrgContext();

    // Verify property belongs to this org
    const property = await prisma.property.findFirst({
        where: { id: propertyId, organizationId: ctx.orgId },
        select: { id: true },
    });
    if (!property) return [];

    return prisma.lease.findMany({
        where: {
            unit: {
                propertyId,
                property: { organizationId: ctx.orgId },
            },
        },
        include: {
            mainTenant: true,
            unit: true,
        },
        orderBy: { startDate: 'desc' },
    });
}

/**
 * Get active leases count and total rent
 */
export async function getLeaseStats() {
    const ctx = await getOrgContext();

    const activeLeases = await prisma.lease.findMany({
        where: {
            status: 'ACTIVE',
            unit: {
                property: { organizationId: ctx.orgId },
            },
        },
        select: {
            coldRent: true,
            utilityAdvance: true,
            parkingRent: true,
        },
    });

    const totalMonthlyRent = activeLeases.reduce((sum, l) =>
        sum + l.coldRent + l.utilityAdvance + (l.parkingRent || 0), 0
    );

    return {
        activeLeaseCount: activeLeases.length,
        totalMonthlyRent,
        totalColdRent: activeLeases.reduce((sum, l) => sum + l.coldRent, 0),
    };
}
