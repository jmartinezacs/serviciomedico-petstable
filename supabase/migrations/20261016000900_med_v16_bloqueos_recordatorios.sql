-- =====================================================================
-- Servicio Médico · Migración 9 (v1.6)
--  1) Días u horarios sin servicio (festivos, ausencias del médico), con los
--     días de descanso obligatorio de la LFT (art. 74) de 2026 y 2027.
--  2) Una inasistencia puede reabrirse (admin) para registrar la atención.
--  3) Inasistencia automática a las 19:05 (L-V) para citas confirmadas cuyo
--     horario ya pasó y no se atendieron.
--  4) Recordatorios de cita al solicitante (día anterior y 1 h antes): nuevos
--     eventos en avisos_med y cron cada 20 minutos.
--  5) Constancia de atención (sin datos clínicos).
--  6) Reabasto: consumo, cobertura y pedido sugerido.
--  7) Aviso de privacidad (URL configurable, visible en el login).
-- =====================================================================

-- ---------- 1. Días / horarios sin servicio ----------
create table if not exists public.dias_sin_servicio_med (
  id uuid primary key default gen_random_uuid(),
  fecha date not null,
  hora_inicio time,
  hora_fin time,
  tipo text not null default 'ausencia' check (tipo in ('festivo', 'ausencia', 'otro')),
  motivo text not null check (char_length(btrim(motivo)) between 2 and 120),
  created_by uuid references public.usuarios_med (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint dias_sin_servicio_med_horas_ck check (
    (hora_inicio is null and hora_fin is null) or (hora_inicio is not null and hora_fin is not null and hora_fin > hora_inicio))
);
create index if not exists dias_sin_servicio_med_fecha_ix on public.dias_sin_servicio_med (fecha);
create unique index if not exists dias_sin_servicio_med_dia_uk on public.dias_sin_servicio_med (fecha) where hora_inicio is null;

alter table public.dias_sin_servicio_med enable row level security;
drop policy if exists dias_sin_servicio_med_sel on public.dias_sin_servicio_med;
create policy dias_sin_servicio_med_sel on public.dias_sin_servicio_med for select to authenticated using ((select public.med_es_miembro()));
drop policy if exists dias_sin_servicio_med_ins on public.dias_sin_servicio_med;
create policy dias_sin_servicio_med_ins on public.dias_sin_servicio_med for insert to authenticated with check ((select public.med_es_admin()));
drop policy if exists dias_sin_servicio_med_upd on public.dias_sin_servicio_med;
create policy dias_sin_servicio_med_upd on public.dias_sin_servicio_med for update to authenticated using ((select public.med_es_admin())) with check ((select public.med_es_admin()));
drop policy if exists dias_sin_servicio_med_del on public.dias_sin_servicio_med;
create policy dias_sin_servicio_med_del on public.dias_sin_servicio_med for delete to authenticated using ((select public.med_es_admin()));
grant select, insert, update, delete on public.dias_sin_servicio_med to authenticated;
revoke all on public.dias_sin_servicio_med from anon;

create or replace function public.med_sello_bloqueo() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.motivo := btrim(new.motivo);
  if tg_op = 'INSERT' then new.created_by := public.med_usuario_actual_id(); end if;
  return new;
end $$;
revoke all on function public.med_sello_bloqueo() from public, anon, authenticated;
drop trigger if exists dias_sin_servicio_med_sello on public.dias_sin_servicio_med;
create trigger dias_sin_servicio_med_sello before insert or update on public.dias_sin_servicio_med
  for each row execute function public.med_sello_bloqueo();
drop trigger if exists dias_sin_servicio_med_audit on public.dias_sin_servicio_med;
create trigger dias_sin_servicio_med_audit after insert or update or delete on public.dias_sin_servicio_med
  for each row execute function public.med_auditar();

-- Motivo del bloqueo que afecta a un horario (null = hay servicio)
create or replace function public.med_motivo_bloqueo(p_fecha date, p_hora time)
returns text language sql stable security definer set search_path = '' as $$
  select b.motivo from public.dias_sin_servicio_med b
  where b.fecha = p_fecha
    and (b.hora_inicio is null or (p_hora is not null and p_hora >= b.hora_inicio and p_hora < b.hora_fin))
  order by b.hora_inicio nulls first limit 1
$$;
revoke all on function public.med_motivo_bloqueo(date, time) from public, anon;
grant execute on function public.med_motivo_bloqueo(date, time) to authenticated, service_role;

-- Días de descanso obligatorio (LFT art. 74) 2026-2027; los lunes móviles se calculan
do $$
declare
  y int;
begin
  for y in 2026..2027 loop
    -- n-ésimo lunes de un mes: primer día + días hasta lunes + 7*(n-1)
    insert into public.dias_sin_servicio_med (fecha, tipo, motivo)
    select f, 'festivo', m from (values
      (make_date(y, 1, 1), 'Año Nuevo'),
      (make_date(y, 2, 1) + ((8 - extract(isodow from make_date(y, 2, 1))::int) % 7), 'Día de la Constitución'),
      (make_date(y, 3, 1) + ((8 - extract(isodow from make_date(y, 3, 1))::int) % 7) + 14, 'Natalicio de Benito Juárez'),
      (make_date(y, 5, 1), 'Día del Trabajo'),
      (make_date(y, 9, 16), 'Día de la Independencia'),
      (make_date(y, 11, 1) + ((8 - extract(isodow from make_date(y, 11, 1))::int) % 7) + 14, 'Día de la Revolución'),
      (make_date(y, 12, 25), 'Navidad')
    ) v(f, m)
    where extract(isodow from f) between 1 and 5
    on conflict do nothing;
  end loop;
end $$;

-- ---------- 2 y 1. Validación de citas: bloqueos y reapertura de inasistencias ----------
create or replace function public.med_validar_cita()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_uid   uuid := public.med_usuario_actual_id();
  v_admin boolean := public.med_es_admin();
  v_ahora timestamp := public.med_ahora();
  v_hoy   date := public.med_hoy();
  v_bloq  text;
begin
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;
  if v_uid is null then
    raise exception 'Usuario no autorizado para Servicio Médico.' using errcode = '42501';
  end if;

  new.descripcion := nullif(btrim(new.descripcion), '');
  new.motivo_cancelacion := nullif(btrim(new.motivo_cancelacion), '');

  if tg_op = 'INSERT' then
    new.solicitado_por := v_uid;
    new.estado := 'pendiente';
    new.motivo_cancelacion := null;
    new.cancelado_por := null;
    if not exists (select 1 from public.colaboradores_med c where c.id = new.colaborador_id and c.activo) then
      raise exception 'El colaborador no existe o está inactivo.' using errcode = 'P0001';
    end if;
    if new.fecha < v_hoy then
      raise exception 'No se pueden registrar citas en fechas pasadas.' using errcode = 'P0001';
    end if;
    if new.tipo = 'urgente' then
      if new.descripcion is null then
        raise exception 'Describe brevemente el motivo de la urgencia.' using errcode = 'P0001';
      end if;
      if not v_admin then new.hora := null; end if;
      return new;
    end if;
    if not v_admin and (new.fecha + new.hora) <= v_ahora then
      raise exception 'El horario seleccionado ya pasó. Elija un horario futuro.' using errcode = 'P0001';
    end if;
    v_bloq := public.med_motivo_bloqueo(new.fecha, new.hora);
    if v_bloq is not null then
      raise exception 'Sin servicio médico en ese horario: %. Elige otro horario o usa Cita de urgencia.', v_bloq using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- Reabrir una inasistencia (solo Servicio Médico) para registrar la atención
  if old.estado = 'no_asistio' and new.estado = 'confirmada' and v_admin
     and (new.fecha, new.hora, new.motivo, new.descripcion) is not distinct from (old.fecha, old.hora, old.motivo, old.descripcion) then
    return new;
  end if;

  if old.estado in ('atendida', 'cancelada', 'no_asistio') then
    raise exception 'La cita ya está cerrada y no puede modificarse.' using errcode = 'P0001';
  end if;
  if new.solicitado_por is distinct from old.solicitado_por or new.colaborador_id is distinct from old.colaborador_id
     or new.tipo is distinct from old.tipo then
    raise exception 'No se puede cambiar el colaborador, el solicitante ni el tipo de una cita.' using errcode = 'P0001';
  end if;
  if new.estado = 'atendida' and coalesce(current_setting('med.atendiendo', true), '') <> '1' then
    raise exception 'Para marcar como atendida utilice el registro de atención.' using errcode = 'P0001';
  end if;

  if not v_admin then
    if old.solicitado_por <> v_uid then
      raise exception 'Solo puede modificar las citas que usted solicitó.' using errcode = '42501';
    end if;
    if new.estado not in (old.estado, 'cancelada') then
      raise exception 'Solo Servicio Médico puede cambiar el estado de la cita.' using errcode = '42501';
    end if;
    if old.estado = 'confirmada' and (new.fecha, new.hora, new.motivo, new.descripcion) is distinct from (old.fecha, old.hora, old.motivo, old.descripcion) then
      raise exception 'La cita ya fue confirmada; solicite el cambio a Servicio Médico.' using errcode = 'P0001';
    end if;
    if new.tipo = 'urgente' and new.hora is distinct from old.hora then
      raise exception 'El horario de una cita urgente lo asigna Servicio Médico.' using errcode = '42501';
    end if;
  end if;

  if (new.fecha, new.hora) is distinct from (old.fecha, old.hora) then
    if new.estado not in ('pendiente', 'confirmada') then
      raise exception 'Solo se reprograman citas pendientes o confirmadas.' using errcode = 'P0001';
    end if;
    if new.fecha < v_hoy then
      raise exception 'No se puede programar en una fecha pasada.' using errcode = 'P0001';
    end if;
    if new.tipo = 'normal' and not v_admin and (new.fecha + new.hora) <= v_ahora then
      raise exception 'El horario seleccionado ya pasó.' using errcode = 'P0001';
    end if;
    if new.tipo = 'normal' then
      v_bloq := public.med_motivo_bloqueo(new.fecha, new.hora);
      if v_bloq is not null then
        raise exception 'Sin servicio médico en ese horario: %.', v_bloq using errcode = 'P0001';
      end if;
    end if;
  end if;

  if new.estado = 'confirmada' and new.hora is null then
    raise exception 'Asigna un horario para confirmar la cita urgente.' using errcode = 'P0001';
  end if;

  if new.estado = 'cancelada' and old.estado <> 'cancelada' then
    if new.motivo_cancelacion is null then
      raise exception 'Indique el motivo de la cancelación.' using errcode = 'P0001';
    end if;
    new.cancelado_por := v_uid;
  elsif new.estado <> 'cancelada' then
    new.motivo_cancelacion := null;
    new.cancelado_por := null;
  end if;

  if new.estado = 'no_asistio' and old.estado <> 'no_asistio' and new.hora is not null and (new.fecha + new.hora) > v_ahora then
    raise exception 'Solo se puede marcar inasistencia cuando el horario ya pasó.' using errcode = 'P0001';
  end if;
  if new.estado = 'pendiente' and old.estado = 'confirmada' then
    raise exception 'Una cita confirmada no puede regresar a pendiente.' using errcode = 'P0001';
  end if;
  return new;
end $function$;

-- ---------- 3. Inasistencia automática ----------
create or replace function public.med_marcar_inasistencias()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.citas_med set estado = 'no_asistio'
   where estado = 'confirmada' and hora is not null
     and (fecha + hora) < public.med_ahora()
     and fecha >= public.med_hoy() - 30;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.med_marcar_inasistencias() from public, anon, authenticated;
grant execute on function public.med_marcar_inasistencias() to service_role;

-- 19:05 de Ciudad de México (UTC-6, sin horario de verano) = 01:05 UTC del día siguiente; L-V MX = mar-sáb UTC
select cron.unschedule(jobid) from cron.job where jobname = 'med_inasistencias';
select cron.schedule('med_inasistencias', '5 1 * * 2-6', 'select public.med_marcar_inasistencias()');

-- ---------- 4. Recordatorios al solicitante ----------
alter table public.avisos_med drop constraint if exists avisos_med_evento_check;
alter table public.avisos_med add constraint avisos_med_evento_check
  check (evento in ('nueva_cita', 'confirmada', 'cancelada', 'reprogramada', 'recordatorio_dia', 'recordatorio_hora'));

-- El recordatorio corre cada 20 minutos (pendientes e inventario solo en la ejecución de la hora en punto)
select cron.alter_job(jobid, schedule := '*/20 * * * *') from cron.job where jobname = 'med_recordatorio_pendientes';

-- ---------- 5. Constancia de atención (sin datos clínicos) ----------
create or replace function public.med_constancia(p_cita uuid)
returns table (folio_txt text, colaborador text, num_empleado text, area text, puesto text,
               fecha date, hora time, tipo text, atendido_at timestamptz, atendio text)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := public.med_usuario_actual_id();
begin
  if v_uid is null then raise exception 'Usuario no autorizado.' using errcode = '42501'; end if;
  return query
    select 'CM-' || lpad(c.folio::text, 5, '0'), co.nombre, co.num_empleado, a.nombre, co.puesto,
           c.fecha, c.hora, c.tipo, at.atendido_at, u.nombre
      from public.citas_med c
      join public.colaboradores_med co on co.id = c.colaborador_id
      left join public.areas_med a on a.id = co.area_id
      join public.atenciones_med at on at.cita_id = c.id
      left join public.usuarios_med u on u.id = at.atendido_por
     where c.id = p_cita and c.estado = 'atendida'
       and (public.med_es_admin() or c.solicitado_por = v_uid);
end $$;
revoke all on function public.med_constancia(uuid) from public, anon;
grant execute on function public.med_constancia(uuid) to authenticated;

-- ---------- 6. Reabasto ----------
alter table public.config_med add column if not exists dias_cobertura integer not null default 60;
alter table public.config_med drop constraint if exists config_med_dias_cobertura_check;
alter table public.config_med add constraint config_med_dias_cobertura_check check (dias_cobertura between 7 and 365);

-- Consumo = piezas entregadas en consultas (dispensación) en los últimos p_dias días
create or replace function public.med_reabasto(p_dias integer default 90)
returns table (id uuid, clave text, nombre text, unidad text, empaque text, contenido_empaque integer,
               existencia integer, stock_minimo integer, consumo integer, consumo_mensual numeric,
               dias_cobertura integer, sugerido integer, sugerido_empaques integer)
language plpgsql stable security definer set search_path = '' as $$
declare v_obj integer := (select c.dias_cobertura from public.config_med c where c.id = 1);
begin
  if not public.med_es_admin() then raise exception 'Solo administradores.' using errcode = '42501'; end if;
  if p_dias is null or p_dias < 7 or p_dias > 365 then raise exception 'Periodo inválido.' using errcode = 'P0001'; end if;
  return query
  with cons as (
    select mv.medicamento_id, sum(-mv.cantidad)::integer as n
      from public.movimientos_med mv
     where mv.tipo = 'dispensacion' and mv.created_at >= now() - make_interval(days => p_dias)
     group by mv.medicamento_id
  ), base as (
    select s.id, s.clave, s.nombre, s.unidad, s.empaque, s.contenido_empaque,
           s.existencia_vigente as existencia, s.stock_minimo, coalesce(cons.n, 0) as consumo,
           coalesce(cons.n, 0)::numeric / p_dias as diario
      from public.v_stock_med s left join cons on cons.medicamento_id = s.id
     where s.activo
  )
  select b.id, b.clave, b.nombre, b.unidad, b.empaque, b.contenido_empaque, b.existencia, b.stock_minimo, b.consumo,
         round(b.diario * 30, 1),
         case when b.diario > 0 then floor(b.existencia / b.diario)::integer end,
         greatest(0, greatest(b.stock_minimo, ceil(b.diario * v_obj)::integer) - b.existencia),
         ceil(greatest(0, greatest(b.stock_minimo, ceil(b.diario * v_obj)::integer) - b.existencia)::numeric / greatest(b.contenido_empaque, 1))::integer
    from base b
   order by 12 desc, b.nombre;
end $$;
revoke all on function public.med_reabasto(integer) from public, anon;
grant execute on function public.med_reabasto(integer) to authenticated;

-- ---------- 7. Aviso de privacidad ----------
alter table public.config_med add column if not exists aviso_privacidad_url text;
alter table public.config_med drop constraint if exists config_med_aviso_url_check;
alter table public.config_med add constraint config_med_aviso_url_check
  check (aviso_privacidad_url is null or (aviso_privacidad_url ~ '^https://[^\s<>"]+$' and char_length(aviso_privacidad_url) between 12 and 300));

create or replace function public.med_aviso_privacidad()
returns text language sql stable security definer set search_path = '' as $$
  select aviso_privacidad_url from public.config_med where id = 1
$$;
revoke all on function public.med_aviso_privacidad() from public;
grant execute on function public.med_aviso_privacidad() to anon, authenticated;
