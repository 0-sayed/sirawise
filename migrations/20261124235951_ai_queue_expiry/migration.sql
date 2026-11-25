ALTER TABLE "ai_operation" ADD COLUMN "queue_expires_at" timestamp with time zone DEFAULT now() + interval '30 minutes' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_operation" ADD COLUMN "execution_started_at" timestamp with time zone;--> statement-breakpoint
UPDATE ai_operation SET queue_expires_at = created_at + interval '30 minutes';
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
    NEW.queue_expires_at := NEW.created_at + interval '30 minutes';
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
