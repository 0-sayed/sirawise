ALTER TABLE "ai_operation" ADD COLUMN "unknown_booked_micros" bigint;
--> statement-breakpoint
CREATE FUNCTION master_cv_ai_unknown_booking_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF current_user <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID)) THEN
    IF TG_OP='INSERT' THEN
      IF NEW.unknown_booked_micros IS NOT NULL THEN RAISE EXCEPTION 'Protected AI accounting'; END IF;
    ELSIF OLD.unknown_booked_micros IS DISTINCT FROM NEW.unknown_booked_micros THEN
      RAISE EXCEPTION 'Protected AI accounting';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_unknown_booking_guard BEFORE INSERT OR UPDATE ON ai_operation
  FOR EACH ROW EXECUTE FUNCTION master_cv_ai_unknown_booking_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION master_cv_ai_attempt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (OLD.id,OLD.user_id,OLD.operation_id,OLD.ordinal,OLD.step_id,OLD.lease_token,OLD.started_at)
    IS DISTINCT FROM (NEW.id,NEW.user_id,NEW.operation_id,NEW.ordinal,NEW.step_id,NEW.lease_token,NEW.started_at)
    THEN RAISE EXCEPTION 'Immutable AI attempt identity'; END IF;
  IF OLD.finished_at IS NULL THEN RETURN NEW; END IF;

  -- A late reply can fill in the cost of an issued call. The verdict and pass closure stay frozen.
  IF OLD.step_id<>'verify' OR OLD.cost_micros IS NOT NULL OR NEW.cost_micros IS NOT NULL
    OR OLD.output->'_verifyJournalVersion' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(OLD.output->'_verifyCalls') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.output->'_verifyCalls') IS DISTINCT FROM 'array'
    OR OLD.output IS NOT DISTINCT FROM NEW.output
    OR OLD.output-'_verifyCalls' IS DISTINCT FROM NEW.output-'_verifyCalls'
    OR to_jsonb(OLD)-'output'-'cost_micros' IS DISTINCT FROM to_jsonb(NEW)-'output'-'cost_micros'
    THEN RAISE EXCEPTION 'Immutable completed AI attempt'; END IF;
  IF jsonb_array_length(OLD.output->'_verifyCalls')<>jsonb_array_length(NEW.output->'_verifyCalls') OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(OLD.output->'_verifyCalls') WITH ORDINALITY AS before_call(call,position)
    JOIN jsonb_array_elements(NEW.output->'_verifyCalls') WITH ORDINALITY AS after_call(call,position) USING (position)
    WHERE before_call.call IS DISTINCT FROM after_call.call AND (
      before_call.call->>'outcome' IS DISTINCT FROM 'pending'
      OR before_call.call->'costMicros' IS DISTINCT FROM 'null'::jsonb
      OR before_call.call-'costMicros' IS DISTINCT FROM after_call.call-'costMicros'
      OR jsonb_typeof(after_call.call->'costMicros') IS DISTINCT FROM 'number'
      OR after_call.call->>'costMicros' !~ '^[0-9]{1,16}$'
    )
  ) THEN RAISE EXCEPTION 'Immutable completed AI attempt'; END IF;
  SELECT CASE WHEN count(*)=count(*) FILTER (WHERE jsonb_typeof(call->'costMicros')='number')
    THEN sum((call->>'costMicros')::bigint) END INTO NEW.cost_micros
    FROM jsonb_array_elements(NEW.output->'_verifyCalls') AS physical(call);
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $migration$ DECLARE namespace text := current_schema(); BEGIN
  EXECUTE format($ddl$
CREATE OR REPLACE FUNCTION %1$I.master_cv_ai_reconcile_budget(operation_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  o %1$I.ai_operation;
  b %1$I.ai_platform_budget;
  measured bigint;
  booked bigint := 0;
  unbounded boolean := false;
  attempt record;
  physical_call jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('master_cv_ai_budget',0));
  SELECT * INTO o FROM %1$I.ai_operation WHERE id=operation_id AND user_id=NULLIF(current_setting('app.user_id',true),'') FOR UPDATE;
  IF NOT FOUND OR o.budget_id IS NULL OR o.state NOT IN ('waiting_review','succeeded','failed','cancelled') THEN RETURN; END IF;
  SELECT CASE WHEN bool_and(finished_at IS NOT NULL AND cost_micros IS NOT NULL)
    THEN sum(cost_micros) WHEN count(*)=0 THEN 0 ELSE NULL END INTO measured
    FROM %1$I.ai_operation_attempt a WHERE a.operation_id=o.id;
  SELECT * INTO b FROM %1$I.ai_platform_budget WHERE id=o.budget_id FOR UPDATE;
  IF o.budget_closed AND o.reserved_micros=0 AND
    (o.actual_micros IS NOT NULL OR measured IS NOT NULL OR o.unknown_booked_micros IS NULL) THEN
    IF o.actual_micros IS NULL AND measured IS NOT NULL THEN
      -- Rows settled before this migration booked the full cap.
      UPDATE %1$I.ai_platform_budget
        SET spent_micros=spent_micros-COALESCE(o.unknown_booked_micros,b.request_cap_micros)+measured WHERE id=b.id;
      UPDATE %1$I.ai_operation SET actual_micros=measured,unknown_booked_micros=NULL WHERE id=o.id;
    END IF;
    RETURN;
  END IF;
  IF measured IS NULL AND (o.unknown_booked_micros IS NOT NULL OR o.deadline_at + interval '5 minutes' <= now()) THEN
    FOR attempt IN SELECT a.* FROM %1$I.ai_operation_attempt a WHERE a.operation_id=o.id LOOP
      IF attempt.finished_at IS NOT NULL AND attempt.cost_micros IS NOT NULL THEN
        booked := booked + attempt.cost_micros;
      ELSIF attempt.step_id='verify' AND attempt.output->'_verifyJournalVersion'='1'::jsonb
          AND jsonb_typeof(attempt.output->'_verifyCalls')='array' THEN
        IF jsonb_array_length(attempt.output->'_verifyCalls')=0 THEN unbounded := true; END IF;
        FOR physical_call IN SELECT value FROM jsonb_array_elements(attempt.output->'_verifyCalls') LOOP
          IF jsonb_typeof(physical_call->'boundMicros')='number'
            AND physical_call->>'boundMicros' ~ '^[1-9][0-9]{0,15}$' THEN
            IF physical_call->'costMicros'='null'::jsonb THEN
              booked := booked + (physical_call->>'boundMicros')::bigint;
              CONTINUE;
            ELSIF jsonb_typeof(physical_call->'costMicros')='number'
              AND physical_call->>'costMicros' ~ '^[0-9]{1,16}$'
              AND (physical_call->>'outcome' <> 'pending' OR physical_call->'output'='null'::jsonb) THEN
              booked := booked + (physical_call->>'costMicros')::bigint;
              CONTINUE;
            END IF;
          END IF;
          unbounded := true;
        END LOOP;
      ELSE
        unbounded := true;
      END IF;
    END LOOP;
    -- The reservation covers the whole operation, including its measured charges.
    IF unbounded THEN booked := greatest(booked, CASE WHEN o.unknown_booked_micros IS NULL
      THEN o.reserved_micros ELSE b.request_cap_micros END); END IF;
    UPDATE %1$I.ai_platform_budget SET active=active-CASE WHEN o.budget_closed THEN 0 ELSE 1 END,
      spent_micros=spent_micros+booked-COALESCE(o.unknown_booked_micros,0),reserved_micros=reserved_micros-o.reserved_micros WHERE id=b.id;
    UPDATE %1$I.ai_operation SET actual_micros=NULL,unknown_booked_micros=booked,budget_closed=true,reserved_micros=0 WHERE id=o.id;
    RETURN;
  END IF;
  IF o.budget_closed AND measured IS NULL THEN RETURN; END IF;
  UPDATE %1$I.ai_platform_budget SET active=active-CASE WHEN o.budget_closed THEN 0 ELSE 1 END,
    reserved_micros=reserved_micros-CASE WHEN measured IS NULL THEN 0 ELSE o.reserved_micros END,
    spent_micros=spent_micros+COALESCE(measured,0) WHERE id=b.id;
  UPDATE %1$I.ai_operation SET actual_micros=measured,budget_closed=true,
    reserved_micros=CASE WHEN measured IS NULL THEN o.reserved_micros ELSE 0 END WHERE id=o.id;
END $fn$;
$ddl$, namespace);
END $migration$;
