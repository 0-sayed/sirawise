CREATE TABLE ai_platform_capacity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  max_running integer NOT NULL CHECK (max_running BETWEEN 1 AND 100)
);
--> statement-breakpoint
INSERT INTO ai_platform_capacity(max_running) VALUES (30);
--> statement-breakpoint
ALTER TABLE ai_platform_capacity ENABLE ROW LEVEL SECURITY;
CREATE POLICY capacity_owner ON ai_platform_capacity FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
ALTER TABLE ai_platform_capacity FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_operation ALTER COLUMN queue_expires_at SET DEFAULT now() + interval '5 minutes';
--> statement-breakpoint
-- Shorten pending waits without changing the timestamps of work that already ran.
ALTER TABLE ai_operation DISABLE TRIGGER ai_operation_guard;
ALTER TABLE ai_operation NO FORCE ROW LEVEL SECURITY;
UPDATE ai_operation SET queue_expires_at=created_at+interval '5 minutes'
  WHERE state='queued' AND queue_expires_at>created_at+interval '5 minutes';
ALTER TABLE ai_operation FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_operation ENABLE TRIGGER ai_operation_guard;
--> statement-breakpoint
-- Earlier versions settled translation at submission. Restore the reservation only when
-- no part ever started so the new first-claim settlement or cancellation can close it.
ALTER TABLE ai_usage_ledger NO FORCE ROW LEVEL SECURITY;
DELETE FROM ai_usage_ledger ledger USING ai_operation root
  WHERE ledger.operation_id=root.id AND ledger.kind='settle' AND root.kind='review.translation'
    AND root.state='queued' AND NOT EXISTS (
      SELECT 1 FROM ai_operation part
      WHERE part.user_id=root.user_id AND part.kind=root.kind
        AND part.parameters->'translationBatch'->>'rootId'=root.id
        AND (part.execution_started_at IS NOT NULL OR part.state<>'queued')
    );
