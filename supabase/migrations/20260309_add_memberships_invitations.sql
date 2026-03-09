-- =====================================================================
-- Add memberships and invitations tables
-- Safe: does not modify any existing tables or data
-- =====================================================================

-- 1. Create MembershipRole enum
DO $$ BEGIN
    CREATE TYPE "MembershipRole" AS ENUM ('owner', 'manager');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Create memberships table
CREATE TABLE IF NOT EXISTS "memberships" (
    "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId"    UUID NOT NULL REFERENCES "User"(id),
    "orgId"     UUID NOT NULL REFERENCES "Organization"(id),
    "role"      "MembershipRole" NOT NULL DEFAULT 'manager',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "memberships_userId_orgId_key" UNIQUE ("userId", "orgId")
);

-- 3. Create invitations table
CREATE TABLE IF NOT EXISTS "invitations" (
    "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "orgId"       UUID NOT NULL REFERENCES "Organization"(id),
    "email"       TEXT NOT NULL,
    "emailNorm"   TEXT NOT NULL,
    "role"        "MembershipRole" NOT NULL DEFAULT 'manager',
    "tokenHash"   TEXT NOT NULL,
    "invitedBy"   UUID NOT NULL,
    "expiresAt"   TIMESTAMPTZ NOT NULL,
    "acceptedAt"  TIMESTAMPTZ,
    "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "invitations_tokenHash_key" UNIQUE ("tokenHash"),
    CONSTRAINT "invitations_emailNorm_orgId_key" UNIQUE ("emailNorm", "orgId")
);

-- 4. CHECK constraints on role
ALTER TABLE "memberships"
    ADD CONSTRAINT "memberships_role_check"
    CHECK ("role" IN ('owner', 'manager'));

ALTER TABLE "invitations"
    ADD CONSTRAINT "invitations_role_check"
    CHECK ("role" IN ('owner', 'manager'));

-- 5. Indexes for common queries
CREATE INDEX IF NOT EXISTS "memberships_userId_idx" ON "memberships" ("userId");
CREATE INDEX IF NOT EXISTS "memberships_orgId_idx" ON "memberships" ("orgId");
CREATE INDEX IF NOT EXISTS "invitations_orgId_idx" ON "invitations" ("orgId");
CREATE INDEX IF NOT EXISTS "invitations_emailNorm_idx" ON "invitations" ("emailNorm");
