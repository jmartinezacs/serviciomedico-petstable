-- =====================================================================
-- Servicio Médico · Migración 22 (v1.19): exámenes médicos de ingreso y egreso.
-- Acceso: el médico y los usuarios de las áreas Servicio Médico, Procesos y
-- Mejora continua y Recursos Humanos (med_puede_examenes).
-- - Ingreso: candidato, área, puesto, fecha y hora. Si el médico lo dictamina
--   APTO (con o sin restricciones), el candidato queda registrado como colaborador.
-- - Egreso: colaborador existente (cualquiera). Al registrar el examen, el
--   colaborador queda desactivado.
-- Reglas en el trigger med_validar_examen y en la RPC med_registrar_examen.
-- =====================================================================

create or replace function public.med_puede_examenes()
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $$
  select exists (
    select 1 from public.usuarios_med u
      left join public.areas_med a on a.id = u.area_id
     where u.id = public.med_usuario_actual_id() and u.activo
       and (u.es_medico or public.med_nombre_norm(a.nombre) in ('servicio medico', 'procesos y mejora continua', 'recursos humanos')))
$$;
revoke all on function public.med_puede_examenes() from public, anon;
grant execute on function public.med_puede_examenes() to authenticated;

create sequence public.examenes_med_folio_seq;
create table public.examenes_med (
  id                 uuid primary key default gen_random_uuid(),
  folio              integer not null default nextval('public.examenes_med_folio_seq'),
  tipo               text not null check (tipo in ('ingreso', 'egreso')),
  estado             text not null default 'pendiente' check (estado in ('pendiente', 'confirmado', 'realizado', 'cancelado')),
  fecha              date not null,
  hora               time not null check (extract(second from hora) = 0),
  candidato          text check (candidato is null or char_length(candidato) between 3 and 120),
  area_id            uuid not null references public.areas_med(id) on delete restrict,
  puesto             text check (puesto is null or char_length(puesto) <= 100),
  colaborador_id     uuid references public.colaboradores_med(id) on delete restrict,
  motivo             text check (motivo is null or char_length(motivo) <= 300),
  resultado          text check (resultado in ('apto', 'no_apto', 'apto_restricciones', 'apto_restricciones_sin_interferencia', 'sin_hallazgos', 'con_hallazgos')),
  observaciones      text check (observaciones is null or char_length(observaciones) <= 1500),
  solicitado_por     uuid not null references public.usuarios_med(id) on delete restrict,
  atendido_por       uuid references public.usuarios_med(id) on delete set null,
  realizado_at       timestamptz,
  motivo_cancelacion text check (motivo_cancelacion is null or char_length(motivo_cancelacion) <= 300),
  cancelado_por      uuid references public.usuarios_med(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint examenes_med_folio_uk unique (folio),
  constraint examenes_med_datos_ck check (
    (tipo = 'ingreso' and candidato is not null and puesto is not null)
    or (tipo = 'egreso' and colaborador_id is not null)),
  constraint examenes_med_resultado_ck check (
    (estado = 'realizado') = (resultado is not null)
    and (resultado is null
         or (tipo = 'ingreso' and resultado in ('apto', 'no_apto', 'apto_restricciones', 'apto_restricciones_sin_interferencia'))
         or (tipo = 'egreso' and resultado in ('sin_hallazgos', 'con_hallazgos')))),
  constraint examenes_med_cancelacion_ck check (estado <> 'cancelado' or motivo_cancelacion is not null)
);
alter sequence public.examenes_med_folio_seq owned by public.examenes_med.folio;
create index examenes_med_fecha_idx on public.examenes_med (fecha desc, hora);
create index examenes_med_estado_idx on public.examenes_med (estado);
create index examenes_med_colab_idx on public.examenes_med (colaborador_id);
create index examenes_med_area_idx on public.examenes_med (area_id);
create index examenes_med_solicita_idx on public.examenes_med (solicitado_por);
create index examenes_med_atendido_idx on public.examenes_med (atendido_por);
create index examenes_med_cancelado_idx on public.examenes_med (cancelado_por);

alter table public.examenes_med enable row level security;
create policy examenes_med_sel on public.examenes_med for select to authenticated using ((select public.med_puede_examenes()));
create policy examenes_med_ins on public.examenes_med for insert to authenticated with check ((select public.med_puede_examenes()));
create policy examenes_med_upd on public.examenes_med for update to authenticated using ((select public.med_puede_examenes())) with check ((select public.med_puede_examenes()));
revoke all on public.examenes_med from anon;
grant select, insert, update on public.examenes_med to authenticated;

create or replace function public.med_validar_examen()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_uid    uuid := public.med_usuario_actual_id();
  v_medico boolean := public.med_es_medico();
  v_hoy    date := public.med_hoy();
  v_col    public.colaboradores_med%rowtype;
begin
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;
  if v_uid is null or not public.med_puede_examenes() then
    raise exception 'No tienes acceso a los exámenes médicos.' using errcode = '42501';
  end if;

  new.candidato := nullif(regexp_replace(btrim(new.candidato), '\s+', ' ', 'g'), '');
  new.puesto := nullif(btrim(new.puesto), '');
  new.motivo := nullif(btrim(new.motivo), '');
  new.motivo_cancelacion := nullif(btrim(new.motivo_cancelacion), '');

  if tg_op = 'INSERT' then
    new.solicitado_por := v_uid;
    -- Si lo programa el médico, queda confirmado
    new.estado := case when v_medico then 'confirmado' else 'pendiente' end;
    new.resultado := null; new.observaciones := null; new.atendido_por := null; new.realizado_at := null;
    new.motivo_cancelacion := null; new.cancelado_por := null;
    if new.fecha < v_hoy then
      raise exception 'La fecha del examen no puede ser pasada.' using errcode = 'P0001';
    end if;
    if new.tipo = 'ingreso' then
      new.colaborador_id := null;
      if not exists (select 1 from public.areas_med where id = new.area_id and activo) then
        raise exception 'Selecciona un área activa.' using errcode = 'P0001';
      end if;
    else
      select * into v_col from public.colaboradores_med where id = new.colaborador_id;
      if not found or not v_col.activo then
        raise exception 'El colaborador no existe o ya está dado de baja.' using errcode = 'P0001';
      end if;
      if exists (select 1 from public.examenes_med e where e.colaborador_id = new.colaborador_id and e.tipo = 'egreso' and e.estado in ('pendiente', 'confirmado')) then
        raise exception 'Ese colaborador ya tiene un examen de egreso pendiente.' using errcode = 'P0001';
      end if;
      new.candidato := null;
      new.area_id := v_col.area_id;
      new.puesto := coalesce(new.puesto, v_col.puesto);
    end if;
    return new;
  end if;

  -- UPDATE
  if old.estado in ('realizado', 'cancelado') then
    raise exception 'El examen ya está cerrado y no puede modificarse.' using errcode = 'P0001';
  end if;
  if new.tipo is distinct from old.tipo or new.solicitado_por is distinct from old.solicitado_por
     or new.folio is distinct from old.folio
     or (old.tipo = 'egreso' and new.colaborador_id is distinct from old.colaborador_id) then
    raise exception 'No se puede cambiar el tipo, el folio, el solicitante ni el colaborador del examen.' using errcode = 'P0001';
  end if;
  if new.estado = 'realizado' and coalesce(current_setting('med.examinando', true), '') <> '1' then
    raise exception 'Para registrar el resultado utiliza "Registrar resultado".' using errcode = 'P0001';
  end if;
  if coalesce(current_setting('med.examinando', true), '') = '1' then
    return new;
  end if;
  if new.resultado is not null or new.observaciones is not null or new.atendido_por is not null or new.realizado_at is not null then
    raise exception 'El resultado solo se registra con "Registrar resultado".' using errcode = 'P0001';
  end if;

  if not v_medico then
    if old.solicitado_por <> v_uid then
      raise exception 'Solo quien solicitó el examen o el médico pueden modificarlo.' using errcode = '42501';
    end if;
    if new.estado not in (old.estado, 'cancelado') then
      raise exception 'Solo el médico confirma los exámenes.' using errcode = '42501';
    end if;
    if old.estado = 'confirmado' and (new.fecha, new.hora, new.candidato, new.area_id, new.puesto, new.motivo)
         is distinct from (old.fecha, old.hora, old.candidato, old.area_id, old.puesto, old.motivo) then
      raise exception 'El examen ya fue confirmado; solicita el cambio a Servicio Médico.' using errcode = 'P0001';
    end if;
  end if;
  if new.estado = 'pendiente' and old.estado = 'confirmado' then
    raise exception 'Un examen confirmado no puede regresar a pendiente.' using errcode = 'P0001';
  end if;
  if (new.fecha, new.hora) is distinct from (old.fecha, old.hora) and new.fecha < v_hoy then
    raise exception 'La fecha del examen no puede ser pasada.' using errcode = 'P0001';
  end if;
  if old.tipo = 'egreso' then
    new.area_id := old.area_id;
  elsif new.area_id is distinct from old.area_id and not exists (select 1 from public.areas_med where id = new.area_id and activo) then
    raise exception 'Selecciona un área activa.' using errcode = 'P0001';
  end if;
  if old.tipo = 'ingreso' then new.colaborador_id := null; end if;

  if new.estado = 'cancelado' then
    if new.motivo_cancelacion is null then
      raise exception 'Indica el motivo de la cancelación.' using errcode = 'P0001';
    end if;
    new.cancelado_por := v_uid;
  else
    new.motivo_cancelacion := null; new.cancelado_por := null;
  end if;
  return new;
end $function$;

create trigger examenes_med_validar before insert or update on public.examenes_med
  for each row execute function public.med_validar_examen();
create trigger examenes_med_touch before update on public.examenes_med
  for each row execute function public.med_touch_updated_at();
create trigger examenes_med_audit after insert or update or delete on public.examenes_med
  for each row execute function public.med_auditar();

-- La bitácora no copia las condiciones/restricciones del dictamen
create or replace function public.med_auditar()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
  if tg_table_name = 'atenciones_med' then
    v_cambios := null;
  elsif tg_table_name = 'examenes_med' then
    v_cambios := v_cambios - 'observaciones';
  end if;
  insert into public.bitacora_med (tabla, registro_id, accion, cambios, usuario_email)
  values (tg_table_name, v_id, tg_op, v_cambios, auth.jwt() ->> 'email');
  return coalesce(new, old);
end $function$;

-- Registro del resultado (solo el médico). Ingreso APTO: alta del colaborador.
-- Egreso: baja (desactivación) del colaborador.
create or replace function public.med_registrar_examen(p_examen uuid, p_resultado text, p_observaciones text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_uid uuid := public.med_usuario_actual_id();
  v_ex  public.examenes_med%rowtype;
  v_obs text := nullif(btrim(p_observaciones), '');
  v_col uuid;
begin
  if not public.med_es_medico() then
    raise exception 'Solo el médico de Servicio Médico registra el resultado del examen.' using errcode = '42501';
  end if;
  select * into v_ex from public.examenes_med where id = p_examen for update;
  if not found then raise exception 'El examen no existe.' using errcode = 'P0001'; end if;
  if v_ex.estado not in ('pendiente', 'confirmado') then
    raise exception 'El examen ya está cerrado.' using errcode = 'P0001';
  end if;
  if v_ex.fecha > public.med_hoy() then
    raise exception 'El examen está programado para una fecha futura; reprográmalo para hoy si ya se realizó.' using errcode = 'P0001';
  end if;
  if (v_ex.tipo = 'ingreso' and p_resultado not in ('apto', 'no_apto', 'apto_restricciones', 'apto_restricciones_sin_interferencia'))
     or (v_ex.tipo = 'egreso' and p_resultado not in ('sin_hallazgos', 'con_hallazgos')) or p_resultado is null then
    raise exception 'Selecciona el resultado del examen.' using errcode = 'P0001';
  end if;
  if p_resultado in ('apto_restricciones', 'apto_restricciones_sin_interferencia', 'con_hallazgos') and v_obs is null then
    raise exception 'Escribe las condiciones y restricciones.' using errcode = 'P0001';
  end if;
  if char_length(coalesce(v_obs, '')) > 1500 then
    raise exception 'El texto excede la longitud permitida.' using errcode = 'P0001';
  end if;

  v_col := v_ex.colaborador_id;
  if v_ex.tipo = 'ingreso' and p_resultado <> 'no_apto' then
    -- Alta: reutiliza al colaborador con el mismo nombre en la misma área (reactivándolo) o lo crea
    select id into v_col from public.colaboradores_med
     where nombre_norm = public.med_nombre_norm(v_ex.candidato) and area_id = v_ex.area_id
     order by activo desc limit 1;
    if v_col is null then
      insert into public.colaboradores_med (nombre, area_id, puesto) values (v_ex.candidato, v_ex.area_id, v_ex.puesto)
      returning id into v_col;
    else
      update public.colaboradores_med set activo = true, puesto = coalesce(v_ex.puesto, puesto) where id = v_col;
    end if;
  elsif v_ex.tipo = 'egreso' then
    update public.colaboradores_med set activo = false where id = v_ex.colaborador_id;
  end if;

  perform set_config('med.examinando', '1', true);
  update public.examenes_med
     set estado = 'realizado', resultado = p_resultado, observaciones = v_obs,
         atendido_por = v_uid, realizado_at = now(),
         colaborador_id = case when v_ex.tipo = 'ingreso' then v_col else colaborador_id end
   where id = p_examen;
  perform set_config('med.examinando', '', true);
  return jsonb_build_object('colaborador_id', v_col);
end $function$;
revoke all on function public.med_registrar_examen(uuid, text, text) from public, anon;
grant execute on function public.med_registrar_examen(uuid, text, text) to authenticated;

-- Vista con nombres (respeta RLS de quien consulta)
create view public.v_examenes_med with (security_invoker = true) as
select e.id, e.folio, 'EX-' || lpad(e.folio::text, 5, '0') as folio_txt, e.tipo, e.estado, e.fecha, e.hora,
       e.candidato, e.colaborador_id, col.nombre as colaborador, coalesce(e.candidato, col.nombre) as persona,
       e.area_id, ar.nombre as area, e.puesto, e.motivo, e.resultado, e.observaciones,
       e.solicitado_por, su.nombre as solicitante,
       e.atendido_por, case when au.es_medico then 'Dr. ' || au.nombre else au.nombre end as atendio,
       e.realizado_at, e.motivo_cancelacion, e.cancelado_por, cu.nombre as cancelado_por_nombre,
       e.created_at, e.updated_at
  from public.examenes_med e
  join public.areas_med ar on ar.id = e.area_id
  join public.usuarios_med su on su.id = e.solicitado_por
  left join public.colaboradores_med col on col.id = e.colaborador_id
  left join public.usuarios_med au on au.id = e.atendido_por
  left join public.usuarios_med cu on cu.id = e.cancelado_por;
revoke all on public.v_examenes_med from anon;
grant select on public.v_examenes_med to authenticated;

-- Avisos de exámenes enviados (evita duplicados); solo la Edge Function (service_role)
create table public.avisos_examen_med (
  id         uuid primary key default gen_random_uuid(),
  examen_id  uuid not null references public.examenes_med(id) on delete cascade,
  evento     text not null,
  clave      text not null default 'u',
  enviados   integer not null default 0,
  created_at timestamptz not null default now(),
  constraint avisos_examen_med_uk unique (examen_id, evento, clave)
);
alter table public.avisos_examen_med enable row level security;
revoke all on public.avisos_examen_med from anon, authenticated;