ALTER TABLE ai_usage_ledger FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION master_cv_ai_operation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF current_user <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID)) THEN
    IF TG_OP='INSERT' THEN
      IF NEW.budget_id IS NOT NULL OR NEW.reserved_micros<>0 OR NEW.actual_micros IS NOT NULL OR NEW.budget_closed
        THEN RAISE EXCEPTION 'Protected AI accounting'; END IF;
    ELSIF (OLD.budget_id,OLD.reserved_micros,OLD.actual_micros,OLD.budget_closed)
      IS DISTINCT FROM (NEW.budget_id,NEW.reserved_micros,NEW.actual_micros,NEW.budget_closed)
      THEN RAISE EXCEPTION 'Protected AI accounting'; END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    NEW.queue_expires_at := NEW.created_at + interval '5 minutes';
    NEW.execution_started_at := NULL;
    RETURN NEW;
  END IF;
  IF (OLD.id,OLD.created_at,OLD.user_id,OLD.request_key,OLD.fingerprint,OLD.kind,OLD.sources,OLD.route,OLD.consent_version,OLD.prompt_version,OLD.schema_version,OLD.parameters,OLD.copy_claim,OLD.deadline_at,OLD.queue_expires_at)
    IS DISTINCT FROM (NEW.id,NEW.created_at,NEW.user_id,NEW.request_key,NEW.fingerprint,NEW.kind,NEW.sources,NEW.route,NEW.consent_version,NEW.prompt_version,NEW.schema_version,NEW.parameters,NEW.copy_claim,NEW.deadline_at,NEW.queue_expires_at)
    THEN RAISE EXCEPTION 'Immutable AI operation binding'; END IF;
  IF OLD.delivered_at IS NOT NULL AND (OLD.result,OLD.delivered_at) IS DISTINCT FROM (NEW.result,NEW.delivered_at)
    THEN RAISE EXCEPTION 'Immutable AI result'; END IF;
  IF OLD.state<>NEW.state AND NOT (
    (OLD.state='queued' AND NEW.state IN ('running','failed','cancelled')) OR
    (OLD.state='running' AND NEW.state IN ('waiting_review','succeeded','failed','cancel_requested')) OR
    (OLD.state='cancel_requested' AND NEW.state IN ('cancelled','failed')) OR
    (OLD.state='waiting_review' AND NEW.state='succeeded')
  ) THEN RAISE EXCEPTION 'Invalid AI operation transition'; END IF;
  IF OLD.state='queued' AND NEW.state='running' THEN
    -- Freeze the execution allowance at creation, but exclude queue wait exactly once.
    NEW.execution_started_at := COALESCE(NEW.execution_started_at, date_trunc('milliseconds', clock_timestamp()));
    IF NEW.execution_started_at >= OLD.queue_expires_at
      THEN RAISE EXCEPTION 'AI queue expired'; END IF;
    NEW.deadline_at := NEW.execution_started_at + (OLD.deadline_at-OLD.created_at);
  ELSIF OLD.execution_started_at IS DISTINCT FROM NEW.execution_started_at THEN
    RAISE EXCEPTION 'Immutable AI execution start';
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
DO $migration$ DECLARE namespace text := current_schema(); role_name text; BEGIN
  EXECUTE format($ddl$
CREATE OR REPLACE FUNCTION %1$I.master_cv_ai_admit_operation(operation_id text, request_limit bigint, day_limit bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  o %1$I.ai_operation;
  b %1$I.ai_platform_budget;
  root_id text;
  hold_micros bigint;
  live_parts integer;
  today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('master_cv_ai_budget',0));
  SELECT * INTO o FROM %1$I.ai_operation WHERE id=operation_id AND user_id=NULLIF(current_setting('app.user_id',true),'') FOR UPDATE;
  IF NOT FOUND THEN RETURN 'AI_BUDGET_LIMIT'; END IF;
  IF o.budget_id IS NOT NULL THEN RETURN CASE WHEN o.budget_closed THEN 'AI_BUDGET_LIMIT' ELSE 'admitted' END; END IF;
  SELECT * INTO b FROM %1$I.ai_platform_budget
    WHERE route_id=o.route->>'routeId' AND route_revision=o.route->>'routeRevision'
      AND window_date=today FOR UPDATE;
  IF NOT FOUND OR request_limit IS NULL OR request_limit NOT BETWEEN 1 AND 200000
    OR day_limit IS NULL OR day_limit<=0 OR b.request_cap_micros<>request_limit THEN RETURN 'AI_BUDGET_LIMIT'; END IF;
  root_id := CASE WHEN o.kind='review.translation' THEN o.parameters->'translationBatch'->>'rootId' END;
  hold_micros := request_limit;
  IF root_id IS NOT NULL AND root_id<>o.id THEN
    IF NOT EXISTS (
      SELECT 1 FROM %1$I.ai_operation root
      WHERE root.id=root_id AND root.user_id=o.user_id AND root.kind=o.kind AND root.budget_id IS NOT NULL
      AND root.parameters->'translationBatch'->>'rootId'=root.id
    ) THEN RETURN 'AI_BUDGET_LIMIT'; END IF;
    -- Queued parts hold a place in the work queue. They draw from the same request cap at dispatch.
    hold_micros := 0;
  END IF;
  IF b.spent_micros+b.reserved_micros+hold_micros>least(b.cap_micros,day_limit,15000000)
    OR (SELECT coalesce(sum(spent_micros+reserved_micros),0) FROM %1$I.ai_platform_budget WHERE window_date=today)
      +hold_micros>15000000
  THEN RETURN 'AI_BUDGET_LIMIT'; END IF;
  -- Translation keeps its existing per-batch staging bound. Platform slots are acquired at claim.
  IF root_id IS NOT NULL THEN
    SELECT count(*) INTO live_parts FROM %1$I.ai_operation live
      WHERE live.user_id=o.user_id AND live.kind='review.translation'
        AND live.parameters->'translationBatch'->>'rootId'=root_id
        AND live.budget_id IS NOT NULL AND NOT live.budget_closed AND live.state IN ('queued','running','cancel_requested');
    IF live_parts>=least(b.concurrency,6) THEN RETURN 'AI_PLATFORM_BUSY'; END IF;
  END IF;
  -- The active counter tracks physical reservations for reconciliation, not admission.
  UPDATE %1$I.ai_platform_budget SET active=active+1,reserved_micros=reserved_micros+hold_micros WHERE id=b.id;
  UPDATE %1$I.ai_operation SET budget_id=b.id,reserved_micros=hold_micros WHERE id=o.id;
  RETURN 'admitted';
END $fn$;
$ddl$, namespace);
  EXECUTE format($ddl$
CREATE FUNCTION %1$I.master_cv_ai_waiting_groups(observed_at timestamptz)
RETURNS TABLE (id text,created_at timestamptz,user_id text,group_id text)
LANGUAGE sql SET search_path = pg_catalog AS $fn$
  -- The first part eligible for a new slot represents the entire request.
  SELECT DISTINCT ON (waiting.user_id,waiting.group_id) waiting.* FROM (
    SELECT queued.id,queued.created_at,queued.user_id,coalesce(
      CASE WHEN queued.kind='review.translation' THEN queued.parameters->'translationBatch'->>'rootId' END, queued.id
    ) FROM %1$I.ai_operation queued
    JOIN %1$I."user" account ON account.id=queued.user_id AND account.data_deletion_requested_at IS NULL
    WHERE queued.state='queued' AND queued.due_at<=observed_at AND queued.queue_expires_at>observed_at
      AND (queued.kind<>'review.translation' OR NOT EXISTS (
        SELECT 1 FROM %1$I.ai_operation root
          WHERE root.id=queued.parameters->'translationBatch'->>'rootId'
            AND root.id<>queued.id AND root.state='queued'
      ))
      AND (queued.kind<>'review.translation' OR NOT EXISTS (
        SELECT 1 FROM %1$I.ai_operation part WHERE part.user_id=queued.user_id
          AND part.kind='review.translation'
          AND part.parameters->'translationBatch'->>'rootId'=queued.parameters->'translationBatch'->>'rootId'
          AND part.state IN ('running','cancel_requested')
      ))
  ) AS waiting(id,created_at,user_id,group_id)
  ORDER BY waiting.user_id,waiting.group_id,waiting.created_at,waiting.id
$fn$;
$ddl$, namespace);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.master_cv_ai_waiting_groups(timestamptz) FROM PUBLIC',namespace);
  EXECUTE format($ddl$
CREATE FUNCTION %1$I.master_cv_ai_queue_position(operation_id text) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  WITH waiting AS (
    SELECT user_id,group_id,row_number() OVER (ORDER BY created_at,id)::integer AS position
    FROM %1$I.master_cv_ai_waiting_groups(clock_timestamp())
  )
  SELECT waiting.position FROM waiting JOIN %1$I.ai_operation operation
    ON operation.user_id=waiting.user_id AND operation.id=waiting.group_id
    WHERE operation.id=operation_id AND operation.user_id=NULLIF(current_setting('app.user_id',true),'')
$fn$;
$ddl$, namespace);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.master_cv_ai_queue_position(text) FROM PUBLIC',namespace);
  EXECUTE format($ddl$
CREATE FUNCTION %1$I.master_cv_ai_claim_slot(operation_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  candidate %1$I.ai_operation;
  group_id text;
  observed_at timestamptz;
  running_count integer;
  capacity integer;
  next_id text;
BEGIN
  -- Hold this lock through the queued-to-running update. Every worker sees prior committed claims.
  PERFORM pg_advisory_xact_lock(hashtextextended(%1$L || '.master_cv_ai_claim_slot',0));
  observed_at := clock_timestamp();
  SELECT * INTO candidate FROM %1$I.ai_operation
    WHERE id=operation_id AND user_id=NULLIF(current_setting('app.user_id',true),'')
      AND state='queued' AND due_at<=observed_at AND queue_expires_at>observed_at;
  IF NOT FOUND THEN RETURN false; END IF;
  group_id := CASE WHEN candidate.kind='review.translation'
    THEN candidate.parameters->'translationBatch'->>'rootId' END;
  IF group_id IS NOT NULL AND group_id<>candidate.id THEN
    IF EXISTS (SELECT 1 FROM %1$I.ai_operation root WHERE root.id=group_id AND root.state='queued')
    THEN RETURN false; END IF;
    -- An executing translation already holds one slot for all of its parts.
    IF EXISTS (
      SELECT 1 FROM %1$I.ai_operation part WHERE part.user_id=candidate.user_id
        AND part.kind='review.translation' AND part.parameters->'translationBatch'->>'rootId'=group_id
        AND part.state IN ('running','cancel_requested')
    ) THEN RETURN true; END IF;
  END IF;

  SELECT max_running INTO capacity FROM %1$I.ai_platform_capacity WHERE singleton;
  SELECT count(DISTINCT (live.user_id, coalesce(
    CASE WHEN live.kind='review.translation' THEN live.parameters->'translationBatch'->>'rootId' END, live.id
  ))) INTO running_count
  FROM %1$I.ai_operation live WHERE live.state IN ('running','cancel_requested');
  IF capacity IS NULL OR running_count>=capacity THEN RETURN false; END IF;

  SELECT waiting.id INTO next_id FROM %1$I.master_cv_ai_waiting_groups(observed_at) waiting
    ORDER BY waiting.created_at,waiting.id LIMIT 1;
  RETURN coalesce(next_id=candidate.id,false);
END $fn$;
$ddl$, namespace);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.master_cv_ai_claim_slot(text) FROM PUBLIC',namespace);
  FOR role_name IN
    SELECT rolname FROM pg_roles
    WHERE NOT rolsuper AND rolname<>current_user
      AND has_function_privilege(oid,format('%I.master_cv_ai_admit_operation(text,bigint,bigint)',namespace),'EXECUTE')
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I.ai_platform_capacity FROM %I',namespace,role_name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.master_cv_ai_claim_slot(text) TO %I',namespace,role_name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.master_cv_ai_queue_position(text) TO %I',namespace,role_name);
  END LOOP;
END $migration$;
--> statement-breakpoint
CREATE INDEX ai_operation_waiting_order ON ai_operation(created_at,id) WHERE state='queued';
--> statement-breakpoint
DO $migration$ DECLARE namespace text := current_schema(); BEGIN
  EXECUTE format($ddl$
CREATE OR REPLACE FUNCTION %1$I.master_cv_ai_queue_owners() RETURNS TABLE(user_id text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT owners.user_id FROM (
    SELECT o.user_id FROM %1$I.ai_operation o WHERE o.state IN ('queued','running','cancel_requested') OR (o.budget_closed AND o.reserved_micros>0 AND o.deadline_at + interval '5 minutes' <= now())
    UNION
    SELECT s.user_id FROM %1$I.ai_import_review_source s WHERE s.expires_at <= now()
    UNION
    SELECT b.user_id FROM %1$I.ai_translation_batch b WHERE b.state <> 'complete'
      AND b.failure_code IS DISTINCT FROM 'AI_CANCELLED'
      AND NOT EXISTS (SELECT 1 FROM %1$I.ai_operation root
        WHERE root.id=b.root_operation_id AND root.execution_started_at IS NULL
          AND root.state='failed' AND root.failure_code='AI_QUEUE_EXPIRED')
      AND (
        b.total > (SELECT count(DISTINCT o.parameters->'translationBatch'->>'index') FROM %1$I.ai_operation o
          WHERE o.user_id=b.user_id AND o.parameters->'translationBatch'->>'rootId'=b.root_operation_id)
        OR jsonb_array_length(COALESCE(b.execution->'retryFailedOperationIds', '[]'::jsonb)) > 0
      )
    ) owners LEFT JOIN LATERAL (
    SELECT min(o.created_at) AS first_waiting FROM %1$I.ai_operation o
    WHERE o.user_id=owners.user_id AND o.state='queued'
  ) waiting ON true
  ORDER BY waiting.first_waiting NULLS LAST,owners.user_id LIMIT 100
$fn$;
$ddl$, namespace);
END $migration$;
