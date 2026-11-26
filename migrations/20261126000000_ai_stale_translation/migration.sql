-- Keep terminal translation reviews out of durable worker discovery.
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
      AND b.failure_code IS DISTINCT FROM 'AI_SOURCE_CHANGED'
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
