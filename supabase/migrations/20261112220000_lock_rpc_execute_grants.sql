-- =============================================================================
-- Lock down EXECUTE on RPCs flagged by Supabase advisor
-- =============================================================================
-- Advisor warnings: public.award_slot_xp and public.rls_auto_enable are callable
-- by anon and/or authenticated via PostgREST /rest/v1/rpc.
--
-- Scope: GRANT/REVOKE only. No function body changes.
--
-- award_slot_xp(uuid): service_role only (ai-server / server-side XP path).
-- rls_auto_enable(): revoke client EXECUTE. Do NOT drop or alter the body —
-- that function is owned by Nathan and Ezzeldin (Supabase ensure_rls helper).
-- =============================================================================

-- Exact signature from 20261103000000_core_schema.sql (overloads dropped there).
REVOKE EXECUTE ON FUNCTION public.award_slot_xp(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.award_slot_xp(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.award_slot_xp(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.award_slot_xp(UUID) TO service_role;

-- Platform helper: public.rls_auto_enable() (no args). Event triggers still fire
-- as owner regardless of EXECUTE grants; clients must not call it via RPC.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM authenticated;
