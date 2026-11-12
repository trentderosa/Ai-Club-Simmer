-- =============================================================================
-- Lock down EXECUTE on public.award_slot_xp
-- =============================================================================
-- Advisor warning: public.award_slot_xp is callable by anon and/or authenticated
-- via PostgREST /rest/v1/rpc.
--
-- Scope: GRANT/REVOKE only. No function body changes.
--
-- award_slot_xp(uuid): service_role only (ai-server / server-side XP path).
-- The client never calls award_slot_xp. XP is only awarded server-side
-- through service_role.
-- =============================================================================

-- Exact signature from 20261103000000_core_schema.sql (overloads dropped there).
REVOKE EXECUTE ON FUNCTION public.award_slot_xp(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.award_slot_xp(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.award_slot_xp(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.award_slot_xp(UUID) TO service_role;
