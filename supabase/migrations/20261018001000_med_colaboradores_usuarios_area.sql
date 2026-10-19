-- =====================================================================
-- Servicio Médico · Migración 10 (v1.7)
--  1) Cada usuario del sistema es también colaborador de su área
--     (colaboradores_med.usuario_id) y se mantiene sincronizado.
--  2) Un usuario (no administrador) solo solicita citas para sí mismo o
--     para colaboradores de su misma área. Administradores: todos.
--  3) Carga inicial de colaboradores por área (archivo del médico).
-- =====================================================================

-- ---------- 1. Vínculo usuario ↔ colaborador ----------
alter table public.colaboradores_med add column if not exists usuario_id uuid
  references public.usuarios_med (id) on delete set null;
create unique index if not exists colaboradores_med_usuario_uk on public.colaboradores_med (usuario_id) where usuario_id is not null;

-- Nombre normalizado (sin acentos, minúsculas, espacios simples) para evitar duplicados
create or replace function public.med_nombre_norm(p text) returns text
language sql immutable set search_path = '' as $$
  select lower(btrim(regexp_replace(translate(coalesce(p, ''), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN'), '\s+', ' ', 'g')))
$$;

-- Crea o actualiza el colaborador vinculado a un usuario
create or replace function public.med_sincronizar_colaborador(p_usuario uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare u public.usuarios_med%rowtype; v_col uuid;
begin
  select * into u from public.usuarios_med where id = p_usuario;
  if not found or u.area_id is null then return; end if;
  select id into v_col from public.colaboradores_med where usuario_id = u.id;
  if v_col is null then
    -- Si ya existe un colaborador sin vínculo con el mismo nombre, se vincula en lugar de duplicarlo
    select id into v_col from public.colaboradores_med
     where usuario_id is null and public.med_nombre_norm(nombre) = public.med_nombre_norm(u.nombre)
     order by created_at limit 1;
  end if;
  if v_col is null then
    insert into public.colaboradores_med (nombre, area_id, puesto, usuario_id)
    values (u.nombre, u.area_id, u.puesto, u.id);
  else
    update public.colaboradores_med
       set usuario_id = u.id, nombre = u.nombre, area_id = u.area_id, puesto = coalesce(u.puesto, puesto)
     where id = v_col;
  end if;
end $$;
revoke all on function public.med_sincronizar_colaborador(uuid) from public, anon, authenticated;

create or replace function public.med_usuario_a_colaborador() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.med_sincronizar_colaborador(new.id);
  return new;
end $$;
revoke all on function public.med_usuario_a_colaborador() from public, anon, authenticated;
drop trigger if exists usuarios_med_colaborador on public.usuarios_med;
create trigger usuarios_med_colaborador after insert or update of nombre, area_id, puesto on public.usuarios_med
  for each row execute function public.med_usuario_a_colaborador();

-- ---------- 3. Carga inicial de colaboradores (archivo del médico) ----------
do $$
declare r record; v_area uuid;
begin
  for r in select * from (values
    ('Ana Moreno Vargas','Producción'),('Ángel de Jesús Ramírez Vilchis','Producción'),('Angélica Marcelo Benigno','Producción'),
    ('Brayan Saúl Gómez Hernández','Producción'),('César Miguel Álvarez Martínez','Producción'),('Cynthia Arleth Gómez Reséndiz','Producción'),
    ('Edgar Mendoza Morales','Producción'),('Eduardo Félix Olvedo','Producción'),('Edwin Rubén Aguirre Villanueva','Producción'),
    ('Erik de la Rosa Sánchez','Producción'),('Felipe de Jesús Gutiérrez García','Producción'),('Irene Elizabeth Hernández Zamora','Producción'),
    ('Jenifer Monserrat Cruz Ortega','Producción'),('Jonathan Alan Mendoza Gudiño','Producción'),('Jonathan Sánchez','Producción'),
    ('Jorge Núñez Zamora','Producción'),('José Alberto Jiménez Domínguez','Producción'),('José Fernando Hernández Hernández','Producción'),
    ('José Vicente Martínez Ruiz','Producción'),('Karen Lizbeth Velázquez Aguilar','Producción'),('Luis Enrique Fernando Hernández','Producción'),
    ('Luis Gerardo Coheto González','Producción'),('Maribel Mendoza González','Producción'),('María del Carmen Núñez','Producción'),
    ('María Griselda de la Cruz Hernández','Producción'),('Mariana Cruz Martínez','Producción'),('Maura Olivares Mera','Producción'),
    ('Miguel Ángel García','Producción'),('Nayeli Gutiérrez Martínez','Producción'),('Omar Mario Mancilla González','Producción'),
    ('Óscar Sabido Valdivia','Producción'),('Rafael Agustín Becerra','Producción'),('Ricardo Celerino Rosas','Producción'),
    ('Rosendo Agustín Aguilar Bolaños','Producción'),
    ('Alejandro Villanueva','Logística'),('Angélica Claudia Martín','Logística'),('Axel Alberto Ruiz','Logística'),('Eduardo Galindo','Logística'),
    ('Erik Rodríguez','Logística'),('Ever Jesús Rodríguez','Logística'),('Felipe de Jesús Peralta','Logística'),('Fernando Iván Gutiérrez','Logística'),
    ('Fernando Martínez','Logística'),('Gerardo Rodríguez','Logística'),('Jair Flores','Logística'),('Jaaziel Israel García','Logística'),
    ('Jesús Uriel Serrano','Logística'),('Jorge Arturo Cirigo','Logística'),('José Carlos Vázquez','Logística'),('José Sebastián Cruz','Logística'),
    ('Julio Domínguez','Logística'),('Luz Fabiola Arroyo','Logística'),('Marco Antonio Ordóñez','Logística'),('Marco Antonio Piña','Logística'),
    ('Maribel Cruz','Logística'),('Marielena Espinoza','Logística'),('Miguel Ángel Fuentes','Logística'),('Miguel Ángel Moya','Logística'),
    ('Ricardo Rodríguez','Logística'),('Rogelio Guzmán','Logística'),('Rubén Antonio','Logística'),('Salvador Vázquez','Logística'),
    ('Sergio Acosta','Logística'),('Víctor Hugo Salazar','Logística'),('Yeni Paola González','Logística'),
    ('Gerardo Gudiño','Procesos y mejora continua'),('Heidy Castro','Procesos y mejora continua'),
    ('Luis Antonio Benítez','Calidad'),('Jesús Daniel Cruz','Calidad'),('Juan José Ramírez','Calidad'),('Luis Antonio Santos','Calidad'),
    ('Pablo Leonardo Torres','Calidad')
  ) v(nombre, area) loop
    select id into v_area from public.areas_med where public.med_nombre_norm(nombre) = public.med_nombre_norm(r.area);
    if v_area is null then
      insert into public.areas_med (nombre) values (r.area) returning id into v_area;
    end if;
    if not exists (select 1 from public.colaboradores_med where public.med_nombre_norm(nombre) = public.med_nombre_norm(r.nombre)) then
      insert into public.colaboradores_med (nombre, area_id) values (r.nombre, v_area);
    end if;
  end loop;
end $$;

-- Usuarios existentes → colaboradores (vincula por nombre si ya estaban en el archivo)
do $$
declare u record;
begin
  for u in select id from public.usuarios_med loop
    perform public.med_sincronizar_colaborador(u.id);
  end loop;
end $$;

-- ---------- 2. Citas: usuarios solo para sí mismos o su área ----------
create or replace function public.med_puede_citar(p_colaborador uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.med_es_admin() or exists (
    select 1 from public.colaboradores_med c
      join public.usuarios_med u on u.id = public.med_usuario_actual_id()
     where c.id = p_colaborador
       and (c.usuario_id = u.id or (u.area_id is not null and c.area_id = u.area_id)))
$$;
revoke all on function public.med_puede_citar(uuid) from public, anon;
grant execute on function public.med_puede_citar(uuid) to authenticated;

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
