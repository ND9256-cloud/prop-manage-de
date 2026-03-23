ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
