CREATE TABLE "ai_translation_batch" (
	"root_operation_id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"total" integer NOT NULL,
	"state" text NOT NULL,
	"failure_code" text,
	"result" jsonb,
	"review_state" text DEFAULT 'waiting_review' NOT NULL,
	CONSTRAINT "ai_translation_batch_total_valid" CHECK ("total" > 0),
	CONSTRAINT "ai_translation_batch_state_valid" CHECK ("state" IN ('running','paused','complete')),
	CONSTRAINT "ai_translation_batch_result_valid" CHECK (("state" = 'complete') = ("result" IS NOT NULL)),
	CONSTRAINT "ai_translation_batch_review_valid" CHECK ("review_state" IN ('waiting_review','succeeded'))
);
--> statement-breakpoint
ALTER TABLE "ai_translation_batch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "ai_translation_batch_user_id_index" ON "ai_translation_batch" ("user_id");--> statement-breakpoint
ALTER TABLE "ai_translation_batch" ADD CONSTRAINT "ai_translation_batch_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_translation_batch" ADD CONSTRAINT "ai_translation_batch_flSDqth8jvKD_fkey" FOREIGN KEY ("user_id","root_operation_id") REFERENCES "ai_operation"("user_id","id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "owner_access" ON "ai_translation_batch" AS PERMISSIVE FOR ALL TO public USING ("ai_translation_batch"."user_id" = NULLIF(current_setting('app.user_id', true), '')) WITH CHECK ("ai_translation_batch"."user_id" = NULLIF(current_setting('app.user_id', true), ''));
--> statement-breakpoint
ALTER TABLE "ai_translation_batch" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION master_cv_ai_translation_batch_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (OLD.root_operation_id,OLD.user_id,OLD.total) IS DISTINCT FROM (NEW.root_operation_id,NEW.user_id,NEW.total)
    THEN RAISE EXCEPTION 'Immutable translation batch binding'; END IF;
  IF OLD.state='complete' AND (OLD.state,OLD.failure_code,OLD.result) IS DISTINCT FROM (NEW.state,NEW.failure_code,NEW.result)
    THEN RAISE EXCEPTION 'Immutable completed translation batch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_translation_batch_guard BEFORE UPDATE ON ai_translation_batch FOR EACH ROW EXECUTE FUNCTION master_cv_ai_translation_batch_guard();
--> statement-breakpoint
-- Keep existing runtime credentials and add only the new owner-scoped aggregate privileges.
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE NOT rolsuper AND NOT rolbypassrls
    AND has_table_privilege(oid,format('%I.career_fact_revision',current_schema()),'INSERT')
    AND NOT has_table_privilege(oid,format('%I.career_fact_revision',current_schema()),'UPDATE')
    AND NOT pg_has_role(oid,(SELECT relowner FROM pg_class WHERE oid=to_regclass(format('%I.career_fact_revision',current_schema()))),'MEMBER')
  LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON ai_translation_batch TO %I',r.rolname);
    EXECUTE format('REVOKE TRUNCATE ON ai_translation_batch FROM %I',r.rolname);
  END LOOP;
END $$;
