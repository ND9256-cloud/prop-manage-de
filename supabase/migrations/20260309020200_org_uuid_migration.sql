-- =====================================================================
-- Migration: TEXT → UUID for all public schema ID columns
-- Version: 2 (with 7 review fixes applied)
-- =====================================================================
-- PREREQUISITES:
--   1. Database snapshot/backup taken ⚠️ MANDATORY
--   2. All preflight UUID validity checks passed (0 invalid values)
--   3. No FKs reference LedgerEntry.id (confirmed)
--   4. No FKs reference VpiIndex.id (confirmed)
--   5. No empty strings in nullable FK columns (confirmed)
--   6. warehouse.documents.property_id already UUID (confirmed)
--
-- This migration runs as a single transaction.
-- Rollback: Restore from snapshot.
-- =====================================================================

BEGIN;

SET lock_timeout = '10s';
SET statement_timeout = '0';

-- ═════════════════════════════════════════════════════════════════════
-- SECTION A: Drop all 18 FK constraints
-- ═════════════════════════════════════════════════════════════════════

-- FKs → Organization.id (6)
ALTER TABLE "User"           DROP CONSTRAINT "User_organizationId_fkey";
ALTER TABLE "Property"       DROP CONSTRAINT "Property_organizationId_fkey";
ALTER TABLE "Person"         DROP CONSTRAINT "Person_organizationId_fkey";
ALTER TABLE "BankConnection" DROP CONSTRAINT "BankConnection_organizationId_fkey";
ALTER TABLE "BankAccount"    DROP CONSTRAINT "BankAccount_organizationId_fkey";
ALTER TABLE "LedgerEntry"    DROP CONSTRAINT "LedgerEntry_organizationId_fkey";

-- FKs → Property.id (5)
ALTER TABLE "Unit"            DROP CONSTRAINT "Unit_propertyId_fkey";
ALTER TABLE "Document"        DROP CONSTRAINT "Document_propertyId_fkey";
ALTER TABLE "ServiceProvider" DROP CONSTRAINT "ServiceProvider_propertyId_fkey";
ALTER TABLE "BankTransaction" DROP CONSTRAINT "BankTransaction_propertyId_fkey";
ALTER TABLE "LedgerEntry"     DROP CONSTRAINT "LedgerEntry_propertyId_fkey";

-- FKs → Unit.id (3)
ALTER TABLE "Lease"       DROP CONSTRAINT "Lease_unitId_fkey";
ALTER TABLE "Lease"       DROP CONSTRAINT "Lease_currentUnitId_fkey";
ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_unitId_fkey";

-- FKs → Person.id (2)
ALTER TABLE "Lease"           DROP CONSTRAINT "Lease_mainTenantId_fkey";
ALTER TABLE "BankTransaction" DROP CONSTRAINT "BankTransaction_tenantId_fkey";

-- FKs → BankConnection.id (1)
ALTER TABLE "BankAccount" DROP CONSTRAINT "BankAccount_bankConnectionId_fkey";

-- FKs → BankAccount.id (1)
ALTER TABLE "BankTransaction" DROP CONSTRAINT "BankTransaction_bankAccountId_fkey";


-- ═════════════════════════════════════════════════════════════════════
-- SECTION B: Drop all 13 PK constraints
-- ═════════════════════════════════════════════════════════════════════

ALTER TABLE "Organization"    DROP CONSTRAINT "Organization_pkey";
ALTER TABLE "User"            DROP CONSTRAINT "User_pkey";
ALTER TABLE "Property"        DROP CONSTRAINT "Property_pkey";
ALTER TABLE "Person"          DROP CONSTRAINT "Person_pkey";
ALTER TABLE "Unit"            DROP CONSTRAINT "Unit_pkey";
ALTER TABLE "Lease"           DROP CONSTRAINT "Lease_pkey";
ALTER TABLE "BankConnection"  DROP CONSTRAINT "BankConnection_pkey";
ALTER TABLE "BankAccount"     DROP CONSTRAINT "BankAccount_pkey";
ALTER TABLE "BankTransaction" DROP CONSTRAINT "BankTransaction_pkey";
ALTER TABLE "Document"        DROP CONSTRAINT "Document_pkey";
ALTER TABLE "ServiceProvider" DROP CONSTRAINT "ServiceProvider_pkey";
ALTER TABLE "LedgerEntry"     DROP CONSTRAINT "LedgerEntry_pkey";
ALTER TABLE "VpiIndex"        DROP CONSTRAINT "VpiIndex_pkey";


-- ═════════════════════════════════════════════════════════════════════
-- SECTION C: ALTER TYPE TEXT → UUID (all PK + FK columns)
--   • Non-nullable columns: USING col::uuid
--   • Nullable columns:     USING NULLIF(col,'')::uuid  (defensive)
-- ═════════════════════════════════════════════════════════════════════

-- Organization (root)
ALTER TABLE "Organization" ALTER COLUMN id TYPE UUID USING id::uuid;

