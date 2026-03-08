-- ============================================================
-- Migration: Security hardening — rate limits + default deny
-- ============================================================

-- Item 5: Rate limiting table for inbound ingestion
CREATE TABLE IF NOT EXISTS warehouse.ingest_rate_limits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender       TEXT NOT NULL,
  org_id       UUID,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER DEFAULT 1,
  UNIQUE(sender, window_start)
);

ALTER TABLE warehouse.ingest_rate_limits ENABLE ROW LEVEL SECURITY;

-- Default deny for anon/authenticated roles
CREATE POLICY "default_deny" ON warehouse.ingest_rate_limits
  AS RESTRICTIVE
  FOR ALL
  USING (false);

-- Service role can read/write (Edge Functions use service_role key)
CREATE POLICY "service_role_all" ON warehouse.ingest_rate_limits
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Index for fast window lookups
CREATE INDEX ON warehouse.ingest_rate_limits (sender, window_start);
CREATE INDEX ON warehouse.ingest_rate_limits (org_id, window_start);

-- Helper function: check + increment rate limit
-- Returns true if request is ALLOWED, false if rate-limited
CREATE OR REPLACE FUNCTION warehouse.check_rate_limit(
  p_sender TEXT,
  p_org_id UUID,
  p_max_per_sender INTEGER DEFAULT 20,
  p_max_per_org INTEGER DEFAULT 50
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER AS $$
DECLARE
  v_window TIMESTAMPTZ;
  v_sender_count INTEGER;
  v_org_count INTEGER;
BEGIN
  v_window := date_trunc('hour', now());

  -- Upsert sender counter
  INSERT INTO warehouse.ingest_rate_limits (sender, org_id, window_start, count)
  VALUES (p_sender, p_org_id, v_window, 1)
  ON CONFLICT (sender, window_start) DO UPDATE
  SET count = warehouse.ingest_rate_limits.count + 1;

  -- Check sender limit
  SELECT count INTO v_sender_count
  FROM warehouse.ingest_rate_limits
  WHERE sender = p_sender AND window_start = v_window;

  IF v_sender_count > p_max_per_sender THEN
    RETURN false;
  END IF;

  -- Check org limit (sum across all senders for this org)
  IF p_org_id IS NOT NULL THEN
    SELECT COALESCE(SUM(count), 0) INTO v_org_count
    FROM warehouse.ingest_rate_limits
    WHERE org_id = p_org_id AND window_start = v_window;

    IF v_org_count > p_max_per_org THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$$;
