-- =====================================================================
-- Servicio Médico · Migración 7
-- Guardado de claves VAPID (lo hace la Edge Function la primera vez; las
-- claves se generan dentro de Supabase y nunca viajan por el navegador).
-- =====================================================================
create or replace function public.med_vapid_guardar(p_publica text, p_privada text)
returns void language sql security definer set search_path = '' as $$
  insert into med_private.config_push (id, vapid_publica, vapid_privada)
  values (1, p_publica, p_privada)
  on conflict (id) do nothing
$$;
revoke all on function public.med_vapid_guardar(text, text) from public, anon, authenticated;
grant execute on function public.med_vapid_guardar(text, text) to service_role;