-- User
ALTER TABLE "User" ALTER COLUMN id TYPE UUID USING id::uuid;
ALTER TABLE "User" ALTER COLUMN "organizationId" TYPE UUID USING NULLIF("organizationId",'')::uuid;

-- Property
ALTER TABLE "Property" ALTER COLUMN id TYPE UUID USING id::uuid;
ALTER TABLE "Property" ALTER COLUMN "organizationId" TYPE UUID USING "organizationId"::uuid;

-- Person
ALTER TABLE "Person" ALTER COLUMN id TYPE UUID USING id::uuid;
ALTER TABLE "Person" ALTER COLUMN "organizationId" TYPE UUID USING "organizationId"::uuid;

-- Unit
ALTER TABLE "Unit" ALTER COLUMN id TYPE UUID USING id::uuid;
ALTER TABLE "Unit" ALTER COLUMN "propertyId" TYPE UUID USING "propertyId"::uuid;

-- Lease
ALTER TABLE "Lease" ALTER COLUMN id TYPE UUID USING id::uuid;
ALTER TABLE "Lease" ALTER COLUMN "unitId" TYPE UUID USING "unitId"::uuid;
ALTER TABLE "Lease" ALTER COLUMN "currentUnitId" TYPE UUID USING NULLIF("currentUnitId",'')::uuid;
ALTER TABLE "Lease" ALTER COLUMN "mainTenantId" TYPE UUID USING "mainTenantId"::uuid;

-- BankConnection
ALTER TABLE "BankConnection" ALTER COLUMN id TYPE UUID USING id::uuid;
ALTER TABLE "BankConnection" ALTER COLUMN "organizationId" TYPE UUID USING "organizationId"::uuid;

-- BankAccount
ALTER TABLE "BankAccount" ALTER COLUMN id TYPE UUID USING id::uuid;
ALTER TABLE "BankAccount" ALTER COLUMN "organizationId" TYPE UUID USING "organizationId"::uuid;
ALTER TABLE "BankAccount" ALTER COLUMN "bankConnectionId" TYPE UUID USING "bankConnectionId"::uuid;

-- BankTransaction
ALTER TABLE "BankTransaction" ALTER COLUMN id TYPE UUID USING id::uuid;
ALTER TABLE "BankTransaction" ALTER COLUMN "bankAccountId" TYPE UUID USING "bankAccountId"::uuid;
ALTER TABLE "BankTransaction" ALTER COLUMN "propertyId" TYPE UUID USING NULLIF("propertyId",'')::uuid;
ALTER TABLE "BankTransaction" ALTER COLUMN "tenantId" TYPE UUID USING NULLIF("tenantId",'')::uuid;

-- Document (Prisma model, not warehouse)
ALTER TABLE "Document" ALTER COLUMN id TYPE UUID USING id::uuid;
ALTER TABLE "Document" ALTER COLUMN "propertyId" TYPE UUID USING "propertyId"::uuid;

-- ServiceProvider
ALTER TABLE "ServiceProvider" ALTER COLUMN id TYPE UUID USING id::uuid;
ALTER TABLE "ServiceProvider" ALTER COLUMN "propertyId" TYPE UUID USING "propertyId"::uuid;

