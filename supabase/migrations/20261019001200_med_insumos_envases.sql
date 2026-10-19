-- =====================================================================
-- Servicio Médico · Migración 12 (v1.8)
--  1) Categoría del artículo: medicamento, insumo o equipo.
--  2) Caducidad opcional para insumos y equipo (los medicamentos la exigen).
--  3) Control por "envase" para productos que no se cuentan por pieza
--     (geles, cremas, frascos, aerosoles, rollos): la existencia es el número
--     de envases y cada lote guarda el nivel aproximado del envase abierto.
--     Cada uso registra el nivel restante (movimiento "uso", sin descontar);
--     al terminarse el envase se descuenta 1.
-- =====================================================================

-- ---------- 1 y 3. Catálogo ----------
alter table public.medicamentos_med add column if not exists categoria text not null default 'medicamento';
alter table public.medicamentos_med drop constraint if exists medicamentos_med_categoria_check;
alter table public.medicamentos_med add constraint medicamentos_med_categoria_check check (categoria in ('medicamento', 'insumo', 'equipo'));
alter table public.medicamentos_med add column if not exists control text not null default 'pieza';
alter table public.medicamentos_med drop constraint if exists medicamentos_med_control_check;
alter table public.medicamentos_med add constraint medicamentos_med_control_check check (control in ('pieza', 'envase'));

-- ---------- 2. Lotes: caducidad opcional y nivel del envase abierto ----------
alter table public.lotes_med alter column caducidad drop not null;
alter table public.lotes_med add column if not exists nivel smallint;
alter table public.lotes_med drop constraint if exists lotes_med_nivel_check;
alter table public.lotes_med add constraint lotes_med_nivel_check check (nivel is null or nivel in (25, 50, 75, 100));

-- ---------- 3. Movimiento "uso" (registra el nivel, no cambia la existencia) ----------
alter table public.movimientos_med drop constraint if exists movimientos_med_tipo_check;
alter table public.movimientos_med add constraint movimientos_med_tipo_check check (tipo in ('entrada', 'salida', 'ajuste', 'dispensacion', 'uso'));
alter table public.movimientos_med drop constraint if exists movimientos_med_cantidad_check;
alter table public.movimientos_med add constraint movimientos_med_cantidad_check check (cantidad <> 0 or tipo = 'uso');
alter table public.movimientos_med drop constraint if exists movimientos_med_signo_ck;
alter table public.movimientos_med add constraint movimientos_med_signo_ck check (
  (tipo = 'entrada' and cantidad > 0) or (tipo in ('salida', 'dispensacion') and cantidad < 0) or tipo = 'ajuste' or (tipo = 'uso' and cantidad = 0));
alter table public.movimientos_med drop constraint if exists movimientos_med_dispensa_ck;
alter table public.movimientos_med add constraint movimientos_med_dispensa_ck check (
  (tipo = 'dispensacion' and cita_id is not null) or tipo = 'uso' or (tipo in ('entrada', 'salida', 'ajuste') and cita_id is null));

-- ---------- Vistas (columnas nuevas al final) ----------
create or replace view public.v_lotes_med with (security_invoker = true) as
 select l.id, l.medicamento_id, m.clave, m.nombre as medicamento, m.unidad, l.lote, l.caducidad, l.existencia,
    (l.caducidad - public.med_hoy()) as dias_para_caducar,
    case
      when l.caducidad is null then 'sin_caducidad'
      when l.caducidad < public.med_hoy() then 'caducado'
      when (l.caducidad - public.med_hoy()) <= (select c.dias_alerta_caducidad from public.config_med c where c.id = 1) then 'por_caducar'
      else 'vigente'
    end as estado_caducidad,
    l.created_at, l.updated_at, m.empaque, m.contenido_empaque,
    m.categoria, m.control, l.nivel
   from public.lotes_med l join public.medicamentos_med m on m.id = l.medicamento_id;

