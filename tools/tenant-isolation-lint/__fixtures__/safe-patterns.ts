// @ts-nocheck
// __fixtures__/safe-patterns.ts
// These patterns MUST produce zero violations from the gate.

import { getOrgContext, getOrgContextWritable, warehouseDb } from '@/lib/org';

// 1. Direct tenant-scoped with org filter in where clause
async function safeDirectQuery() {
  const ctx = await getOrgContext();
  const result = await prisma.property.findMany({
    where: { organizationId: ctx.orgId },
  });
  return result;
}

// 2. Direct tenant-scoped with wrapper
async function safeWrapperQuery() {
  const ctx = await getOrgContextWritable();
  const property = await prisma.property.update({
    where: { id: 'some-id', organizationId: ctx.orgId },
    data: { name: 'Updated' },
  });
}

// 3. Indirect tenant-scoped with FK filter
async function safeIndirectQuery() {
  const ctx = await getOrgContext();
  const units = await prisma.unit.findMany({
    where: { propertyId: 'some-property-id' },
  });
}

// 4. Global model — no filter needed
async function safeGlobalQuery() {
  const orgs = await prisma.organization.findMany({});
}

// 5. Transaction with org filter
async function safeTransaction() {
  const ctx = await getOrgContextWritable();
  await prisma.$transaction([
    prisma.property.updateMany({
      where: { organizationId: ctx.orgId },
      data: { name: 'Bulk update' },
    }),
  ]);
}

// 6. Interactive transaction with tx alias
async function safeInteractiveTransaction() {
  const ctx = await getOrgContextWritable();
  await prisma.$transaction(async (tx) => {
    await tx.property.findMany({
      where: { organizationId: ctx.orgId },
    });
  });
}

// 7. Valid annotation escape
async function safeAnnotated() {
  // @tenant-isolation-disable-next-line -- reason: org bootstrap creates properties across all orgs during initial setup
  const allProps = await prisma.property.findMany({});
}

// 8. Warehouse db wrapper
async function safeWarehouse() {
  const ctx = await getOrgContext();
  const db = warehouseDb(ctx.orgId);
}

// 9. Direct alias recognized
async function safeAlias() {
  const ctx = await getOrgContext();
  const db = prisma;
  const result = await db.property.findMany({
    where: { organizationId: ctx.orgId },
  });
}
