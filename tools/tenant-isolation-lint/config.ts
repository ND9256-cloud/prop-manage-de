// tools/tenant-isolation-lint/config.ts
//
// Single source of truth for the tenant-isolation CI gate.
// All policy definitions live here. No config in JSON, YAML, or other files.

/** Approved org-context wrapper functions.
 *
 * Warehouse schema: wrapper-only (warehouseDb injects org_id predicate).
 * Public schema: direct Prisma filters using ctx.orgId from these wrappers.
 *
 * Adding a wrapper requires: (1) JSDoc security invariant, (2) update this list,
 * (3) add passing case to meta-test fixture.
 */
export const APPROVED_WRAPPERS = [
  'getOrgContext',
  'getOrgContextWritable',
  'getOrgContextAdmin',
  'getOrgId',
  'getOrgIdOrThrow',
  'warehouseDb',
] as const;

/** Prisma client identifiers the gate recognizes as tenant-relevant.
 *
 * Direct alias: `const db = prisma; db.foo.findMany(...)` — recognized in same scope.
 * Destructuring: `const { foo } = prisma; foo.findMany(...)` — recognized in same scope.
 * Transaction callback: `tx` param in `$transaction(async (tx) => {...})` — recognized.
 * Typed param: function param typed `PrismaClient` or `Prisma.TransactionClient` — recognized.
 *
 * NOT recognized (fails closed):
 *   - Helpers returning a Prisma client through indirection
 *   - `ctx.db` wrappers
 *   - Multi-level alias chains
 */
export const PRISMA_CLIENT_NAMES = ['prisma', 'db', 'tx', 'client'] as const;

/** Raw SQL methods banned in application code.
 *  Only allowed inside tenantSafeQuery wrappers (iteration 2) or with annotation. */
export const BANNED_RAW_SQL_METHODS = ['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe'] as const;

/** Prisma operations that require tenant-scoping on tenant-scoped models. */
export const PRISMA_OPERATIONS = [
  'findUnique', 'findFirst', 'findMany',
  'count', 'aggregate', 'groupBy',
  'create', 'createMany',
  'update', 'updateMany',
  'upsert',
  'delete', 'deleteMany',
] as const;

/** Nested relation operations that count as writes for tenancy purposes. */
export const NESTED_WRITE_OPERATIONS = [
  'create', 'createMany',
  'update', 'updateMany',
  'upsert',
  'delete', 'deleteMany',
  'connect', 'connectOrCreate',
  'set', 'disconnect',
] as const;

/** Escape hatch annotation pattern. */
export const DISABLE_COMMENT = '@tenant-isolation-disable-next-line';

/** Minimum reason length for escape annotations. */
export const MIN_REASON_LENGTH = 20;

/** Deny-list for placeholder reason strings (case-insensitive substring match). */
export const REASON_DENY_LIST = [
  'todo', 'fixme', 'xxx', 'temp', 'quick fix', 'legacy', 'hack', 'workaround',
  'will fix later', 'placeholder',
] as const;

/** In-scope paths — the gate inspects these directories. */
export const IN_SCOPE_PATHS = ['src/', 'supabase/functions/', 'prisma/seed.ts'] as const;

/** Directory/file allowlist — exempted from the gate entirely.
 *  Each entry must have a justification. Adding a new entry requires a PR. */
export const DIRECTORY_ALLOWLIST: Record<string, string> = {
  'scripts/create-org.ts': 'Operator-only org bootstrap, cross-tenant by design',
  'scripts/create-synthetic-user.ts': 'Synthetic monitor user creation, cross-tenant by design',
  'scripts/csv-import.ts': 'Operator-only bank transaction import, cross-tenant by design',
  'scripts/backfill-documents.ts': 'Operator-only document backfill, cross-tenant by design',
  'scripts/reset-synthetic-password.ts': 'One-shot password reset, operator-only',
  'supabase/migrations/': 'Schema migrations run against the whole database',
  'src/tests/cross-tenant-isolation.test.ts': 'Test fixture for cross-tenant boundary enforcement',
};

/** Path to Prisma schema for annotation parsing. */
export const SCHEMA_PATH = 'prisma/schema.prisma';