create or replace view public.v_stock_med with (security_invoker = true) as
 select m.id, m.clave, m.nombre, m.presentacion, m.unidad, m.stock_minimo, m.activo,
    coalesce(sum(l.existencia) filter (where l.caducidad is null or l.caducidad >= public.med_hoy()), 0)::integer as existencia_vigente,
    coalesce(sum(l.existencia) filter (where l.caducidad < public.med_hoy()), 0)::integer as existencia_caducada,
    min(l.caducidad) filter (where l.existencia > 0 and l.caducidad >= public.med_hoy()) as proxima_caducidad,
    (count(l.id) filter (where l.existencia > 0))::integer as lotes_con_existencia,
    case
      when coalesce(sum(l.existencia) filter (where l.caducidad is null or l.caducidad >= public.med_hoy()), 0) = 0 then 'agotado'
      when coalesce(sum(l.existencia) filter (where l.caducidad is null or l.caducidad >= public.med_hoy()), 0) < m.stock_minimo then 'bajo'
      else 'ok'
    end as estado_stock,
    m.empaque, m.contenido_empaque,
    m.categoria, m.control,
    min(l.nivel) filter (where l.existencia > 0 and l.nivel is not null) as nivel_abierto
   from public.medicamentos_med m left join public.lotes_med l on l.medicamento_id = m.id
  group by m.id;

create or replace view public.v_movimientos_med with (security_invoker = true) as
 select mv.id, mv.tipo, mv.cantidad, mv.existencia_resultante, mv.motivo, mv.created_at, mv.medicamento_id, m.clave,
    m.nombre as medicamento, m.unidad, mv.lote_id, l.lote, l.caducidad, mv.cita_id,
    case when c.folio is null then null::text else 'CM-' || lpad(c.folio::text, 5, '0') end as cita_folio,
    mv.usuario_id, u.nombre as usuario, m.empaque, m.contenido_empaque,
    m.categoria, m.control
   from public.movimientos_med mv
   join public.medicamentos_med m on m.id = mv.medicamento_id
   join public.lotes_med l on l.id = mv.lote_id
   join public.usuarios_med u on u.id = mv.usuario_id
   left join public.citas_med c on c.id = mv.cita_id;

-- ---------- Entradas: caducidad obligatoria solo para medicamentos ----------
create or replace function public.med_registrar_entrada(p_medicamento uuid, p_lote text, p_caducidad date, p_cantidad integer, p_motivo text default null)
returns uuid language plpgsql security definer set search_path = '' as $function$
declare
  v_uid  uuid := public.med_usuario_actual_id();
  v_lote public.lotes_med%rowtype;
  v_cat  text;
  v_codigo text := upper(btrim(coalesce(p_lote, '')));
begin
  if not public.med_es_admin() then
    raise exception 'Solo Servicio Médico puede registrar entradas.' using errcode = '42501';
  end if;
  select categoria into v_cat from public.medicamentos_med where id = p_medicamento and activo;
  if v_cat is null then
    raise exception 'El artículo no existe o está inactivo.' using errcode = 'P0001';
  end if;
  if v_codigo = '' and v_cat <> 'medicamento' then
    v_codigo := 'S/N' || coalesce('-' || to_char(p_caducidad, 'YYYY-MM-DD'), '');
  end if;
  if char_length(v_codigo) < 1 or char_length(v_codigo) > 40 then
    raise exception 'Indique un número de lote válido.' using errcode = 'P0001';
  end if;
  if p_caducidad is null and v_cat = 'medicamento' then
    raise exception 'Indique la caducidad del medicamento.' using errcode = 'P0001';
  end if;
  if p_caducidad is not null and p_caducidad <= public.med_hoy() then
    raise exception 'La caducidad debe ser posterior a hoy.' using errcode = 'P0001';
  end if;
  if p_cantidad is null or p_cantidad < 1 or p_cantidad > 100000 then
    raise exception 'La cantidad debe ser un entero entre 1 y 100000.' using errcode = 'P0001';
  end if;

  select * into v_lote from public.lotes_med
   where medicamento_id = p_medicamento and lower(btrim(lote)) = lower(v_codigo) for update;
  if found then
    if v_lote.caducidad is distinct from p_caducidad then
      raise exception 'El lote % ya existe con caducidad %. Verifique los datos.', v_lote.lote, coalesce(to_char(v_lote.caducidad, 'DD/MM/YYYY'), 'sin caducidad') using errcode = 'P0001';
    end if;
    update public.lotes_med set existencia = existencia + p_cantidad where id = v_lote.id
      returning * into v_lote;
  else
    insert into public.lotes_med (medicamento_id, lote, caducidad, existencia)
    values (p_medicamento, v_codigo, p_caducidad, p_cantidad) returning * into v_lote;
  end if;

  insert into public.movimientos_med (tipo, medicamento_id, lote_id, cantidad, existencia_resultante, motivo, usuario_id)
  values ('entrada', p_medicamento, v_lote.id, p_cantidad, v_lote.existencia, nullif(btrim(p_motivo), ''), v_uid);
  return v_lote.id;
end $function$;

