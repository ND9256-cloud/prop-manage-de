// __fixtures__/violations.ts
// Every pattern here MUST produce at least one violation.

// 1. Direct tenant-scoped model without org filter — MUST FAIL
async function unguardedDirect() {
  const result = await prisma.property.findMany({
    where: {},
  });
}

// 2. Direct tenant-scoped model delete without org filter — MUST FAIL
async function unguardedDelete() {
  await prisma.property.deleteMany({
    where: { name: 'test' },
  });
}

// 3. Indirect tenant-scoped model without FK filter — MUST FAIL
async function unguardedIndirect() {
  const units = await prisma.unit.findMany({
    where: { unitNumber: '1A' },
  });
}

// 4. Banned raw SQL — MUST FAIL
async function bannedRawSql() {
  const result = await prisma.$queryRaw`SELECT * FROM "Property"`;
}

// 5. Banned $executeRaw — MUST FAIL
async function bannedExecuteRaw() {
  await prisma.$executeRaw`DELETE FROM "Property"`;
}

// 6. Banned $queryRawUnsafe — MUST FAIL
async function bannedRawUnsafe() {
  await prisma.$queryRawUnsafe('SELECT * FROM "Property"');
}

// 7. Banned $executeRawUnsafe — MUST FAIL
async function bannedExecuteRawUnsafe() {
  await prisma.$executeRawUnsafe('DELETE FROM "Property"');
}

// 8. Transaction array with unguarded query — MUST FAIL
async function unguardedTransaction() {
  await prisma.$transaction([
    prisma.property.updateMany({
      where: {},
      data: { name: 'Bulk update' },
    }),
  ]);
}

// 9. Interactive transaction with unguarded query via tx — MUST FAIL
async function unguardedInteractiveTransaction() {
  await prisma.$transaction(async (tx) => {
    await tx.property.findMany({
      where: {},
    });
  });
}

// 10. Alias bypass attempt — MUST FAIL
async function aliasedBypass() {
  const db = prisma;
  const result = await db.property.findMany({
    where: {},
  });
}

// 11. Annotation with placeholder reason — MUST FAIL (reason denied)
async function placeholderAnnotation() {
  // @tenant-isolation-disable-next-line -- reason: TODO fix this later
  const result = await prisma.property.findMany({});
}

// 12. Annotation with too-short reason — MUST FAIL (reason too short)
async function shortAnnotation() {
  // @tenant-isolation-disable-next-line -- reason: just because
  const result = await prisma.property.findMany({});
}

// 13. Annotation without reason — MUST FAIL (invalid format)
async function noReasonAnnotation() {
  // @tenant-isolation-disable-next-line
  const result = await prisma.property.findMany({});
}
