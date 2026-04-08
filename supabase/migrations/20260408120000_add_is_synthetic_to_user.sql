-- Add is_synthetic flag to User table for synthetic monitoring
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "is_synthetic" BOOLEAN NOT NULL DEFAULT false;
