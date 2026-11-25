DO $migration$ DECLARE namespace text := current_schema(); BEGIN
  EXECUTE format($ddl$
CREATE OR REPLACE FUNCTION %1$I.master_cv_ai_admit_budget(operation_id text, request_limit bigint, day_limit bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  o %1$I.ai_operation;
  b %1$I.ai_platform_budget;
  root_id text;
  hold_micros bigint;
  today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('master_cv_ai_budget',0));
  SELECT * INTO o FROM %1$I.ai_operation WHERE id=operation_id AND user_id=NULLIF(current_setting('app.user_id',true),'') FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF o.budget_id IS NOT NULL THEN RETURN NOT o.budget_closed; END IF;
  SELECT * INTO b FROM %1$I.ai_platform_budget
    WHERE route_id=o.route->>'routeId' AND route_revision=o.route->>'routeRevision'
      AND window_date=today FOR UPDATE;
  IF NOT FOUND OR request_limit IS NULL OR request_limit NOT BETWEEN 1 AND 200000
    OR day_limit IS NULL OR day_limit<=0 OR b.request_cap_micros<>request_limit THEN RETURN false; END IF;
  root_id := CASE WHEN o.kind='review.translation' THEN o.parameters->'translationBatch'->>'rootId' END;
  hold_micros := request_limit;
  IF root_id IS NOT NULL AND root_id<>o.id THEN
    IF NOT EXISTS (
      SELECT 1 FROM %1$I.ai_operation root
      WHERE root.id=root_id AND root.user_id=o.user_id AND root.kind=o.kind AND root.budget_id IS NOT NULL
      AND root.parameters->'translationBatch'->>'rootId'=root.id
    ) THEN RETURN false; END IF;
    -- Queued parts hold a place in the work queue. They draw from the same request cap at dispatch.
    hold_micros := 0;
  END IF;
  IF b.spent_micros+b.reserved_micros+hold_micros>least(b.cap_micros,day_limit,15000000)
    OR (SELECT coalesce(sum(spent_micros+reserved_micros),0) FROM %1$I.ai_platform_budget WHERE window_date=today)
      +hold_micros>15000000
    OR (SELECT count(*) FROM %1$I.ai_operation live JOIN %1$I.ai_platform_budget policy ON policy.id=live.budget_id
        WHERE NOT live.budget_closed AND live.state IN ('queued','running','cancel_requested') AND policy.window_date=today)>=b.concurrency
  THEN RETURN false; END IF;
  UPDATE %1$I.ai_platform_budget SET active=active+1,reserved_micros=reserved_micros+hold_micros WHERE id=b.id;
  UPDATE %1$I.ai_operation SET budget_id=b.id,reserved_micros=hold_micros WHERE id=o.id;
  RETURN true;
END $fn$;
$ddl$, namespace);
  EXECUTE format($ddl$
CREATE FUNCTION %1$I.master_cv_ai_hold_translation(operation_id text, liability bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  o %1$I.ai_operation;
  root %1$I.ai_operation;
  b %1$I.ai_platform_budget;
  group_cap bigint;
  group_liability bigint;
  pending_elsewhere boolean;
  delta bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('master_cv_ai_budget',0));
  SELECT * INTO o FROM %1$I.ai_operation
    WHERE id=operation_id AND user_id=NULLIF(current_setting('app.user_id',true),'') FOR UPDATE;
  IF NOT FOUND OR o.kind<>'review.translation' OR o.budget_closed OR o.state<>'running'
    OR liability IS NULL OR liability<0 THEN RETURN 'denied'; END IF;
  SELECT * INTO root FROM %1$I.ai_operation
    WHERE id=o.parameters->'translationBatch'->>'rootId' AND user_id=o.user_id AND kind=o.kind FOR UPDATE;
  IF NOT FOUND THEN RETURN 'denied'; END IF;
  SELECT * INTO b FROM %1$I.ai_platform_budget WHERE id=o.budget_id FOR UPDATE;
  IF NOT FOUND OR b.window_date<>(clock_timestamp() AT TIME ZONE 'UTC')::date THEN RETURN 'denied'; END IF;
  SELECT least(request_cap_micros,b.request_cap_micros,200000) INTO group_cap
    FROM %1$I.ai_platform_budget WHERE id=root.budget_id;
  IF group_cap IS NULL OR liability>group_cap THEN RETURN 'denied'; END IF;

  -- Convert the initial admission hold to a physical call hold in this transaction.
  IF root.id<>o.id AND root.reserved_micros=group_cap AND NOT root.budget_closed
    AND NOT EXISTS (SELECT 1 FROM %1$I.ai_operation_attempt WHERE ai_operation_attempt.operation_id=root.id) THEN
    UPDATE %1$I.ai_platform_budget SET reserved_micros=reserved_micros-root.reserved_micros WHERE id=root.budget_id;
    UPDATE %1$I.ai_operation SET reserved_micros=0 WHERE id=root.id;
    IF root.budget_id=b.id THEN b.reserved_micros := b.reserved_micros-root.reserved_micros; END IF;
  END IF;
  SELECT coalesce(sum(reserved_micros+coalesce(actual_micros,unknown_booked_micros,0)),0),
    coalesce(bool_or(state='running' AND reserved_micros>0 AND EXISTS (
      SELECT 1 FROM %1$I.ai_operation_attempt a WHERE a.operation_id=part.id AND a.finished_at IS NULL
      AND (a.step_id<>'verify' OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.output->'_verifyCalls')='array'
          THEN a.output->'_verifyCalls' ELSE '[]'::jsonb END) AS call
        WHERE call->>'outcome'='pending'
      ))
    )),false)
    INTO group_liability,pending_elsewhere FROM %1$I.ai_operation part
    WHERE part.user_id=o.user_id AND part.kind=o.kind AND part.id<>o.id
      AND part.parameters->'translationBatch'->>'rootId'=root.id;
  delta := liability-o.reserved_micros;
  IF group_liability+liability>group_cap OR (delta>0 AND (
    b.spent_micros+b.reserved_micros+delta>least(b.cap_micros,15000000)
    OR (SELECT coalesce(sum(spent_micros+reserved_micros),0) FROM %1$I.ai_platform_budget WHERE window_date=b.window_date)
      +delta>15000000
  )) THEN RETURN CASE WHEN pending_elsewhere THEN 'wait' ELSE 'denied' END; END IF;
  IF delta<>0 THEN
    UPDATE %1$I.ai_platform_budget SET reserved_micros=reserved_micros+delta WHERE id=b.id;
    UPDATE %1$I.ai_operation SET reserved_micros=liability WHERE id=o.id;
  END IF;
  RETURN 'held';
