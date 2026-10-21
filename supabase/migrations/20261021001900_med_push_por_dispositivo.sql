-- =====================================================================
-- Servicio Médico · Migración 19 (v1.15): notificaciones por dispositivo.
-- Las notificaciones se activan una vez por dispositivo. Al cerrar sesión ya
-- no se desactivan, y al iniciar sesión con otra cuenta el dispositivo se
-- vincula a esa cuenta (un dispositivo = una suscripción = la última cuenta).
-- Como la suscripción puede pertenecer a la cuenta anterior (y RLS no deja
-- tocar filas de otros usuarios), el cambio se hace con esta RPC.
-- =====================================================================
create or replace function public.med_vincular_push(p_endpoint text, p_p256dh text, p_auth text, p_dispositivo text default null)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare v_uid uuid := public.med_usuario_actual_id();
begin
  if v_uid is null then
    raise exception 'Usuario no autorizado.' using errcode = '42501';
  end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 1000
     or coalesce(p_p256dh, '') = '' or char_length(p_p256dh) > 200
     or coalesce(p_auth, '') = '' or char_length(p_auth) > 100 then
    raise exception 'Suscripción no válida.' using errcode = 'P0001';
  end if;
  insert into public.push_subs_med (usuario_id, endpoint, p256dh, auth, dispositivo)
  values (v_uid, p_endpoint, p_p256dh, p_auth, left(p_dispositivo, 200))
  on conflict (endpoint) do update
     set usuario_id = excluded.usuario_id, p256dh = excluded.p256dh, auth = excluded.auth,
         dispositivo = excluded.dispositivo;
end $$;
revoke all on function public.med_vincular_push(text, text, text, text) from public, anon;
grant execute on function public.med_vincular_push(text, text, text, text) to authenticated;
