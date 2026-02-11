
'use server';

import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { LeaseStatus } from '@prisma/client';

/**
 * Create a new person (tenant/contact)
 */
export async function createPerson(formData: FormData) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) throw new Error('User not in organization');

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
            organizationId: user.organizationId,
        },
    });

    revalidatePath('/dashboard/rent-roll');
    return person;
}

/**
 * Get all persons in the organization
 */
export async function getPersons() {
    const session = await auth();
    if (!session?.user?.email) return [];

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) return [];

    return prisma.person.findMany({
        where: { organizationId: user.organizationId },
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
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const unitId = formData.get('unitId') as string;
    const mainTenantId = formData.get('mainTenantId') as string;
    const startDate = new Date(formData.get('startDate') as string);
    const endDateStr = formData.get('endDate') as string | null;
    const coldRent = parseFloat(formData.get('coldRent') as string);
    const utilityAdvance = parseFloat(formData.get('utilityAdvance') as string);
    const deposit = parseFloat(formData.get('deposit') as string);
    const parkingRent = formData.get('parkingRent') as string | null;

    // Get unit to find property
    const unit = await prisma.unit.findUnique({
        where: { id: unitId },
        include: { property: true },
    });

    if (!unit) throw new Error('Unit not found');

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
            // Set as current unit occupant
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
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const endDateStr = formData.get('endDate') as string | null;
    const coldRent = parseFloat(formData.get('coldRent') as string);
    const utilityAdvance = parseFloat(formData.get('utilityAdvance') as string);
    const status = formData.get('status') as LeaseStatus;
    const parkingRent = formData.get('parkingRent') as string | null;

    const lease = await prisma.lease.update({
        where: { id: leaseId },
        data: {
            endDate: endDateStr ? new Date(endDateStr) : null,
            coldRent,
            utilityAdvance,
            parkingRent: parkingRent ? parseFloat(parkingRent) : null,
            status,
            // If ended, remove current unit association
            currentUnitId: status === 'ACTIVE' ? undefined : null,
        },
        include: { unit: true },
    });

    revalidatePath(`/dashboard/properties/${lease.unit.propertyId}`);
    revalidatePath('/dashboard/rent-roll');
    return lease;
}

/**
 * End a lease
 */
export async function endLease(leaseId: string) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const lease = await prisma.lease.update({
        where: { id: leaseId },
        data: {
            status: 'ENDED',
            endDate: new Date(),
            currentUnitId: null,
        },
        include: { unit: true },
    });

    revalidatePath(`/dashboard/properties/${lease.unit.propertyId}`);
    revalidatePath('/dashboard/rent-roll');
    return lease;
}

/**
 * Get all leases for a property
 */
export async function getPropertyLeases(propertyId: string) {
    const session = await auth();
    if (!session?.user?.email) return [];

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) return [];

    return prisma.lease.findMany({
        where: {
            unit: {
                propertyId,
                property: { organizationId: user.organizationId },
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
    const session = await auth();
    if (!session?.user?.email) return null;

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) return null;

    const activeLeases = await prisma.lease.findMany({
        where: {
            status: 'ACTIVE',
            unit: {
                property: { organizationId: user.organizationId },
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