END $fn$;
$ddl$, namespace);
  EXECUTE format($ddl$
CREATE FUNCTION %1$I.master_cv_ai_can_dispatch(operation_id text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM %1$I.ai_operation o JOIN %1$I.ai_platform_budget b ON b.id=o.budget_id
    WHERE o.id=operation_id AND o.user_id=NULLIF(current_setting('app.user_id',true),'')
      AND o.state='running' AND NOT o.budget_closed AND o.reserved_micros>0
      AND b.window_date=(clock_timestamp() AT TIME ZONE 'UTC')::date
  );
$fn$;
$ddl$, namespace);
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
      -- Late evidence can release a hold. Raw reports stay on the immutable attempt.
      measured := least(measured, COALESCE(o.unknown_booked_micros,b.request_cap_micros));
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
    booked := least(booked,o.reserved_micros+coalesce(o.unknown_booked_micros,0));
    UPDATE %1$I.ai_platform_budget SET active=active-CASE WHEN o.budget_closed THEN 0 ELSE 1 END,
      spent_micros=spent_micros+booked-COALESCE(o.unknown_booked_micros,0),reserved_micros=reserved_micros-o.reserved_micros WHERE id=b.id;
    UPDATE %1$I.ai_operation SET actual_micros=NULL,unknown_booked_micros=booked,budget_closed=true,reserved_micros=0 WHERE id=o.id;
    RETURN;
  END IF;
  IF o.budget_closed AND measured IS NULL THEN RETURN; END IF;
  IF measured IS NOT NULL THEN measured := least(measured,o.reserved_micros); END IF;
  UPDATE %1$I.ai_platform_budget SET active=active-CASE WHEN o.budget_closed THEN 0 ELSE 1 END,
    reserved_micros=reserved_micros-CASE WHEN measured IS NULL THEN 0 ELSE o.reserved_micros END,
    spent_micros=spent_micros+COALESCE(measured,0) WHERE id=b.id;
  UPDATE %1$I.ai_operation SET actual_micros=measured,budget_closed=true,
    reserved_micros=CASE WHEN measured IS NULL THEN o.reserved_micros ELSE 0 END WHERE id=o.id;
