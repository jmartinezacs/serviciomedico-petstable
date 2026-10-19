-- =====================================================================
-- Servicio Médico · Migración 16 (v1.11)
--  1) Rol de médico (usuarios_med.es_medico): solo servicio.medico@petstable.mx
--     gestiona las citas (confirmar, asignar horario, reprogramar, cancelar,
--     registrar atención, marcar inasistencia y reabrir).
--  2) La atención (padecimiento, sintomatología, nota) solo la ve el médico.
--  3) Inasistencia: se puede marcar desde el día de la cita.
--  4) Búsqueda de colaboradores sin importar acentos ni mayúsculas.
-- =====================================================================

-- ---------- 1. Médico ----------
alter table public.usuarios_med add column if not exists es_medico boolean not null default false;
update public.usuarios_med set es_medico = true where lower(email) = 'servicio.medico@petstable.mx';

create or replace function public.med_es_medico()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.usuarios_med u
                 where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
                   and u.activo and u.rol = 'admin' and u.es_medico)
$$;
revoke all on function public.med_es_medico() from public, anon;
grant execute on function public.med_es_medico() to authenticated, service_role;

drop function if exists public.med_mi_perfil();
create function public.med_mi_perfil()
returns table (id uuid, email text, nombre text, rol text, area_id uuid, area text, puesto text, foto_url text, es_medico boolean)
language sql stable security definer set search_path = '' as $function$
  select u.id, u.email, u.nombre, u.rol, u.area_id, a.nombre, u.puesto, u.foto_url, u.es_medico
  from public.usuarios_med u left join public.areas_med a on a.id = u.area_id
  where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', '')) and u.activo
$function$;
revoke all on function public.med_mi_perfil() from public, anon;
grant execute on function public.med_mi_perfil() to authenticated;

-- ---------- 2. Atenciones: solo el médico ----------
drop policy if exists atenciones_med_sel on public.atenciones_med;
create policy atenciones_med_sel on public.atenciones_med for select to authenticated using ((select public.med_es_medico()));
drop policy if exists atenciones_med_upd on public.atenciones_med;
create policy atenciones_med_upd on public.atenciones_med for update to authenticated
  using ((select public.med_es_medico())) with check ((select public.med_es_medico()));

-- Registrar atención: solo el médico
do $$
declare v_def text := pg_get_functiondef('public.med_atender_cita(uuid, text, text, jsonb, uuid)'::regprocedure);
begin
  v_def := replace(v_def,
    E'if not public.med_es_admin() then\n    raise exception ''Solo Servicio Médico puede registrar atenciones.''',
    E'if not public.med_es_medico() then\n    raise exception ''Solo el médico de Servicio Médico puede registrar atenciones.''');
  if position('med_es_medico' in v_def) = 0 then raise exception 'No se pudo actualizar med_atender_cita'; end if;
  execute v_def;
end $$;

-- ---------- 1 y 3. Validación de citas ----------
create or replace function public.med_validar_cita()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_uid    uuid := public.med_usuario_actual_id();
  v_medico boolean := public.med_es_medico();
  v_ahora  timestamp := public.med_ahora();
  v_hoy    date := public.med_hoy();
  v_bloq   text;
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
    if not public.med_puede_citar(new.colaborador_id) then
      raise exception 'Solo puedes solicitar citas para ti o para colaboradores de tu misma área.' using errcode = '42501';
    end if;
    if new.fecha < v_hoy then
      raise exception 'No se pueden registrar citas en fechas pasadas.' using errcode = 'P0001';
    end if;
    if new.tipo = 'urgente' then
      if new.descripcion is null then
        raise exception 'Describe brevemente el motivo de la urgencia.' using errcode = 'P0001';
      end if;
      if not v_medico then new.hora := null; end if;
      return new;
    end if;
    if not v_medico and (new.fecha + new.hora) <= v_ahora then
      raise exception 'El horario seleccionado ya pasó. Elija un horario futuro.' using errcode = 'P0001';
    end if;
    v_bloq := public.med_motivo_bloqueo(new.fecha, new.hora);
    if v_bloq is not null then
      raise exception 'Sin servicio médico en ese horario: %. Elige otro horario o usa Cita de urgencia.', v_bloq using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- Reabrir una inasistencia (solo el médico) para registrar la atención
  if old.estado = 'no_asistio' and new.estado = 'confirmada' and v_medico
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

  -- Quien no es el médico solo puede modificar o cancelar las citas pendientes que solicitó
  if not v_medico then
    if old.solicitado_por <> v_uid then
      raise exception 'Solo el médico de Servicio Médico puede gestionar esta cita.' using errcode = '42501';
    end if;
    if new.estado not in (old.estado, 'cancelada') then
      raise exception 'Solo el médico de Servicio Médico puede cambiar el estado de la cita.' using errcode = '42501';
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
    if new.tipo = 'normal' and not v_medico and (new.fecha + new.hora) <= v_ahora then
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

  if new.estado = 'no_asistio' and old.estado <> 'no_asistio' and new.fecha > v_hoy then
    raise exception 'Solo se puede marcar inasistencia el día de la cita o después.' using errcode = 'P0001';
  end if;
  if new.estado = 'pendiente' and old.estado = 'confirmada' then
    raise exception 'Una cita confirmada no puede regresar a pendiente.' using errcode = 'P0001';
  end if;
  return new;
end $function$;

-- ---------- 4. Búsqueda sin acentos ----------
alter table public.colaboradores_med add column if not exists nombre_norm text
  generated always as (public.med_nombre_norm(nombre)) stored;
create index if not exists colaboradores_med_nombre_norm_ix on public.colaboradores_med (nombre_norm);
