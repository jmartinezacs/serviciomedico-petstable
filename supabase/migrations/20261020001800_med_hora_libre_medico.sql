-- =====================================================================
-- Servicio Médico · Migración 18 (v1.14)
-- 1) El médico (es_medico) puede agendar o reprogramar citas normales a
--    cualquier hora (no solo en bloques de 20 min) y aunque el horario esté
--    marcado sin servicio. Los demás siguen limitados a los bloques de
--    09:00 a 17:00 (:00, :20, :40), ahora validado en el trigger.
-- 2) La constancia muestra "Dr." antes del nombre de quien atendió si es el médico.
-- =====================================================================
alter table public.citas_med drop constraint citas_med_horario_ck;
alter table public.citas_med add constraint citas_med_horario_ck check (
  (tipo = 'normal' and hora is not null and extract(second from hora) = 0)
  or (tipo = 'urgente' and (hora is null or extract(second from hora) = 0))
);

create or replace function public.med_es_bloque(p_hora time)
 returns boolean
 language sql
 immutable
 set search_path to ''
as $$
  select p_hora between time '09:00' and time '17:00'
     and extract(minute from p_hora) in (0, 20, 40)
     and extract(second from p_hora) = 0
$$;

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
    -- El médico agenda a la hora que quiera; los demás, solo en los bloques de la agenda
    if not v_medico then
      if not public.med_es_bloque(new.hora) then
        raise exception 'Elige un horario de la agenda (de 9:00 a 17:00, cada 20 minutos).' using errcode = 'P0001';
      end if;
      if (new.fecha + new.hora) <= v_ahora then
        raise exception 'El horario seleccionado ya pasó. Elija un horario futuro.' using errcode = 'P0001';
      end if;
      v_bloq := public.med_motivo_bloqueo(new.fecha, new.hora);
      if v_bloq is not null then
        raise exception 'Sin servicio médico en ese horario: %. Elige otro horario o usa Cita de urgencia.', v_bloq using errcode = 'P0001';
      end if;
    end if;
    return new;
  end if;

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
    if new.tipo = 'normal' and not v_medico then
      if not public.med_es_bloque(new.hora) then
        raise exception 'Elige un horario de la agenda (de 9:00 a 17:00, cada 20 minutos).' using errcode = 'P0001';
      end if;
      if (new.fecha + new.hora) <= v_ahora then
        raise exception 'El horario seleccionado ya pasó.' using errcode = 'P0001';
      end if;
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

create or replace function public.med_constancia(p_cita uuid)
 returns table(folio_txt text, colaborador text, num_empleado text, area text, puesto text, fecha date, hora time without time zone, tipo text, atendido_at timestamp with time zone, atendio text)
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare v_uid uuid := public.med_usuario_actual_id();
begin
  if v_uid is null then raise exception 'Usuario no autorizado.' using errcode = '42501'; end if;
  return query
    select 'CM-' || lpad(c.folio::text, 5, '0'), co.nombre, co.num_empleado, a.nombre, co.puesto,
           c.fecha, c.hora, c.tipo, at.atendido_at,
           case when u.es_medico then 'Dr. ' || u.nombre else u.nombre end
      from public.citas_med c
      join public.colaboradores_med co on co.id = c.colaborador_id
      left join public.areas_med a on a.id = co.area_id
      join public.atenciones_med at on at.cita_id = c.id
      left join public.usuarios_med u on u.id = at.atendido_por
     where c.id = p_cita and c.estado = 'atendida'
       and (public.med_es_admin() or c.solicitado_por = v_uid);
end $function$;
