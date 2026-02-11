'use server';

import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { revalidatePath } from 'next/cache';

export interface ImportRow {
    address: string;
    unitNumber: string;
    tenantFirstName: string;
    tenantLastName: string;
    sizeSqm: number;
    coldRent: number;
    utilityAdvance: number;
    deposit: number;
    startDate: string; // ISO date string
    endDate?: string;
    propertyName?: string;
    city?: string;
    zip?: string;
    rooms?: number;
    floor?: number;
    parkingRent?: number;
    rentIncreaseRule?: string;
    lastRentIncreaseAt?: string;
}

export async function importRentRoll(rows: ImportRow[]) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) throw new Error('User not in organization');

    const orgId = user.organizationId;
    let created = 0;

    // Cache to avoid re-creating same property/person
    const propertyCache = new Map<string, string>(); // address → id
    const personCache = new Map<string, string>(); // "first|last" → id

    for (const row of rows) {
        // 1. Upsert Property
        let propertyId = propertyCache.get(row.address);
        if (!propertyId) {
            const existing = await prisma.property.findFirst({
                where: { address: row.address, organizationId: orgId },
            });
            if (existing) {
                propertyId = existing.id;
            } else {
                const prop = await prisma.property.create({
                    data: {
                        name: row.propertyName || row.address,
                        address: row.address,
                        city: row.city || '',
                        zip: row.zip || '',
                        type: 'APARTMENT_BUILDING',
                        organizationId: orgId,
                    },
                });
                propertyId = prop.id;
            }
            propertyCache.set(row.address, propertyId);
        }

        // 2. Upsert Unit
        let unit = await prisma.unit.findFirst({
            where: { propertyId, unitNumber: row.unitNumber },
        });
        if (!unit) {
            unit = await prisma.unit.create({
                data: {
                    unitNumber: row.unitNumber,
                    floor: row.floor ?? null,
                    sizeSqm: row.sizeSqm,
                    rooms: row.rooms ?? null,
                    propertyId,
                },
            });
        }

        // 3. Upsert Person
        const personKey = `${row.tenantFirstName}|${row.tenantLastName}`;
        let personId = personCache.get(personKey);
        if (!personId) {
            const existing = await prisma.person.findFirst({
                where: {
                    firstName: row.tenantFirstName,
                    lastName: row.tenantLastName,
                    organizationId: orgId,
                },
            });
            if (existing) {
                personId = existing.id;
            } else {
                const person = await prisma.person.create({
                    data: {
                        firstName: row.tenantFirstName,
                        lastName: row.tenantLastName,
                        organizationId: orgId,
                    },
                });
                personId = person.id;
            }
            personCache.set(personKey, personId);
        }

        // 4. Create Lease
        await prisma.lease.create({
            data: {
                unitId: unit.id,
                mainTenantId: personId,
                startDate: new Date(row.startDate),
                endDate: row.endDate ? new Date(row.endDate) : undefined,
                coldRent: row.coldRent,
                utilityAdvance: row.utilityAdvance,
                deposit: row.deposit,
                parkingRent: row.parkingRent ?? undefined,
                rentIncreaseRule: row.rentIncreaseRule ?? undefined,
                lastRentIncreaseAt: row.lastRentIncreaseAt
                    ? new Date(row.lastRentIncreaseAt)
                    : undefined,
                status: 'ACTIVE',
                currentUnitId: unit.id,
            },
        });

        created++;
    }

    revalidatePath('/dashboard/rent-roll');
    return { created };
}
