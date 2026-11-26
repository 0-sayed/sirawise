-- Runtime roles can update batches, but only account erasure can remove them.
DO $$
DECLARE runtime_role text;
BEGIN
  FOR runtime_role IN
    SELECT roles.rolname
    FROM information_schema.role_table_grants
    JOIN pg_roles AS roles ON roles.rolname = grantee
    WHERE table_schema = 'public'
      AND table_name = 'ai_operation'
      AND privilege_type = 'INSERT'
      AND grantee <> current_user
      AND NOT has_table_privilege(roles.oid, 'public.ai_operation', 'DELETE')
  LOOP
    EXECUTE format('REVOKE DELETE ON public.ai_translation_batch FROM %I', runtime_role);
  END LOOP;
END $$;
