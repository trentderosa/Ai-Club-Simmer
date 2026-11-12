-- =============================================================================
-- Lock down EXECUTE on public.rls_auto_enable
-- =============================================================================
-- Advisor warning: public.rls_auto_enable is callable by anon and/or
-- authenticated via PostgREST /rest/v1/rpc.
--
-- Scope: GRANT/REVOKE only. Do NOT drop or alter the function body —
-- that function is owned by Nathan and Ezzeldin (Supabase ensure_rls helper).
-- No EXECUTE is granted or revoked for service_role. In prod, Supabase
-- default privileges already grant EXECUTE directly to service_role; that
-- server-only grant is left in place.
--
-- Guarded: the function exists in simmer.prod but is not created by any
-- migration in this repo, so fresh local / preview DBs may not have it.
-- Event triggers still fire as owner regardless of EXECUTE grants; clients
-- must not call it via RPC.
-- =============================================================================

DO $$
BEGIN
  IF to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
    REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon;
    REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM authenticated;
  END IF;
END
$$;
