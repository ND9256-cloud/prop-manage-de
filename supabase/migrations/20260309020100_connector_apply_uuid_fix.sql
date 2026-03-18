-- =====================================================================
-- Fix connector.apply() for UUID columns
-- Remove ::TEXT casts, add ::UUID casts for JSONB payload values
-- =====================================================================

CREATE OR REPLACE FUNCTION connector.apply(
  p_org_id UUID,
  p_document_id UUID,
  p_extraction_id UUID,
  p_action TEXT,
  p_payload JSONB,
  p_triggered_by TEXT DEFAULT NULL,
  p_trigger_type TEXT DEFAULT 'auto',
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_existing_apply warehouse.apply_log%ROWTYPE;
  v_pm_entity_id TEXT;
  v_result JSONB;
BEGIN
  -- Idempotency: if this key already succeeded, return cached result
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing_apply
    FROM warehouse.apply_log
    WHERE idempotency_key = p_idempotency_key AND status = 'success';
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotent_replay', true,
        'pm_entity_id', v_existing_apply.pm_entity_id,
        'action', p_action
      );
    END IF;
  END IF;

  BEGIN
    IF p_action = 'ledger.append' THEN
      INSERT INTO public."LedgerEntry" (
        "organizationId", "propertyId", "unitId",
        "entryType", category, amount, currency,
        "entryDate", "vendorName", "invoiceNumber",
        description, "sourceDocumentId"
      ) VALUES (
        p_org_id,  -- UUID directly (was p_org_id::TEXT)
        NULLIF(p_payload->>'property_id', '')::UUID,
        NULLIF(p_payload->>'unit_id', '')::UUID,
        COALESCE(p_payload->>'entry_type', 'expense'),
        p_payload->>'category_hint',
        COALESCE((p_payload->>'amount')::DOUBLE PRECISION, 0),
        COALESCE(p_payload->>'currency', 'EUR'),
        CASE WHEN p_payload->>'invoice_date' IS NOT NULL
             THEN (p_payload->>'invoice_date')::DATE
             ELSE CURRENT_DATE END,
        p_payload->>'vendor_name',
        p_payload->>'invoice_number',
        p_payload->>'description',
        p_document_id  -- UUID directly (was p_document_id::TEXT)
      ) RETURNING id::TEXT INTO v_pm_entity_id;

    ELSIF p_action = 'lease.create' THEN
      INSERT INTO public."Lease" (
        id, "startDate", status, "coldRent", "utilityAdvance",
        deposit, "unitId", "mainTenantId",
        "createdAt", "updatedAt"
      ) VALUES (
        gen_random_uuid(),  -- UUID directly (was gen_random_uuid()::TEXT)
        CASE WHEN p_payload->>'lease_start' IS NOT NULL
             THEN (p_payload->>'lease_start')::TIMESTAMP
             ELSE now() END,
        'ACTIVE'::"LeaseStatus",
        COALESCE((p_payload->>'cold_rent')::DOUBLE PRECISION, 0),
        COALESCE((p_payload->>'utility_advance')::DOUBLE PRECISION, 0),
        COALESCE((p_payload->>'deposit')::DOUBLE PRECISION, 0),
        (p_payload->>'unit_id')::UUID,     -- UUID cast (was TEXT)
        (p_payload->>'tenant_id')::UUID,   -- UUID cast (was TEXT)
        now(), now()
      ) RETURNING id::TEXT INTO v_pm_entity_id;

    ELSE
      RAISE EXCEPTION 'Unknown connector action: %', p_action;
    END IF;

    -- Log success
    INSERT INTO warehouse.apply_log (
      document_id, extraction_id, org_id,
      triggered_by, trigger_type,
      connector_action, pm_entity_type, pm_entity_id,
      request_payload, status, idempotency_key
    ) VALUES (
      p_document_id, p_extraction_id, p_org_id,
      CASE WHEN p_triggered_by IS NOT NULL THEN p_triggered_by::UUID ELSE NULL END,
      p_trigger_type,
      p_action,
      split_part(p_action, '.', 1),
      CASE WHEN v_pm_entity_id IS NOT NULL THEN v_pm_entity_id::UUID ELSE NULL END,
      p_payload,
      'success',
      p_idempotency_key
    );

    -- Update document status
    UPDATE warehouse.documents
    SET status = 'applied', applied_at = now(), updated_at = now()
    WHERE id = p_document_id;

    v_result := jsonb_build_object(
      'success', true,
      'pm_entity_id', v_pm_entity_id,
      'action', p_action
    );

  EXCEPTION WHEN OTHERS THEN
    INSERT INTO warehouse.apply_log (
      document_id, extraction_id, org_id,
      triggered_by, trigger_type,
      connector_action, pm_entity_type,
      request_payload, status,
      error_message, idempotency_key
    ) VALUES (
      p_document_id, p_extraction_id, p_org_id,
      CASE WHEN p_triggered_by IS NOT NULL THEN p_triggered_by::UUID ELSE NULL END,
      p_trigger_type,
      p_action, split_part(p_action, '.', 1),
      p_payload, 'failed',
      SQLERRM, p_idempotency_key
    );
    v_result := jsonb_build_object(
      'success', false,
      'error', SQLERRM,
      'action', p_action
    );
  END;

  RETURN v_result;
END;
$$;
