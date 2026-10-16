-- =====================================================================
-- Servicio Médico · Migración 3
-- Permite a los administradores saber si cada usuario autorizado ya tiene
-- cuenta en Supabase Auth (solo lectura; no expone otros correos de Auth).
-- =====================================================================
create or replace function public.med_estado_cuentas()
returns table (email text, tiene_cuenta boolean, confirmada boolean, ultimo_acceso timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.med_es_admin() then
    raise exception 'Solo administradores.' using errcode = '42501';
  end if;
  return query
  select u.email, (au.id is not null), (au.email_confirmed_at is not null), au.last_sign_in_at
  from public.usuarios_med u
  left join auth.users au on lower(au.email) = lower(u.email);
end $$;

revoke all on function public.med_estado_cuentas() from public, anon;
grant execute on function public.med_estado_cuentas() to authenticated;
