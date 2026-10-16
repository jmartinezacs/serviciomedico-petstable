-- =====================================================================
-- Servicio Médico · Migración 8
-- 1) Bloques de 20 minutos (09:00 a 17:20; último bloque 17:00)
-- 2) Citas de urgencia / extraordinarias: se solicitan sin horario y el
--    médico asigna un horario especial al confirmarlas (o las rechaza).
-- 3) Recordatorio cada hora (07:00-19:00) al médico mientras haya citas
--    pendientes, mediante pg_cron + pg_net → Edge Function recordatorios_med.
-- =====================================================================
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ---------- 1 y 2. Tipo de cita y horario --------------------------------
alter table public.citas_med add column if not exists tipo text not null default 'normal'
  check (tipo in ('normal', 'urgente'));
alter table public.citas_med alter column hora drop not null;

alter table public.citas_med drop constraint if exists citas_med_dia_habil_ck;
alter table public.citas_med add constraint citas_med_dia_habil_ck
  check (tipo = 'urgente' or extract(isodow from fecha) between 1 and 5);

alter table public.citas_med drop constraint if exists citas_med_horario_ck;
alter table public.citas_med add constraint citas_med_horario_ck check (
  (tipo = 'normal' and hora is not null and hora between time '09:00' and time '17:00'
     and extract(minute from hora) in (0, 20, 40) and extract(second from hora) = 0)
  or (tipo = 'urgente' and (hora is null or extract(second from hora) = 0))
);
alter table public.citas_med drop constraint if exists citas_med_urgente_hora_ck;
alter table public.citas_med add constraint citas_med_urgente_hora_ck
  check (estado in ('pendiente', 'cancelada') or hora is not null);

drop index if exists public.citas_med_bloque_uk;
create unique index citas_med_bloque_uk on public.citas_med (fecha, hora)
  where estado in ('pendiente', 'confirmada', 'atendida') and tipo = 'normal';

-- Reglas de negocio (versión con urgencias)
create or replace function public.med_validar_cita()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := public.med_usuario_actual_id();
  v_admin boolean := public.med_es_admin();
  v_ahora timestamp := public.med_ahora();
  v_hoy   date := public.med_hoy();
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
      if not v_admin then new.hora := null; end if;   -- el médico asigna el horario
      return new;
    end if;
    if not v_admin and (new.fecha + new.hora) <= v_ahora then
      raise exception 'El horario seleccionado ya pasó. Elija un horario futuro.' using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- UPDATE
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
end $$;
revoke all on function public.med_validar_cita() from public, anon, authenticated;

-- Horarios ocupados (incluye urgencias con horario asignado)
create or replace function public.med_horarios_ocupados(p_fecha date)
returns setof time language sql stable security definer set search_path = '' as $$
  select c.hora from public.citas_med c
  where public.med_es_miembro() and c.fecha = p_fecha and c.hora is not null
    and c.estado in ('pendiente', 'confirmada', 'atendida')
  order by c.hora
$$;

