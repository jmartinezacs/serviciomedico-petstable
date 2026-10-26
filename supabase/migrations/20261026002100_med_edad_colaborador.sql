-- =====================================================================
-- Servicio Médico · Migración 21 (v1.18): edad del colaborador.
-- El médico registra la edad al atender; se guarda en la atención (edad a la
-- fecha de la consulta) y actualiza la edad del colaborador (vista Colaboradores).
-- Datos: CM-00006 se reasigna a "Sergio Acosta" (Logística); se eliminan el
-- registro duplicado "Sergio Acosta Santiago" y el área "Congelados" (error de
-- captura; se aplicó directamente el 2026-10-26 con autorización del usuario).
-- =====================================================================
alter table public.colaboradores_med add column edad smallint
  constraint colaboradores_med_edad_ck check (edad between 14 and 100);
alter table public.atenciones_med add column edad smallint
  constraint atenciones_med_edad_ck check (edad between 14 and 100);

drop function if exists public.med_atender_cita(uuid, text, text, jsonb, uuid);
create function public.med_atender_cita(p_cita uuid, p_sintomatologia text, p_nota text, p_items jsonb DEFAULT '[]'::jsonb, p_padecimiento uuid DEFAULT NULL::uuid, p_edad integer DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid  uuid := public.med_usuario_actual_id();
  v_cita public.citas_med%rowtype;
  v_item jsonb;
  v_lote public.lotes_med%rowtype;
  v_med  public.medicamentos_med%rowtype;
  v_cant integer;
  v_hoy  date := public.med_hoy();
begin
  if not public.med_es_medico() then
    raise exception 'Solo el médico de Servicio Médico puede registrar atenciones.' using errcode = '42501';
  end if;
  if p_padecimiento is null or not exists (select 1 from public.padecimientos_med where id = p_padecimiento and activo) then
    raise exception 'Selecciona el padecimiento atendido.' using errcode = 'P0001';
  end if;
  if p_edad is not null and (p_edad < 14 or p_edad > 100) then
    raise exception 'La edad debe estar entre 14 y 100 años.' using errcode = 'P0001';
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

  insert into public.atenciones_med (cita_id, sintomatologia, nota, atendido_por, padecimiento_id, edad)
  values (p_cita, nullif(btrim(p_sintomatologia), ''), nullif(btrim(p_nota), ''), v_uid, p_padecimiento, p_edad);

  -- La edad capturada actualiza la del colaborador
  if p_edad is not null then
    update public.colaboradores_med set edad = p_edad where id = v_cita.colaborador_id and edad is distinct from p_edad;
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select * into v_lote from public.lotes_med where id = (v_item ->> 'lote_id')::uuid for update;
    if not found then raise exception 'Lote no encontrado.' using errcode = 'P0001'; end if;
    select * into v_med from public.medicamentos_med where id = v_lote.medicamento_id;
    if v_med.categoria = 'equipo' then
      raise exception '% es equipo y no se entrega en consulta.', v_med.nombre using errcode = 'P0001';
    end if;
    if v_med.control = 'envase' then
      begin
        v_cant := (v_item ->> 'nivel')::integer;
      exception when others then
        raise exception 'Indica cuánto queda del envase.' using errcode = 'P0001';
      end;
      perform public.med_usar_envase(v_lote.id, v_cant, p_cita, null, v_uid);
      continue;
    end if;
    begin
      v_cant := (v_item ->> 'cantidad')::integer;
    exception when others then
      raise exception 'Cantidad inválida.' using errcode = 'P0001';
    end;
    if v_cant is null or v_cant < 1 or v_cant > 1000 then
      raise exception 'La cantidad debe ser un entero entre 1 y 1000.' using errcode = 'P0001';
    end if;
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
end $function$;
revoke all on function public.med_atender_cita(uuid, text, text, jsonb, uuid, integer) from public, anon;
grant execute on function public.med_atender_cita(uuid, text, text, jsonb, uuid, integer) to authenticated;