-- ---------- Uso de un envase (núcleo compartido) ----------
-- p_nivel: 100, 75, 50 o 25 = lo que queda del envase abierto; 0 = se terminó (descuenta 1 envase)
create or replace function public.med_usar_envase(p_lote uuid, p_nivel integer, p_cita uuid, p_motivo text, p_uid uuid)
returns void language plpgsql security definer set search_path = '' as $function$
declare
  v_lote public.lotes_med%rowtype; v_ctrl text;
  v_txt text := case p_nivel when 100 then 'lleno' when 75 then '¾' when 50 then '½' when 25 then '¼' else null end;
begin
  if p_nivel is null or p_nivel not in (0, 25, 50, 75, 100) then
    raise exception 'Indica cuánto queda del envase.' using errcode = 'P0001';
  end if;
  select * into v_lote from public.lotes_med where id = p_lote for update;
  if not found then raise exception 'Lote no encontrado.' using errcode = 'P0001'; end if;
  select control into v_ctrl from public.medicamentos_med where id = v_lote.medicamento_id;
  if v_ctrl <> 'envase' then
    raise exception 'Este artículo se controla por pieza; captura la cantidad.' using errcode = 'P0001';
  end if;
  if v_lote.caducidad < public.med_hoy() then
    raise exception 'El lote % está caducado y no puede usarse.', v_lote.lote using errcode = 'P0001';
  end if;
  if v_lote.existencia < 1 then
    raise exception 'No hay envases disponibles en el lote %.', v_lote.lote using errcode = 'P0001';
  end if;
  if p_nivel = 0 then
    update public.lotes_med set existencia = existencia - 1, nivel = null where id = v_lote.id;
    insert into public.movimientos_med (tipo, medicamento_id, lote_id, cantidad, existencia_resultante, cita_id, motivo, usuario_id)
    values (case when p_cita is null then 'salida' else 'dispensacion' end, v_lote.medicamento_id, v_lote.id, -1, v_lote.existencia - 1, p_cita,
            left(concat_ws(' · ', 'Envase terminado', nullif(btrim(p_motivo), '')), 300), p_uid);
  else
    update public.lotes_med set nivel = p_nivel where id = v_lote.id;
    insert into public.movimientos_med (tipo, medicamento_id, lote_id, cantidad, existencia_resultante, cita_id, motivo, usuario_id)
    values ('uso', v_lote.medicamento_id, v_lote.id, 0, v_lote.existencia, p_cita,
            left(concat_ws(' · ', 'Envase abierto: queda ' || v_txt, nullif(btrim(p_motivo), '')), 300), p_uid);
  end if;
end $function$;
revoke all on function public.med_usar_envase(uuid, integer, uuid, text, uuid) from public, anon, authenticated;

-- Uso fuera de consulta (desde Inventario)
create or replace function public.med_registrar_uso(p_lote uuid, p_nivel integer, p_motivo text default null)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  if not public.med_es_admin() then
    raise exception 'Solo Servicio Médico puede registrar usos.' using errcode = '42501';
  end if;
  if char_length(coalesce(p_motivo, '')) > 250 then
    raise exception 'El detalle excede la longitud permitida.' using errcode = 'P0001';
  end if;
  perform public.med_usar_envase(p_lote, p_nivel, null, p_motivo, public.med_usuario_actual_id());
end $function$;
revoke all on function public.med_registrar_uso(uuid, integer, text) from public, anon;
grant execute on function public.med_registrar_uso(uuid, integer, text) to authenticated;

-- ---------- Atención: artículos por pieza (cantidad) o por envase (nivel) ----------
create or replace function public.med_atender_cita(p_cita uuid, p_sintomatologia text, p_nota text, p_items jsonb default '[]'::jsonb, p_padecimiento uuid default null::uuid)
returns void language plpgsql security definer set search_path = '' as $function$
declare
  v_uid  uuid := public.med_usuario_actual_id();
  v_cita public.citas_med%rowtype;
  v_item jsonb;
  v_lote public.lotes_med%rowtype;
  v_med  public.medicamentos_med%rowtype;
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

-- Salidas y ajustes que dejan un lote en cero ya no tienen envase abierto
create or replace function public.med_nivel_sin_existencia() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.existencia = 0 then new.nivel := null; end if;
  return new;
end $$;
revoke all on function public.med_nivel_sin_existencia() from public, anon, authenticated;
drop trigger if exists lotes_med_nivel on public.lotes_med;
create trigger lotes_med_nivel before update on public.lotes_med for each row execute function public.med_nivel_sin_existencia();
