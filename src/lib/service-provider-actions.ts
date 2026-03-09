'use server';

import { prisma } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { autoAssignNewTransactions } from '@/lib/bank-assignment';
import { getOrgContextWritable } from '@/lib/org';


async function verifyPropertyAccess(propertyId: string, orgId: string) {
    const property = await prisma.property.findFirst({
        where: { id: propertyId, organizationId: orgId },
        select: { id: true },
    });
    if (!property) throw new Error('Property not found');
}

/** Trigger auto-assign on all bank accounts linked to this org. */
async function triggerAutoAssign(orgId: string) {
    const accounts = await prisma.bankAccount.findMany({
        where: { organizationId: orgId },
        select: { id: true },
    });
    for (const acc of accounts) {
        await autoAssignNewTransactions(acc.id);
    }
}

export async function createServiceProvider(formData: FormData) {
    const ctx = await getOrgContextWritable();
    const propertyId = formData.get('propertyId') as string;
    await verifyPropertyAccess(propertyId, ctx.orgId);

    await prisma.serviceProvider.create({
        data: {
            name: formData.get('name') as string,
            category: formData.get('category') as string,
            contractNumber: (formData.get('contractNumber') as string) || 'nicht bekannt',
            iban: (formData.get('iban') as string) || 'nicht bekannt',
            monthlyCost: formData.get('monthlyCost') ? parseFloat(formData.get('monthlyCost') as string) : null,
            yearlyCost: formData.get('yearlyCost') ? parseFloat(formData.get('yearlyCost') as string) : null,
            contactName: (formData.get('contactName') as string) || null,
            contactPhone: (formData.get('contactPhone') as string) || null,
            contactEmail: (formData.get('contactEmail') as string) || null,
            notes: (formData.get('notes') as string) || null,
            propertyId,
        },
    });

    // Auto-assign existing unassigned transactions that match this new SP
    await triggerAutoAssign(ctx.orgId);

    revalidatePath(`/dashboard/properties/${propertyId}`);
    revalidatePath('/dashboard/banking');
    return { success: true };
}

export async function updateServiceProvider(formData: FormData) {
    const ctx = await getOrgContextWritable();
    const id = formData.get('id') as string;

    const existing = await prisma.serviceProvider.findFirst({
        where: { id, property: { organizationId: ctx.orgId } },
        select: { id: true, propertyId: true },
    });
    if (!existing) throw new Error('Not found');

    await prisma.serviceProvider.update({
        where: { id },
        data: {
            name: formData.get('name') as string,
            category: formData.get('category') as string,
            contractNumber: (formData.get('contractNumber') as string) || 'nicht bekannt',
            iban: (formData.get('iban') as string) || 'nicht bekannt',
            monthlyCost: formData.get('monthlyCost') ? parseFloat(formData.get('monthlyCost') as string) : null,
            yearlyCost: formData.get('yearlyCost') ? parseFloat(formData.get('yearlyCost') as string) : null,
            contactName: (formData.get('contactName') as string) || null,
            contactPhone: (formData.get('contactPhone') as string) || null,
            contactEmail: (formData.get('contactEmail') as string) || null,
            notes: (formData.get('notes') as string) || null,
        },
    });

    // Auto-assign after SP update (IBAN or ref might have changed)
    await triggerAutoAssign(ctx.orgId);

    revalidatePath(`/dashboard/properties/${existing.propertyId}`);
    revalidatePath('/dashboard/banking');
    return { success: true };
}

export async function deleteServiceProvider(id: string) {
    const ctx = await getOrgContextWritable();

    const existing = await prisma.serviceProvider.findFirst({
        where: { id, property: { organizationId: ctx.orgId } },
        select: { id: true, propertyId: true },
    });
    if (!existing) throw new Error('Not found');

    await prisma.serviceProvider.delete({ where: { id } });

    revalidatePath(`/dashboard/properties/${existing.propertyId}`);
    revalidatePath('/dashboard/banking');
    return { success: true };
}
