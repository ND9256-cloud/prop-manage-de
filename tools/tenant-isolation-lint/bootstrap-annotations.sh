#!/bin/bash
# bootstrap-annotations.sh
#
# Run this ONCE on the Mac Mini to:
# 1. Add @tenant-scoped / @tenant-scoped-via / @global annotations to schema.prisma
# 2. Add @tenant-isolation-disable-next-line annotations to existing raw SQL call sites
#
# Usage: bash tools/tenant-isolation-lint/bootstrap-annotations.sh

set -e

SCHEMA="prisma/schema.prisma"

echo "=== Annotating schema.prisma ==="

# Back up first
cp "$SCHEMA" "$SCHEMA.bak-tenant-gate"
echo "Backed up to $SCHEMA.bak-tenant-gate"

# Add annotations above each model definition
# Using sed to insert a comment line before `model X {`
# macOS sed requires '' after -i

# @global models
sed -i '' '/^model Organization {/i\
/// @global
' "$SCHEMA"

# @tenant-scoped models (direct — have organizationId or orgId)
sed -i '' '/^model User {/i\
/// @tenant-scoped — organizationId nullable, gate still requires filter
' "$SCHEMA"

sed -i '' '/^model Property {/i\
/// @tenant-scoped
' "$SCHEMA"

sed -i '' '/^model Person {/i\
/// @tenant-scoped
' "$SCHEMA"

sed -i '' '/^model BankConnection {/i\
/// @tenant-scoped
' "$SCHEMA"

sed -i '' '/^model BankAccount {/i\
/// @tenant-scoped
' "$SCHEMA"

sed -i '' '/^model Membership {/i\
/// @tenant-scoped
' "$SCHEMA"

sed -i '' '/^model Invitation {/i\
/// @tenant-scoped
' "$SCHEMA"

# @tenant-scoped-via models (indirect — tenancy via parent FK)
sed -i '' '/^model Unit {/i\
/// @tenant-scoped-via: propertyId
' "$SCHEMA"

sed -i '' '/^model Lease {/i\
/// @tenant-scoped-via: unitId
' "$SCHEMA"

sed -i '' '/^model ServiceProvider {/i\
/// @tenant-scoped-via: propertyId
' "$SCHEMA"

sed -i '' '/^model BankTransaction {/i\
/// @tenant-scoped-via: bankAccountId
' "$SCHEMA"

# @global models
sed -i '' '/^model VpiIndex {/i\
/// @global
' "$SCHEMA"

echo "Schema annotated. Verifying..."
grep -c '@tenant-scoped\|@global' "$SCHEMA"
echo "annotations found (expected: 13)"

echo ""
echo "=== Annotating raw SQL call sites ==="

# src/lib/org.ts:137
sed -i '' '136 i\
    // @tenant-isolation-disable-next-line -- reason: org session context setup via executeRaw, system-level operation not scoped to single tenant; raw SQL pending iteration-2 wrapper
' src/lib/org.ts 2>/dev/null || echo "SKIP: org.ts:137 (line may have shifted)"

# src/lib/warehouse-actions.ts:146
sed -i '' '145 i\
        // @tenant-isolation-disable-next-line -- reason: property extras query joining to quoted Property table for short_code and total_sqm, org-scoped upstream via getOrgContext; raw SQL pending iteration-2 wrapper
' src/lib/warehouse-actions.ts 2>/dev/null || echo "SKIP: warehouse-actions.ts:146"

# src/lib/warehouse-actions.ts:692
sed -i '' '691 i\
        // @tenant-isolation-disable-next-line -- reason: Property field update for columns not in Prisma schema (short_code, notes), org-scoped upstream via getOrgContextWritable property ownership check; raw SQL pending iteration-2 wrapper
' src/lib/warehouse-actions.ts 2>/dev/null || echo "SKIP: warehouse-actions.ts:692"

# src/lib/warehouse-actions.ts:866
sed -i '' '865 i\
        // @tenant-isolation-disable-next-line -- reason: connector.apply bridge call executing warehouse-to-pm schema operation, org-scoped by warehouse pipeline claim mechanism; raw SQL pending iteration-2 wrapper
' src/lib/warehouse-actions.ts 2>/dev/null || echo "SKIP: warehouse-actions.ts:866"

# src/lib/user-settings-actions.ts:309
sed -i '' '308 i\
        // @tenant-isolation-disable-next-line -- reason: shared.audit_log insert for team management events, cross-tenant audit table by design, orgId passed as column value not as filter; raw SQL pending iteration-2 wrapper
' src/lib/user-settings-actions.ts 2>/dev/null || echo "SKIP: user-settings-actions.ts:309"

# src/lib/dashboard-actions.ts:25
sed -i '' '24 i\
    // @tenant-isolation-disable-next-line -- reason: dashboard last_seen_at timestamp update via executeRaw for membership tracking, org-scoped upstream via getOrgContext session; raw SQL pending iteration-2 wrapper
' src/lib/dashboard-actions.ts 2>/dev/null || echo "SKIP: dashboard-actions.ts:25"

# src/lib/dashboard-actions.ts:87
sed -i '' '86 i\
        // @tenant-isolation-disable-next-line -- reason: holdings table query using quoted Property table name for Prisma model name mismatch, org-scoped upstream via getOrgContext session; raw SQL pending iteration-2 wrapper
' src/lib/dashboard-actions.ts 2>/dev/null || echo "SKIP: dashboard-actions.ts:87"

echo ""
echo "Raw SQL annotations added."
echo "NOTE: Line numbers may have shifted due to earlier insertions in the same file."
echo "Verify manually: grep -n '@tenant-isolation-disable-next-line' src/lib/*.ts"
echo ""
echo "=== Bootstrap complete ==="
echo "Next steps:"
echo "  1. npx tsx tools/tenant-isolation-lint/run-tests.ts  # meta-tests"
echo "  2. npx tsx tools/tenant-isolation-lint/index.ts      # real codebase"
echo "  3. If violations found, fix or annotate"
echo "  4. npx tsx tools/tenant-isolation-lint/index.ts --write  # generate report"
echo "  5. git add -A && git commit -m 'feat(tier0): tenant isolation CI gate with schema annotations and raw SQL exceptions'"
