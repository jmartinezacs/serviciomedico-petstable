-- =====================================================================
-- Servicio Médico · Migración 2/2
-- Funciones de rol, reglas de negocio (triggers), auditoría, RLS,
-- funciones transaccionales (RPC) y vistas de consulta.
-- =====================================================================

-- ---------- Funciones auxiliares de identidad y tiempo -----------------
create or replace function public.med_usuario_actual_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select u.id from public.usuarios_med u
  where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', '')) and u.activo
  limit 1
$$;

create or replace function public.med_es_miembro()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.usuarios_med u
                 where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', '')) and u.activo)
$$;

create or replace function public.med_es_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.usuarios_med u
                 where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
                   and u.activo and u.rol = 'admin')
$$;

-- Fecha y hora local de operación
create or replace function public.med_ahora()
returns timestamp language sql stable set search_path = '' as $$
  select (now() at time zone 'America/Mexico_City')
$$;
create or replace function public.med_hoy()
returns date language sql stable set search_path = '' as $$
  select (now() at time zone 'America/Mexico_City')::date
$$;

-- Perfil de la sesión actual (lo usa el frontend al iniciar sesión)
create or replace function public.med_mi_perfil()
returns table (id uuid, email text, nombre text, rol text, area_id uuid, area text)
language sql stable security definer set search_path = '' as $$
  select u.id, u.email, u.nombre, u.rol, u.area_id, a.nombre
  from public.usuarios_med u left join public.areas_med a on a.id = u.area_id
  where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', '')) and u.activo
$$;

