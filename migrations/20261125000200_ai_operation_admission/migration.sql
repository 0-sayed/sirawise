DO $migration$ DECLARE namespace text := current_schema(); role_name text; BEGIN
  EXECUTE format($ddl$
CREATE FUNCTION %1$I.master_cv_ai_admit_operation(operation_id text, request_limit bigint, day_limit bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  o %1$I.ai_operation;
  b %1$I.ai_platform_budget;
  root_id text;
  hold_micros bigint;
  live_operations integer;
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
  -- Count each user-visible operation once across routes. Keep a separate per-translation
  -- queue bound so low platform limits still bound how many parts one worker can start.
  SELECT count(DISTINCT (live.user_id, coalesce(
      CASE WHEN live.kind='review.translation' THEN live.parameters->'translationBatch'->>'rootId' END, live.id
    ))), count(*) FILTER (WHERE live.user_id=o.user_id AND live.kind='review.translation'
      AND live.parameters->'translationBatch'->>'rootId'=root_id)
    INTO live_operations, live_parts
    FROM %1$I.ai_operation live JOIN %1$I.ai_platform_budget policy ON policy.id=live.budget_id
    WHERE NOT live.budget_closed AND live.state IN ('queued','running','cancel_requested') AND policy.window_date=today;
  IF (live_parts=0 AND live_operations>=b.concurrency)
    OR (root_id IS NOT NULL AND live_parts>=least(b.concurrency,6))
  THEN RETURN 'AI_PLATFORM_BUSY'; END IF;
  -- The active counter tracks physical reservations for reconciliation, not admission.
  UPDATE %1$I.ai_platform_budget SET active=active+1,reserved_micros=reserved_micros+hold_micros WHERE id=b.id;
  UPDATE %1$I.ai_operation SET budget_id=b.id,reserved_micros=hold_micros WHERE id=o.id;
  RETURN 'admitted';
END $fn$;
$ddl$, namespace);
  EXECUTE format($ddl$
CREATE OR REPLACE FUNCTION %1$I.master_cv_ai_admit_budget(operation_id text, request_limit bigint, day_limit bigint)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  SELECT %1$I.master_cv_ai_admit_operation(operation_id,request_limit,day_limit)='admitted';
$fn$;
$ddl$, namespace);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.master_cv_ai_admit_operation(text,bigint,bigint) FROM PUBLIC',namespace);
  FOR role_name IN
    SELECT rolname FROM pg_roles
    WHERE NOT rolsuper AND has_function_privilege(oid,format('%I.master_cv_ai_admit_budget(text,bigint,bigint)',namespace),'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.master_cv_ai_admit_operation(text,bigint,bigint) TO %I',namespace,role_name);
  END LOOP;
END $migration$;