END $fn$;
$ddl$, namespace);
  EXECUTE format($ddl$
CREATE OR REPLACE FUNCTION %1$I.master_cv_ai_delete_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE o %1$I.ai_operation; measured bigint; previous_owner text := current_setting('app.user_id',true);
BEGIN
  IF TG_TABLE_SCHEMA <> %2$L OR TG_TABLE_NAME <> 'user' OR TG_OP <> 'DELETE' THEN RAISE EXCEPTION 'Invalid AI cleanup trigger'; END IF;
  PERFORM set_config('app.user_id',OLD.id,true);
  -- User deletion already holds the owner row lock; keep owner -> budget -> operation order.
  PERFORM pg_advisory_xact_lock(hashtextextended('master_cv_ai_budget',0));
  FOR o IN SELECT * FROM %1$I.ai_operation WHERE user_id=OLD.id AND budget_id IS NOT NULL FOR UPDATE LOOP
    IF o.budget_closed AND o.reserved_micros=0 THEN CONTINUE; END IF;
    SELECT CASE WHEN bool_and(finished_at IS NOT NULL AND cost_micros IS NOT NULL)
      THEN sum(cost_micros) WHEN count(*)=0 THEN 0 ELSE NULL END INTO measured
      FROM %1$I.ai_operation_attempt a WHERE a.operation_id=o.id;
    -- Deletion erases attempts: conservatively book unknown liability instead of orphaning reservations.
    UPDATE %1$I.ai_platform_budget SET active=active-CASE WHEN o.budget_closed THEN 0 ELSE 1 END,
      reserved_micros=reserved_micros-o.reserved_micros,
      spent_micros=spent_micros+least(COALESCE(measured,o.reserved_micros),o.reserved_micros) WHERE id=o.budget_id;
  END LOOP;
  PERFORM set_config('app.user_id',COALESCE(previous_owner,''),true);
  RETURN OLD;
END $fn$;
$ddl$, namespace, namespace);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.master_cv_ai_hold_translation(text,bigint) FROM PUBLIC',namespace);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.master_cv_ai_can_dispatch(text) FROM PUBLIC',namespace);

  -- Runtime roles already authorized to admit work also need the dispatch hold.
  DECLARE r record; BEGIN
    FOR r IN SELECT rolname FROM pg_roles WHERE NOT rolsuper AND NOT rolbypassrls
      AND has_function_privilege(oid,format('%I.master_cv_ai_admit_budget(text,bigint,bigint)',namespace),'EXECUTE')
    LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.master_cv_ai_hold_translation(text,bigint) TO %I',namespace,r.rolname);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.master_cv_ai_can_dispatch(text) TO %I',namespace,r.rolname);
    END LOOP;
  END;
END $migration$;
