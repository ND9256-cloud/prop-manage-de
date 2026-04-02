-- Cost overview view: aggregates applied documents by property, cost class, year
CREATE OR REPLACE VIEW warehouse.v_cost_overview AS
SELECT
  d.property_id,
  di.cost_class,
  di.umlagefaehig,
  EXTRACT(YEAR FROM COALESCE(di.period_start::date, d.created_at))::int AS year,
  COUNT(*) AS doc_count,
  SUM((e.extracted_fields->>'amount')::numeric) AS total_amount
FROM warehouse.documents d
JOIN warehouse.document_intelligence di
  ON d.id = di.document_id AND di.is_current = true
LEFT JOIN warehouse.document_extractions e
  ON d.id = e.document_id AND e.is_current = true
WHERE di.cost_class IS NOT NULL
  AND d.status = 'applied'
GROUP BY d.property_id, di.cost_class, di.umlagefaehig, year;

-- Vendor summary view: aggregates applied documents by property and vendor
CREATE OR REPLACE VIEW warehouse.v_vendor_summary AS
SELECT
  d.property_id,
  di.entity_name,
  COUNT(*) AS doc_count,
  SUM((e.extracted_fields->>'amount')::numeric) AS total_amount,
  MAX(di.period_start) AS last_activity
FROM warehouse.documents d
JOIN warehouse.document_intelligence di
  ON d.id = di.document_id AND di.is_current = true
LEFT JOIN warehouse.document_extractions e
  ON d.id = e.document_id AND e.is_current = true
WHERE di.entity_type = 'dienstleister'
  AND d.status = 'applied'
GROUP BY d.property_id, di.entity_name;

-- Insurance status view: applied insurance documents with intelligence
CREATE OR REPLACE VIEW warehouse.v_insurance_status AS
SELECT
  d.property_id,
  di.entity_name,
  di.period_start,
  di.period_end,
  di.summary,
  d.doc_type,
  d.id AS document_id,
  d.file_name
FROM warehouse.documents d
JOIN warehouse.document_intelligence di
  ON d.id = di.document_id AND di.is_current = true
WHERE d.doc_type LIKE 'versicherung%'
  AND d.status = 'applied'
ORDER BY d.property_id, di.period_start DESC;

-- Open actions view: documents with pending action signals
CREATE OR REPLACE VIEW warehouse.v_open_actions AS
SELECT
  d.property_id,
  d.id AS document_id,
  d.file_name,
  d.doc_type,
  di.entity_name,
  di.summary,
  di.action_signals
FROM warehouse.documents d
JOIN warehouse.document_intelligence di
  ON d.id = di.document_id AND di.is_current = true
WHERE di.action_signals IS NOT NULL
  AND jsonb_array_length(di.action_signals) > 0
  AND d.status = 'applied';

-- Property summary view: doc and photo counts per property
CREATE OR REPLACE VIEW warehouse.v_property_summary AS
SELECT
  p.id AS property_id,
  p.short_code,
  p.name,
  (SELECT count(*) FROM warehouse.documents WHERE property_id = p.id AND status = 'applied' AND doc_type != 'foto') AS doc_count,
  (SELECT count(*) FROM warehouse.documents WHERE property_id = p.id AND doc_type = 'foto') AS photo_count
FROM public."Property" p;

-- Grant SELECT on all views to all roles
GRANT SELECT ON warehouse.v_cost_overview TO service_role, authenticated, anon;
GRANT SELECT ON warehouse.v_vendor_summary TO service_role, authenticated, anon;
GRANT SELECT ON warehouse.v_insurance_status TO service_role, authenticated, anon;
GRANT SELECT ON warehouse.v_open_actions TO service_role, authenticated, anon;
GRANT SELECT ON warehouse.v_property_summary TO service_role, authenticated, anon;