-- Atender: si la urgencia no tenía horario se registra la hora actual
create or replace function public.med_atender_cita(
  p_cita uuid, p_sintomatologia text, p_nota text, p_items jsonb default '[]'::jsonb, p_padecimiento uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := public.med_usuario_actual_id();
  v_cita public.citas_med%rowtype;
  v_item jsonb;
  v_lote public.lotes_med%rowtype;
  v_cant integer;
  v_hoy  date := public.med_hoy();
begin
  if not public.med_es_admin() then
    raise exception 'Solo Servicio Médico puede registrar atenciones.' using errcode = '42501';
  end if;
  if p_padecimiento is null or not exists (select 1 from public.padecimientos_med where id = p_padecimiento and activo) then
    raise exception 'Selecciona el padecimiento atendido.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 20 then
    raise exception 'Lista de medicamentos inválida (máximo 20 renglones).' using errcode = 'P0001';
  end if;
  if char_length(coalesce(p_sintomatologia, '')) > 500 or char_length(coalesce(p_nota, '')) > 1000 then
    raise exception 'El texto excede la longitud permitida.' using errcode = 'P0001';
  end if;

  select * into v_cita from public.citas_med where id = p_cita for update;
  if not found then raise exception 'La cita no existe.' using errcode = 'P0001'; end if;
  if v_cita.estado not in ('pendiente', 'confirmada') then
    raise exception 'La cita no está pendiente ni confirmada.' using errcode = 'P0001';
  end if;
  if v_cita.fecha > v_hoy then
    raise exception 'No se puede atender una cita de fecha futura.' using errcode = 'P0001';
  end if;

  perform set_config('med.atendiendo', '1', true);
  update public.citas_med
     set estado = 'atendida',
         hora = coalesce(hora, date_trunc('minute', public.med_ahora())::time)
   where id = p_cita;
  perform set_config('med.atendiendo', '', true);

  insert into public.atenciones_med (cita_id, sintomatologia, nota, atendido_por, padecimiento_id)
  values (p_cita, nullif(btrim(p_sintomatologia), ''), nullif(btrim(p_nota), ''), v_uid, p_padecimiento);

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    begin
      v_cant := (v_item ->> 'cantidad')::integer;
    exception when others then
      raise exception 'Cantidad inválida.' using errcode = 'P0001';
    end;
    if v_cant is null or v_cant < 1 or v_cant > 1000 then
      raise exception 'La cantidad debe ser un entero entre 1 y 1000.' using errcode = 'P0001';
    end if;
    select * into v_lote from public.lotes_med where id = (v_item ->> 'lote_id')::uuid for update;
    if not found then raise exception 'Lote no encontrado.' using errcode = 'P0001'; end if;
    if v_lote.caducidad < v_hoy then
      raise exception 'El lote % está caducado y no puede dispensarse.', v_lote.lote using errcode = 'P0001';
    end if;
    if v_lote.existencia < v_cant then
      raise exception 'Existencia insuficiente en el lote % (disponible: %).', v_lote.lote, v_lote.existencia using errcode = 'P0001';
    end if;
    update public.lotes_med set existencia = existencia - v_cant where id = v_lote.id;
    insert into public.movimientos_med (tipo, medicamento_id, lote_id, cantidad, existencia_resultante, cita_id, motivo, usuario_id)
    values ('dispensacion', v_lote.medicamento_id, v_lote.id, -v_cant, v_lote.existencia - v_cant, p_cita, null, v_uid);
  end loop;
end $$;
revoke all on function public.med_atender_cita(uuid, text, text, jsonb, uuid) from public, anon;
grant execute on function public.med_atender_cita(uuid, text, text, jsonb, uuid) to authenticated;

-- Vista con el tipo de cita (columna agregada al final)
create or replace view public.v_citas_med with (security_invoker = true) as
select c.id, c.folio, 'CM-' || lpad(c.folio::text, 5, '0') as folio_txt,
       c.fecha, c.hora, c.motivo, c.descripcion, c.estado,
       c.motivo_cancelacion, c.created_at, c.updated_at,
       c.colaborador_id, col.nombre as colaborador, col.num_empleado,
       col.area_id, ar.nombre as area,
       c.solicitado_por, su.nombre as solicitante,
       c.cancelado_por, cu.nombre as cancelado_por_nombre,
       c.tipo
from public.citas_med c
join public.colaboradores_med col on col.id = c.colaborador_id
join public.areas_med ar on ar.id = col.area_id
join public.usuarios_med su on su.id = c.solicitado_por
left join public.usuarios_med cu on cu.id = c.cancelado_por;

-- ---------- 3. Recordatorio horario al médico -----------------------------
create table if not exists med_private.cron (
  id smallint primary key default 1 check (id = 1),
  secreto text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
);
insert into med_private.cron (id) values (1) on conflict do nothing;
revoke all on med_private.cron from public, anon, authenticated;

create or replace function public.med_cron_secreto()
returns text language sql stable security definer set search_path = '' as $$
  select secreto from med_private.cron where id = 1
$$;
revoke all on function public.med_cron_secreto() from public, anon, authenticated;
grant execute on function public.med_cron_secreto() to service_role;

-- Cada hora en punto; la Edge Function solo envía entre 07:00 y 19:00 (hora de Ciudad de México)
select cron.unschedule(jobid) from cron.job where jobname = 'med_recordatorio_pendientes';
select cron.schedule('med_recordatorio_pendientes', '0 * * * *', $cron$
  select net.http_post(
    url := 'https://domumnsezocubigfqwry.supabase.co/functions/v1/recordatorios_med',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-med-cron', (select secreto from med_private.cron where id = 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000)
$cron$);