-- LedgerEntry (must drop DEFAULT first: gen_random_uuid()::text can't auto-cast)
ALTER TABLE "LedgerEntry" ALTER COLUMN id DROP DEFAULT;
ALTER TABLE "LedgerEntry" ALTER COLUMN id TYPE UUID USING id::uuid;
ALTER TABLE "LedgerEntry" ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE "LedgerEntry" ALTER COLUMN "organizationId" TYPE UUID USING "organizationId"::uuid;
ALTER TABLE "LedgerEntry" ALTER COLUMN "propertyId" TYPE UUID USING NULLIF("propertyId",'')::uuid;
ALTER TABLE "LedgerEntry" ALTER COLUMN "unitId" TYPE UUID USING NULLIF("unitId",'')::uuid;
ALTER TABLE "LedgerEntry" ALTER COLUMN "sourceDocumentId" TYPE UUID USING NULLIF("sourceDocumentId",'')::uuid;

-- VpiIndex (no FK dependents, standalone cast)
ALTER TABLE "VpiIndex" ALTER COLUMN id TYPE UUID USING id::uuid;


-- ═════════════════════════════════════════════════════════════════════
-- SECTION D: Re-add all 13 PK constraints
-- ═════════════════════════════════════════════════════════════════════

ALTER TABLE "Organization"    ADD CONSTRAINT "Organization_pkey"    PRIMARY KEY (id);
ALTER TABLE "User"            ADD CONSTRAINT "User_pkey"            PRIMARY KEY (id);
ALTER TABLE "Property"        ADD CONSTRAINT "Property_pkey"        PRIMARY KEY (id);
ALTER TABLE "Person"          ADD CONSTRAINT "Person_pkey"          PRIMARY KEY (id);
ALTER TABLE "Unit"            ADD CONSTRAINT "Unit_pkey"            PRIMARY KEY (id);
ALTER TABLE "Lease"           ADD CONSTRAINT "Lease_pkey"           PRIMARY KEY (id);
ALTER TABLE "BankConnection"  ADD CONSTRAINT "BankConnection_pkey"  PRIMARY KEY (id);
ALTER TABLE "BankAccount"     ADD CONSTRAINT "BankAccount_pkey"     PRIMARY KEY (id);
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_pkey" PRIMARY KEY (id);
ALTER TABLE "Document"        ADD CONSTRAINT "Document_pkey"        PRIMARY KEY (id);
ALTER TABLE "ServiceProvider" ADD CONSTRAINT "ServiceProvider_pkey" PRIMARY KEY (id);
ALTER TABLE "LedgerEntry"     ADD CONSTRAINT "LedgerEntry_pkey"     PRIMARY KEY (id);
ALTER TABLE "VpiIndex"        ADD CONSTRAINT "VpiIndex_pkey"        PRIMARY KEY (id);


-- ═════════════════════════════════════════════════════════════════════
-- SECTION E: Re-add all 18 FK constraints (verified exact rules)
-- ═════════════════════════════════════════════════════════════════════

-- FKs → Organization.id
ALTER TABLE "User"           ADD CONSTRAINT "User_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Property"       ADD CONSTRAINT "Property_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Person"         ADD CONSTRAINT "Person_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankConnection" ADD CONSTRAINT "BankConnection_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankAccount"    ADD CONSTRAINT "BankAccount_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry"    ADD CONSTRAINT "LedgerEntry_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- FKs → Property.id
ALTER TABLE "Unit"            ADD CONSTRAINT "Unit_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Document"        ADD CONSTRAINT "Document_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceProvider" ADD CONSTRAINT "ServiceProvider_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry"     ADD CONSTRAINT "LedgerEntry_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"(id) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- FKs → Unit.id
ALTER TABLE "Lease"       ADD CONSTRAINT "Lease_unitId_fkey"
    FOREIGN KEY ("unitId") REFERENCES "Unit"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Lease"       ADD CONSTRAINT "Lease_currentUnitId_fkey"
    FOREIGN KEY ("currentUnitId") REFERENCES "Unit"(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_unitId_fkey"
    FOREIGN KEY ("unitId") REFERENCES "Unit"(id) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- FKs → Person.id
ALTER TABLE "Lease"           ADD CONSTRAINT "Lease_mainTenantId_fkey"
    FOREIGN KEY ("mainTenantId") REFERENCES "Person"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Person"(id) ON DELETE SET NULL ON UPDATE CASCADE;

-- FKs → BankConnection.id
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_bankConnectionId_fkey"
    FOREIGN KEY ("bankConnectionId") REFERENCES "BankConnection"(id) ON DELETE CASCADE ON UPDATE CASCADE;

-- FKs → BankAccount.id
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_bankAccountId_fkey"
    FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"(id) ON DELETE CASCADE ON UPDATE CASCADE;


COMMIT;

-- ═════════════════════════════════════════════════════════════════════
-- POST-MIGRATION VERIFICATION (run manually after COMMIT)
-- ═════════════════════════════════════════════════════════════════════

-- V1: Verify all columns are now UUID
-- SELECT table_name, column_name, udt_name
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND column_name IN ('id', 'organizationId')
--   AND table_name IN ('Organization','User','Property','Person',
--                       'BankConnection','BankAccount','LedgerEntry')
-- ORDER BY table_name;
-- Expected: all rows show udt_name = 'uuid'

-- V2: Verify all 13 PKs restored
-- SELECT table_name, constraint_name
-- FROM information_schema.table_constraints
-- WHERE constraint_type = 'PRIMARY KEY'
--   AND table_schema = 'public'
-- ORDER BY table_name;
-- Expected: 13 rows

-- V3: Verify all 18 FKs restored
-- SELECT table_name, constraint_name
-- FROM information_schema.table_constraints
-- WHERE constraint_type = 'FOREIGN KEY'
--   AND table_schema = 'public'
-- ORDER BY table_name;
-- Expected: 18 rows

-- V4: Cross-tenant integrity (expected: 0)
-- SELECT COUNT(*) FROM warehouse.documents d
-- JOIN "Property" p ON d.property_id = p.id
-- WHERE d.org_id != p."organizationId";

-- V5: Extraction-document org consistency (expected: 0)
-- SELECT COUNT(*) FROM warehouse.document_extractions e
-- JOIN warehouse.documents d ON e.document_id = d.id
-- WHERE e.org_id != d.org_id;

-- V6: Review task-document org consistency (expected: 0)
-- SELECT COUNT(*) FROM warehouse.review_tasks t
-- JOIN warehouse.documents d ON t.document_id = d.id
-- WHERE t.org_id != d.org_id;
