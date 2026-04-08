-- Add missing columns to Property that exist in Prisma schema but not in DB
ALTER TABLE public."Property" ADD COLUMN IF NOT EXISTS unit_count integer;
ALTER TABLE public."Property" ADD COLUMN IF NOT EXISTS total_sqm decimal;
ALTER TABLE public."Property" ADD COLUMN IF NOT EXISTS short_code text;
