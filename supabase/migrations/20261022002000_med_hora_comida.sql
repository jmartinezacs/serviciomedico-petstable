-- =====================================================================
-- Servicio Médico · Migración 20 (v1.17)
-- 1) Hora de comida del médico (por defecto 15:00 a 16:00), editable en
--    Usuarios → Configuración. Esos horarios no admiten citas normales de los
--    demás (med_motivo_bloqueo); el médico puede agendar a cualquier hora.
-- 2) Aviso push a todos los usuarios al iniciar la hora de comida
--    (recordatorios_med; avisos_comida_med evita repetirlo el mismo día).
-- 3) Último bloque de la agenda a las 17:40 (antes 17:00).
-- =====================================================================
alter table public.config_med
  add column comida_inicio time not null default '15:00',
  add column comida_fin    time not null default '16:00',
  add constraint config_med_comida_ck check (
    comida_inicio < comida_fin and comida_inicio >= time '07:00' and comida_fin <= time '20:00'
    and extract(second from comida_inicio) = 0 and extract(second from comida_fin) = 0);

-- Registro de avisos de comida enviados (uno por día). Solo lo usa la Edge Function (service_role).
create table public.avisos_comida_med (
  fecha      date primary key,
  enviados   integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.avisos_comida_med enable row level security;
revoke all on public.avisos_comida_med from anon, authenticated;

create or replace function public.med_motivo_bloqueo(p_fecha date, p_hora time without time zone)
 returns text
 language sql
 stable security definer
 set search_path to ''
as $function$
  select coalesce(
    (select b.motivo from public.dias_sin_servicio_med b
      where b.fecha = p_fecha
        and (b.hora_inicio is null or (p_hora is not null and p_hora >= b.hora_inicio and p_hora < b.hora_fin))
      order by b.hora_inicio nulls first limit 1),
    (select 'Hora de comida' from public.config_med c
      where c.id = 1 and p_hora is not null and p_hora >= c.comida_inicio and p_hora < c.comida_fin)
  )
$function$;

create or replace function public.med_es_bloque(p_hora time)
 returns boolean
 language sql
 immutable
 set search_path to ''
as $$
  select p_hora between time '09:00' and time '17:40'
     and extract(minute from p_hora) in (0, 20, 40)
     and extract(second from p_hora) = 0
$$;
