ALTER TABLE "ai_translation_batch" ADD COLUMN "plan" jsonb;--> statement-breakpoint
ALTER TABLE "ai_translation_batch" ADD COLUMN "execution" jsonb;--> statement-breakpoint
CREATE POLICY "discovery_owner_read" ON "ai_translation_batch" AS PERMISSIVE FOR SELECT TO current_user USING (true);
--> statement-breakpoint
-- Restore aggregate rows for operations admitted before aggregate persistence was available.
DO $$ DECLARE o record; prior_owner text := current_setting('app.user_id',true); BEGIN
  FOR o IN SELECT id,user_id,parameters,failure_code FROM ai_operation
    WHERE kind='review.translation' AND parameters->'translationBatch'->>'rootId'=id
      AND parameters->'translationBatch'->>'index'='0'
  LOOP
    PERFORM set_config('app.user_id',o.user_id,true);
    INSERT INTO ai_translation_batch(root_operation_id,user_id,total,state,failure_code)
    VALUES (o.id,o.user_id,(o.parameters->'translationBatch'->>'total')::integer,
      CASE WHEN o.failure_code='AI_CANCELLED' THEN 'paused' ELSE 'running' END,
      CASE WHEN o.failure_code='AI_CANCELLED' THEN 'AI_CANCELLED' ELSE NULL END)
    ON CONFLICT (root_operation_id) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.user_id',coalesce(prior_owner,''),true);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION master_cv_ai_translation_batch_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (OLD.root_operation_id,OLD.user_id,OLD.total) IS DISTINCT FROM (NEW.root_operation_id,NEW.user_id,NEW.total)
    THEN RAISE EXCEPTION 'Immutable translation batch binding'; END IF;
  IF OLD.plan IS NOT NULL AND OLD.plan IS DISTINCT FROM NEW.plan
    THEN RAISE EXCEPTION 'Immutable translation batch plan'; END IF;
  IF OLD.state='complete' AND (OLD.state,OLD.failure_code,OLD.result,OLD.execution) IS DISTINCT FROM (NEW.state,NEW.failure_code,NEW.result,NEW.execution)
    THEN RAISE EXCEPTION 'Immutable completed translation batch'; END IF;
  RETURN NEW;
END $$;
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
      AND b.total > (SELECT count(DISTINCT o.parameters->'translationBatch'->>'index') FROM %1$I.ai_operation o
        WHERE o.user_id=b.user_id AND o.parameters->'translationBatch'->>'rootId'=b.root_operation_id)
  ) owners ORDER BY owners.user_id LIMIT 100
$fn$;
$ddl$, namespace);
END $migration$;