-- ---------- updated_at -------------------------------------------------
create or replace function public.med_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['areas_med','usuarios_med','colaboradores_med','config_med','citas_med','medicamentos_med','lotes_med'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.med_touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

-- ---------- Auditoría --------------------------------------------------
create or replace function public.med_auditar()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_cambios jsonb;
  v_id text;
begin
  if tg_op = 'DELETE' then
    v_id := (to_jsonb(old) ->> coalesce(tg_argv[0], 'id'));
    v_cambios := to_jsonb(old);
  elsif tg_op = 'INSERT' then
    v_id := (to_jsonb(new) ->> coalesce(tg_argv[0], 'id'));
    v_cambios := to_jsonb(new);
  else
    v_id := (to_jsonb(new) ->> coalesce(tg_argv[0], 'id'));
    select jsonb_object_agg(n.key, jsonb_build_array(o.value, n.value))
      into v_cambios
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value and n.key <> 'updated_at';
    if v_cambios is null then return new; end if;
  end if;
  -- No se replica contenido clínico en la bitácora
  if tg_table_name = 'atenciones_med' then
    v_cambios := null;
  end if;
  insert into public.bitacora_med (tabla, registro_id, accion, cambios, usuario_email)
  values (tg_table_name, v_id, tg_op, v_cambios, auth.jwt() ->> 'email');
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['areas_med','usuarios_med','colaboradores_med','config_med','citas_med','medicamentos_med'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.med_auditar()', t || '_audit', t);
  end loop;
end $$;
drop trigger if exists atenciones_med_audit on public.atenciones_med;
create trigger atenciones_med_audit after insert or update on public.atenciones_med
  for each row execute function public.med_auditar('cita_id');

-- ---------- Reglas de usuarios: nunca quedarse sin administrador ------
create or replace function public.med_validar_usuario()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.email := lower(btrim(new.email));
  new.nombre := btrim(new.nombre);
  if tg_op = 'UPDATE' then
    if lower(old.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
       and (new.activo is distinct from old.activo or new.rol is distinct from old.rol or new.email is distinct from old.email) then
      raise exception 'No puede cambiar su propio rol, correo ni estado.' using errcode = 'P0001';
    end if;
    if old.rol = 'admin' and old.activo and (new.rol <> 'admin' or not new.activo)
       and (select count(*) from public.usuarios_med where rol = 'admin' and activo and id <> old.id) = 0 then
      raise exception 'Debe existir al menos un administrador activo.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists usuarios_med_validar on public.usuarios_med;
create trigger usuarios_med_validar before insert or update on public.usuarios_med
  for each row execute function public.med_validar_usuario();

-- ---------- Normalización de catálogos --------------------------------
create or replace function public.med_normalizar_colaborador()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.nombre := btrim(regexp_replace(new.nombre, '\s+', ' ', 'g'));
  new.num_empleado := nullif(btrim(new.num_empleado), '');
  new.puesto := nullif(btrim(new.puesto), '');
  if tg_op = 'INSERT' then
    new.created_by := public.med_usuario_actual_id();
  else
    new.created_by := old.created_by;
  end if;
  if not exists (select 1 from public.areas_med a where a.id = new.area_id and a.activo) then
    raise exception 'El área seleccionada no está activa.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists colaboradores_med_normalizar on public.colaboradores_med;
create trigger colaboradores_med_normalizar before insert or update on public.colaboradores_med
  for each row execute function public.med_normalizar_colaborador();

create or replace function public.med_normalizar_medicamento()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.clave := upper(btrim(new.clave));
  new.nombre := btrim(regexp_replace(new.nombre, '\s+', ' ', 'g'));
  new.presentacion := nullif(btrim(new.presentacion), '');
  new.unidad := lower(btrim(new.unidad));
  return new;
end $$;
drop trigger if exists medicamentos_med_normalizar on public.medicamentos_med;
create trigger medicamentos_med_normalizar before insert or update on public.medicamentos_med
  for each row execute function public.med_normalizar_medicamento();

-- ---------- Reglas de negocio de citas --------------------------------
create or replace function public.med_validar_cita()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := public.med_usuario_actual_id();
  v_admin boolean := public.med_es_admin();
  v_ahora timestamp := public.med_ahora();
  v_hoy   date := public.med_hoy();
begin
  -- Operaciones de mantenimiento desde el panel/servidor (sin JWT de usuario)
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
    if v_admin then
      if new.fecha < v_hoy then
        raise exception 'No se pueden registrar citas en fechas pasadas.' using errcode = 'P0001';
      end if;
    elsif (new.fecha + new.hora) <= v_ahora then
      raise exception 'El horario seleccionado ya pasó. Elija un horario futuro.' using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- UPDATE
  if old.estado in ('atendida', 'cancelada', 'no_asistio') then
    raise exception 'La cita ya está cerrada y no puede modificarse.' using errcode = 'P0001';
  end if;
  if new.solicitado_por is distinct from old.solicitado_por or new.colaborador_id is distinct from old.colaborador_id then
    raise exception 'No se puede cambiar el colaborador ni el solicitante de una cita.' using errcode = 'P0001';
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
  end if;

  if (new.fecha, new.hora) is distinct from (old.fecha, old.hora) then
    if new.estado not in ('pendiente', 'confirmada') then
      raise exception 'Solo se reprograman citas pendientes o confirmadas.' using errcode = 'P0001';
    end if;
    if v_admin then
      if new.fecha < v_hoy then
        raise exception 'No se puede reprogramar a una fecha pasada.' using errcode = 'P0001';
      end if;
    elsif (new.fecha + new.hora) <= v_ahora then
      raise exception 'El horario seleccionado ya pasó.' using errcode = 'P0001';
    end if;
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

  if new.estado = 'no_asistio' and old.estado <> 'no_asistio' and (new.fecha + new.hora) > v_ahora then
    raise exception 'Solo se puede marcar inasistencia cuando el horario ya pasó.' using errcode = 'P0001';
  end if;
  if new.estado = 'pendiente' and old.estado = 'confirmada' then
    raise exception 'Una cita confirmada no puede regresar a pendiente.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists citas_med_validar on public.citas_med;
create trigger citas_med_validar before insert or update on public.citas_med
  for each row execute function public.med_validar_cita();

-- ---------- RPC: horarios ocupados (sin exponer datos personales) -----
create or replace function public.med_horarios_ocupados(p_fecha date)
returns setof time language sql stable security definer set search_path = '' as $$
  select c.hora from public.citas_med c
  where public.med_es_miembro() and c.fecha = p_fecha
    and c.estado in ('pendiente', 'confirmada', 'atendida')
  order by c.hora
$$;

-- ---------- RPC: atender cita + dispensar medicamentos (atómico) -------
create or replace function public.med_atender_cita(
  p_cita uuid, p_sintomatologia text, p_nota text, p_items jsonb default '[]'::jsonb)
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
  update public.citas_med set estado = 'atendida' where id = p_cita;
  perform set_config('med.atendiendo', '', true);

  insert into public.atenciones_med (cita_id, sintomatologia, nota, atendido_por)
  values (p_cita, nullif(btrim(p_sintomatologia), ''), nullif(btrim(p_nota), ''), v_uid);

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

-- ---------- RPC: entrada de inventario ---------------------------------
create or replace function public.med_registrar_entrada(
  p_medicamento uuid, p_lote text, p_caducidad date, p_cantidad integer, p_motivo text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := public.med_usuario_actual_id();
  v_lote public.lotes_med%rowtype;
  v_codigo text := upper(btrim(coalesce(p_lote, '')));
begin
  if not public.med_es_admin() then
    raise exception 'Solo Servicio Médico puede registrar entradas.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.medicamentos_med where id = p_medicamento and activo) then
    raise exception 'El medicamento no existe o está inactivo.' using errcode = 'P0001';
  end if;
  if char_length(v_codigo) < 1 or char_length(v_codigo) > 40 then
    raise exception 'Indique un número de lote válido.' using errcode = 'P0001';
  end if;
  if p_caducidad is null or p_caducidad <= public.med_hoy() then
    raise exception 'La caducidad debe ser posterior a hoy.' using errcode = 'P0001';
  end if;
  if p_cantidad is null or p_cantidad < 1 or p_cantidad > 100000 then
    raise exception 'La cantidad debe ser un entero entre 1 y 100000.' using errcode = 'P0001';
  end if;

  select * into v_lote from public.lotes_med
   where medicamento_id = p_medicamento and lower(btrim(lote)) = lower(v_codigo) for update;
  if found then
    if v_lote.caducidad <> p_caducidad then
      raise exception 'El lote % ya existe con caducidad %. Verifique los datos.', v_lote.lote, to_char(v_lote.caducidad, 'DD/MM/YYYY') using errcode = 'P0001';
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
end $$;

-- ---------- RPC: salida manual -----------------------------------------
create or replace function public.med_registrar_salida(p_lote uuid, p_cantidad integer, p_motivo text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := public.med_usuario_actual_id();
  v_lote public.lotes_med%rowtype;
begin
  if not public.med_es_admin() then
    raise exception 'Solo Servicio Médico puede registrar salidas.' using errcode = '42501';
  end if;
  if nullif(btrim(p_motivo), '') is null or char_length(p_motivo) > 300 then
    raise exception 'Indique el motivo de la salida (máx. 300 caracteres).' using errcode = 'P0001';
  end if;
  if p_cantidad is null or p_cantidad < 1 then
    raise exception 'La cantidad debe ser mayor a cero.' using errcode = 'P0001';
  end if;
  select * into v_lote from public.lotes_med where id = p_lote for update;
  if not found then raise exception 'Lote no encontrado.' using errcode = 'P0001'; end if;
  if v_lote.existencia < p_cantidad then
    raise exception 'Existencia insuficiente (disponible: %).', v_lote.existencia using errcode = 'P0001';
  end if;
  update public.lotes_med set existencia = existencia - p_cantidad where id = p_lote;
  insert into public.movimientos_med (tipo, medicamento_id, lote_id, cantidad, existencia_resultante, motivo, usuario_id)
  values ('salida', v_lote.medicamento_id, p_lote, -p_cantidad, v_lote.existencia - p_cantidad, btrim(p_motivo), v_uid);
end $$;

-- ---------- RPC: ajuste por conteo físico ------------------------------
create or replace function public.med_ajustar_lote(p_lote uuid, p_existencia_fisica integer, p_motivo text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := public.med_usuario_actual_id();
  v_lote public.lotes_med%rowtype;
begin
  if not public.med_es_admin() then
    raise exception 'Solo Servicio Médico puede ajustar inventario.' using errcode = '42501';
  end if;
  if nullif(btrim(p_motivo), '') is null or char_length(p_motivo) > 300 then
    raise exception 'Indique el motivo del ajuste (máx. 300 caracteres).' using errcode = 'P0001';
  end if;
  if p_existencia_fisica is null or p_existencia_fisica < 0 or p_existencia_fisica > 100000 then
    raise exception 'La existencia física debe ser un entero entre 0 y 100000.' using errcode = 'P0001';
  end if;
  select * into v_lote from public.lotes_med where id = p_lote for update;
  if not found then raise exception 'Lote no encontrado.' using errcode = 'P0001'; end if;
  if v_lote.existencia = p_existencia_fisica then
    raise exception 'La existencia física es igual a la registrada; no hay ajuste que aplicar.' using errcode = 'P0001';
  end if;
  update public.lotes_med set existencia = p_existencia_fisica where id = p_lote;
  insert into public.movimientos_med (tipo, medicamento_id, lote_id, cantidad, existencia_resultante, motivo, usuario_id)
  values ('ajuste', v_lote.medicamento_id, p_lote, p_existencia_fisica - v_lote.existencia, p_existencia_fisica, btrim(p_motivo), v_uid);
end $$;

-- ---------- Vistas (security_invoker: respetan RLS del usuario) --------
create or replace view public.v_citas_med with (security_invoker = true) as
select c.id, c.folio, 'CM-' || lpad(c.folio::text, 5, '0') as folio_txt,
       c.fecha, c.hora, c.motivo, c.descripcion, c.estado,
       c.motivo_cancelacion, c.created_at, c.updated_at,
       c.colaborador_id, col.nombre as colaborador, col.num_empleado,
       col.area_id, ar.nombre as area,
       c.solicitado_por, su.nombre as solicitante,
       c.cancelado_por, cu.nombre as cancelado_por_nombre
from public.citas_med c
join public.colaboradores_med col on col.id = c.colaborador_id
join public.areas_med ar on ar.id = col.area_id
join public.usuarios_med su on su.id = c.solicitado_por
left join public.usuarios_med cu on cu.id = c.cancelado_por;

create or replace view public.v_stock_med with (security_invoker = true) as
select m.id, m.clave, m.nombre, m.presentacion, m.unidad, m.stock_minimo, m.activo,
       coalesce(sum(l.existencia) filter (where l.caducidad >= public.med_hoy()), 0)::integer as existencia_vigente,
       coalesce(sum(l.existencia) filter (where l.caducidad <  public.med_hoy()), 0)::integer as existencia_caducada,
       min(l.caducidad) filter (where l.existencia > 0 and l.caducidad >= public.med_hoy()) as proxima_caducidad,
       count(l.id) filter (where l.existencia > 0)::integer as lotes_con_existencia,
       case
         when coalesce(sum(l.existencia) filter (where l.caducidad >= public.med_hoy()), 0) = 0 then 'agotado'
         when coalesce(sum(l.existencia) filter (where l.caducidad >= public.med_hoy()), 0) < m.stock_minimo then 'bajo'
         else 'ok'
       end as estado_stock
from public.medicamentos_med m
left join public.lotes_med l on l.medicamento_id = m.id
group by m.id;

create or replace view public.v_lotes_med with (security_invoker = true) as
select l.id, l.medicamento_id, m.clave, m.nombre as medicamento, m.unidad, l.lote, l.caducidad, l.existencia,
       (l.caducidad - public.med_hoy()) as dias_para_caducar,
       case
         when l.caducidad < public.med_hoy() then 'caducado'
         when l.caducidad - public.med_hoy() <= (select dias_alerta_caducidad from public.config_med where id = 1) then 'por_caducar'
         else 'vigente'
       end as estado_caducidad,
       l.created_at, l.updated_at
from public.lotes_med l
join public.medicamentos_med m on m.id = l.medicamento_id;

create or replace view public.v_movimientos_med with (security_invoker = true) as
select mv.id, mv.tipo, mv.cantidad, mv.existencia_resultante, mv.motivo, mv.created_at,
       mv.medicamento_id, m.clave, m.nombre as medicamento, m.unidad,
       mv.lote_id, l.lote, l.caducidad,
       mv.cita_id, case when c.folio is null then null else 'CM-' || lpad(c.folio::text, 5, '0') end as cita_folio,
       mv.usuario_id, u.nombre as usuario
from public.movimientos_med mv
join public.medicamentos_med m on m.id = mv.medicamento_id
join public.lotes_med l on l.id = mv.lote_id
join public.usuarios_med u on u.id = mv.usuario_id
left join public.citas_med c on c.id = mv.cita_id;

-- ---------- RPC: tablero (security invoker: respeta RLS) ---------------
create or replace function public.med_dashboard(p_desde date, p_hasta date)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_hoy date := public.med_hoy();
  v_admin boolean := public.med_es_admin();
  v_dias integer := (select dias_alerta_caducidad from public.config_med where id = 1);
  v_res jsonb;
  v_porDia boolean;
begin
  if not public.med_es_miembro() then
    raise exception 'Usuario no autorizado.' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 731 then
    raise exception 'Periodo inválido (máximo 2 años).' using errcode = 'P0001';
  end if;
  v_porDia := (p_hasta - p_desde) <= 62;

  with c as (
    select * from public.v_citas_med where fecha between p_desde and p_hasta
  )
  select jsonb_build_object(
    'hoy', v_hoy,
    'dias_alerta', v_dias,
    'citas_hoy', (select count(*) from public.citas_med where fecha = v_hoy and estado in ('pendiente','confirmada','atendida')),
    'pendientes', (select count(*) from public.citas_med where estado = 'pendiente' and fecha >= v_hoy),
    'confirmadas_proximas', (select count(*) from public.citas_med where estado = 'confirmada' and fecha >= v_hoy),
    'total', (select count(*) from c),
    'por_estado', coalesce((select jsonb_object_agg(estado, n) from (select estado, count(*) n from c group by estado) s), '{}'::jsonb),
    'por_area', coalesce((select jsonb_agg(jsonb_build_object('area', area, 'n', n) order by n desc) from (select area, count(*) n from c where estado <> 'cancelada' group by area) s), '[]'::jsonb),
    'por_motivo', coalesce((select jsonb_agg(jsonb_build_object('motivo', motivo, 'n', n) order by n desc) from (select motivo, count(*) n from c where estado <> 'cancelada' group by motivo) s), '[]'::jsonb),
    'serie', coalesce((
      select jsonb_agg(jsonb_build_object('periodo', periodo, 'total', total, 'atendidas', atendidas) order by periodo)
      from (
        select case when v_porDia then to_char(fecha, 'YYYY-MM-DD') else to_char(fecha, 'YYYY-MM') end as periodo,
               count(*) filter (where estado <> 'cancelada') as total,
               count(*) filter (where estado = 'atendida') as atendidas
        from c group by 1) s), '[]'::jsonb),
    'serie_por_dia', v_porDia
  ) into v_res;

  if v_admin then
    v_res := v_res || jsonb_build_object(
      'bajo_minimo', (select count(*) from public.v_stock_med where activo and estado_stock in ('bajo','agotado') and stock_minimo > 0),
      'agotados', (select count(*) from public.v_stock_med where activo and estado_stock = 'agotado'),
      'por_caducar', (select count(*) from public.v_lotes_med where existencia > 0 and estado_caducidad = 'por_caducar'),
      'caducados', (select count(*) from public.v_lotes_med where existencia > 0 and estado_caducidad = 'caducado'),
      'medicamentos_activos', (select count(*) from public.medicamentos_med where activo),
      'top_dispensados', coalesce((
        select jsonb_agg(jsonb_build_object('medicamento', medicamento, 'n', n) order by n desc)
        from (select m.nombre as medicamento, sum(-mv.cantidad) n
              from public.movimientos_med mv join public.medicamentos_med m on m.id = mv.medicamento_id
              where mv.tipo = 'dispensacion'
                and (mv.created_at at time zone 'America/Mexico_City')::date between p_desde and p_hasta
              group by m.nombre order by n desc limit 8) s), '[]'::jsonb)
    );
  end if;
  return v_res;
end $$;

-- ---------- Row Level Security -----------------------------------------
alter table public.areas_med         enable row level security;
alter table public.usuarios_med      enable row level security;
alter table public.colaboradores_med enable row level security;
alter table public.config_med        enable row level security;
alter table public.citas_med         enable row level security;
alter table public.atenciones_med    enable row level security;
alter table public.medicamentos_med  enable row level security;
alter table public.lotes_med         enable row level security;
alter table public.movimientos_med   enable row level security;
alter table public.bitacora_med      enable row level security;

-- Áreas
drop policy if exists areas_med_sel on public.areas_med;
create policy areas_med_sel on public.areas_med for select to authenticated using ((select public.med_es_miembro()));
drop policy if exists areas_med_ins on public.areas_med;
create policy areas_med_ins on public.areas_med for insert to authenticated with check ((select public.med_es_admin()));
drop policy if exists areas_med_upd on public.areas_med;
create policy areas_med_upd on public.areas_med for update to authenticated using ((select public.med_es_admin())) with check ((select public.med_es_admin()));
drop policy if exists areas_med_del on public.areas_med;
create policy areas_med_del on public.areas_med for delete to authenticated using ((select public.med_es_admin()));

-- Usuarios
drop policy if exists usuarios_med_sel on public.usuarios_med;
create policy usuarios_med_sel on public.usuarios_med for select to authenticated using ((select public.med_es_miembro()));
drop policy if exists usuarios_med_ins on public.usuarios_med;
create policy usuarios_med_ins on public.usuarios_med for insert to authenticated with check ((select public.med_es_admin()));
drop policy if exists usuarios_med_upd on public.usuarios_med;
create policy usuarios_med_upd on public.usuarios_med for update to authenticated using ((select public.med_es_admin())) with check ((select public.med_es_admin()));

-- Colaboradores: todos los miembros consultan y registran; solo admin edita/elimina
drop policy if exists colaboradores_med_sel on public.colaboradores_med;
create policy colaboradores_med_sel on public.colaboradores_med for select to authenticated using ((select public.med_es_miembro()));
drop policy if exists colaboradores_med_ins on public.colaboradores_med;
create policy colaboradores_med_ins on public.colaboradores_med for insert to authenticated with check ((select public.med_es_miembro()));
drop policy if exists colaboradores_med_upd on public.colaboradores_med;
create policy colaboradores_med_upd on public.colaboradores_med for update to authenticated using ((select public.med_es_admin())) with check ((select public.med_es_admin()));
drop policy if exists colaboradores_med_del on public.colaboradores_med;
create policy colaboradores_med_del on public.colaboradores_med for delete to authenticated using ((select public.med_es_admin()));

-- Configuración
drop policy if exists config_med_sel on public.config_med;
create policy config_med_sel on public.config_med for select to authenticated using ((select public.med_es_miembro()));
drop policy if exists config_med_upd on public.config_med;
create policy config_med_upd on public.config_med for update to authenticated using ((select public.med_es_admin())) with check ((select public.med_es_admin()));

-- Citas: admin ve todo; usuario solo las que solicitó. Sin DELETE (se cancelan).
drop policy if exists citas_med_sel on public.citas_med;
create policy citas_med_sel on public.citas_med for select to authenticated
  using ((select public.med_es_admin()) or solicitado_por = (select public.med_usuario_actual_id()));
drop policy if exists citas_med_ins on public.citas_med;
create policy citas_med_ins on public.citas_med for insert to authenticated
  with check ((select public.med_es_miembro()) and solicitado_por = (select public.med_usuario_actual_id()));
drop policy if exists citas_med_upd on public.citas_med;
create policy citas_med_upd on public.citas_med for update to authenticated
  using ((select public.med_es_admin()) or solicitado_por = (select public.med_usuario_actual_id()))
  with check ((select public.med_es_admin()) or solicitado_por = (select public.med_usuario_actual_id()));

-- Atenciones (datos clínicos): solo administradores
drop policy if exists atenciones_med_sel on public.atenciones_med;
create policy atenciones_med_sel on public.atenciones_med for select to authenticated using ((select public.med_es_admin()));
drop policy if exists atenciones_med_upd on public.atenciones_med;
create policy atenciones_med_upd on public.atenciones_med for update to authenticated using ((select public.med_es_admin())) with check ((select public.med_es_admin()));

-- Inventario: solo administradores; lotes y movimientos solo se escriben vía RPC
drop policy if exists medicamentos_med_sel on public.medicamentos_med;
create policy medicamentos_med_sel on public.medicamentos_med for select to authenticated using ((select public.med_es_admin()));
drop policy if exists medicamentos_med_ins on public.medicamentos_med;
create policy medicamentos_med_ins on public.medicamentos_med for insert to authenticated with check ((select public.med_es_admin()));
drop policy if exists medicamentos_med_upd on public.medicamentos_med;
create policy medicamentos_med_upd on public.medicamentos_med for update to authenticated using ((select public.med_es_admin())) with check ((select public.med_es_admin()));
drop policy if exists medicamentos_med_del on public.medicamentos_med;
create policy medicamentos_med_del on public.medicamentos_med for delete to authenticated using ((select public.med_es_admin()));

drop policy if exists lotes_med_sel on public.lotes_med;
create policy lotes_med_sel on public.lotes_med for select to authenticated using ((select public.med_es_admin()));
drop policy if exists movimientos_med_sel on public.movimientos_med;
create policy movimientos_med_sel on public.movimientos_med for select to authenticated using ((select public.med_es_admin()));
drop policy if exists bitacora_med_sel on public.bitacora_med;
create policy bitacora_med_sel on public.bitacora_med for select to authenticated using ((select public.med_es_admin()));

-- ---------- Privilegios ------------------------------------------------
revoke all on public.areas_med, public.usuarios_med, public.colaboradores_med, public.config_med,
              public.citas_med, public.atenciones_med, public.medicamentos_med, public.lotes_med,
              public.movimientos_med, public.bitacora_med,
              public.v_citas_med, public.v_stock_med, public.v_lotes_med, public.v_movimientos_med
  from anon, public;
grant select, insert, update, delete on public.areas_med, public.colaboradores_med, public.medicamentos_med to authenticated;
grant select, insert, update on public.usuarios_med, public.citas_med to authenticated;
grant select, update on public.config_med, public.atenciones_med to authenticated;
revoke insert, update, delete, truncate on public.lotes_med, public.movimientos_med, public.bitacora_med from authenticated;
grant select on public.lotes_med, public.movimientos_med, public.bitacora_med,
                public.v_citas_med, public.v_stock_med, public.v_lotes_med, public.v_movimientos_med to authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'med_usuario_actual_id()', 'med_es_miembro()', 'med_es_admin()', 'med_ahora()', 'med_hoy()', 'med_mi_perfil()',
    'med_horarios_ocupados(date)', 'med_atender_cita(uuid,text,text,jsonb)',
    'med_registrar_entrada(uuid,text,date,integer,text)', 'med_registrar_salida(uuid,integer,text)',
    'med_ajustar_lote(uuid,integer,text)', 'med_dashboard(date,date)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- Funciones de trigger: no invocables vía API
  foreach f in array array['med_touch_updated_at()', 'med_auditar()', 'med_validar_usuario()',
                           'med_normalizar_colaborador()', 'med_normalizar_medicamento()', 'med_validar_cita()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
