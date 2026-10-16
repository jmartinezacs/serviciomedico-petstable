-- =====================================================================
-- Servicio Médico · Migración 6
-- 1) Catálogo de padecimientos (para estadísticas por padecimiento/área)
-- 2) Avisos: suscripciones push, bitácora de envíos y claves VAPID
-- 3) Búsqueda de cuentas existentes de Supabase Auth para darles acceso
-- =====================================================================

-- ---------- 1. Padecimientos ------------------------------------------
create table if not exists public.padecimientos_med (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null check (char_length(btrim(nombre)) between 2 and 80),
  activo      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists padecimientos_med_nombre_uk on public.padecimientos_med (lower(btrim(nombre)));
alter table public.padecimientos_med enable row level security;

drop trigger if exists padecimientos_med_touch on public.padecimientos_med;
create trigger padecimientos_med_touch before update on public.padecimientos_med for each row execute function public.med_touch_updated_at();
drop trigger if exists padecimientos_med_audit on public.padecimientos_med;
create trigger padecimientos_med_audit after insert or update or delete on public.padecimientos_med for each row execute function public.med_auditar();

drop policy if exists padecimientos_med_sel on public.padecimientos_med;
create policy padecimientos_med_sel on public.padecimientos_med for select to authenticated using ((select public.med_es_admin()));
drop policy if exists padecimientos_med_ins on public.padecimientos_med;
create policy padecimientos_med_ins on public.padecimientos_med for insert to authenticated with check ((select public.med_es_admin()));
drop policy if exists padecimientos_med_upd on public.padecimientos_med;
create policy padecimientos_med_upd on public.padecimientos_med for update to authenticated using ((select public.med_es_admin())) with check ((select public.med_es_admin()));
drop policy if exists padecimientos_med_del on public.padecimientos_med;
create policy padecimientos_med_del on public.padecimientos_med for delete to authenticated using ((select public.med_es_admin()));
revoke all on public.padecimientos_med from anon, public;
grant select, insert, update, delete on public.padecimientos_med to authenticated;

-- Catálogo inicial (editable desde Usuarios → Configuración)
insert into public.padecimientos_med (nombre) values
  ('Gastroenteritis'), ('Cefalea'), ('Mialgia'), ('Rinofaringitis'), ('Faringoamigdalitis'),
  ('Lumbalgia'), ('Colitis'), ('Gastritis'), ('Dermatitis'), ('Conjuntivitis'),
  ('Infección de vías urinarias'), ('Hipertensión arterial'), ('Dismenorrea'),
  ('Herida / lesión menor'), ('Esguince / contusión'), ('Otro')
on conflict do nothing;

alter table public.atenciones_med
  add column if not exists padecimiento_id uuid references public.padecimientos_med(id) on delete restrict;
create index if not exists atenciones_med_padecimiento_idx on public.atenciones_med (padecimiento_id);

-- Atención con padecimiento (nueva firma; la anterior se elimina)
drop function if exists public.med_atender_cita(uuid, text, text, jsonb);
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
  update public.citas_med set estado = 'atendida' where id = p_cita;
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

-- Estadísticas de consultas atendidas por padecimiento (general y por área). Solo administradores.
create or replace function public.med_estadisticas_padecimientos(p_desde date, p_hasta date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  if not public.med_es_admin() then
    raise exception 'Solo administradores.' using errcode = '42501';
  end if;
  with base as (
    select ar.nombre as area, coalesce(p.nombre, 'Sin clasificar') as padecimiento
    from public.citas_med c
    join public.atenciones_med a on a.cita_id = c.id
    join public.colaboradores_med col on col.id = c.colaborador_id
    join public.areas_med ar on ar.id = col.area_id
    left join public.padecimientos_med p on p.id = a.padecimiento_id
    where c.estado = 'atendida' and c.fecha between p_desde and p_hasta
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'general', coalesce((select jsonb_agg(jsonb_build_object('padecimiento', padecimiento, 'n', n) order by n desc, padecimiento)
                         from (select padecimiento, count(*) n from base group by padecimiento) s), '[]'::jsonb),
    'por_area', coalesce((select jsonb_agg(jsonb_build_object('area', area, 'total', total, 'items', items) order by total desc, area)
                          from (select area, sum(n)::int total,
                                       jsonb_agg(jsonb_build_object('padecimiento', padecimiento, 'n', n) order by n desc, padecimiento) items
                                from (select area, padecimiento, count(*) n from base group by area, padecimiento) x
                                group by area) s), '[]'::jsonb)
  ) into v;
  return v;
end $$;
revoke all on function public.med_estadisticas_padecimientos(date, date) from public, anon;
grant execute on function public.med_estadisticas_padecimientos(date, date) to authenticated;

-- ---------- 2. Avisos (push y correo) ----------------------------------
alter table public.usuarios_med add column if not exists recibe_avisos boolean not null default false;
update public.usuarios_med set recibe_avisos = true where email = 'servicio.medico@petstable.mx';

create table if not exists public.push_subs_med (
  id          uuid primary key default gen_random_uuid(),
  usuario_id  uuid not null references public.usuarios_med(id) on delete cascade,
  endpoint    text not null check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  p256dh      text not null check (char_length(p256dh) <= 200),
  auth        text not null check (char_length(auth) <= 100),
  dispositivo text check (dispositivo is null or char_length(dispositivo) <= 200),
  created_at  timestamptz not null default now()
);
create unique index if not exists push_subs_med_endpoint_uk on public.push_subs_med (endpoint);
create index if not exists push_subs_med_usuario_idx on public.push_subs_med (usuario_id);
alter table public.push_subs_med enable row level security;
drop policy if exists push_subs_med_sel on public.push_subs_med;
create policy push_subs_med_sel on public.push_subs_med for select to authenticated using (usuario_id = (select public.med_usuario_actual_id()));
drop policy if exists push_subs_med_ins on public.push_subs_med;
create policy push_subs_med_ins on public.push_subs_med for insert to authenticated with check (usuario_id = (select public.med_usuario_actual_id()));
drop policy if exists push_subs_med_del on public.push_subs_med;
create policy push_subs_med_del on public.push_subs_med for delete to authenticated using (usuario_id = (select public.med_usuario_actual_id()));
revoke all on public.push_subs_med from anon, public;
grant select, insert, delete on public.push_subs_med to authenticated;

-- Registro de avisos enviados (evita duplicados por cita/evento)
create table if not exists public.avisos_med (
  id          bigint generated always as identity primary key,
  cita_id     uuid not null references public.citas_med(id) on delete cascade,
  evento      text not null check (evento in ('nueva_cita', 'confirmada', 'cancelada', 'reprogramada')),
  clave       text not null,
  enviados_push integer not null default 0,
  enviados_correo integer not null default 0,
  created_at  timestamptz not null default now()
);
create unique index if not exists avisos_med_uk on public.avisos_med (cita_id, evento, clave);
alter table public.avisos_med enable row level security;
revoke all on public.avisos_med from anon, public, authenticated;

-- Claves VAPID en un esquema privado (no expuesto por la API)
create schema if not exists med_private;
revoke all on schema med_private from public, anon, authenticated;
create table if not exists med_private.config_push (
  id smallint primary key default 1 check (id = 1),
  vapid_publica text not null,
  vapid_privada text not null,
  contacto text not null default 'mailto:servicio.medico@petstable.mx'
);
revoke all on med_private.config_push from public, anon, authenticated;

create or replace function public.med_vapid_publica()
returns text language sql stable security definer set search_path = '' as $$
  select vapid_publica from med_private.config_push where id = 1 and public.med_es_miembro()
$$;
revoke all on function public.med_vapid_publica() from public, anon;
grant execute on function public.med_vapid_publica() to authenticated;

-- Solo para la Edge Function (service_role)
create or replace function public.med_vapid_claves()
returns table (vapid_publica text, vapid_privada text, contacto text)
language sql stable security definer set search_path = '' as $$
  select vapid_publica, vapid_privada, contacto from med_private.config_push where id = 1
$$;
revoke all on function public.med_vapid_claves() from public, anon, authenticated;
grant execute on function public.med_vapid_claves() to service_role;

-- ---------- 3. Buscar cuentas existentes en Supabase Auth ---------------
-- Devuelve solo cuentas @petstable.mx, con nombre (metadatos) y foto sugerida
-- del bucket "avatares" (coincidencia por nombre de pila, sin acentos).
create or replace function public.med_buscar_cuentas(p_q text)
returns table (email text, nombre text, ultimo_acceso timestamptz, ya_registrado boolean, foto_sugerida text)
language plpgsql stable security definer set search_path = '' as $$
declare v_q text := lower(btrim(coalesce(p_q, '')));
begin
  if not public.med_es_admin() then
    raise exception 'Solo administradores.' using errcode = '42501';
  end if;
  if char_length(v_q) < 2 then return; end if;
  return query
  with cuentas as (
    select lower(au.email)::text as email,
           coalesce(nullif(btrim(au.raw_user_meta_data ->> 'full_name'), ''), nullif(btrim(au.raw_user_meta_data ->> 'nombre'), ''),
                    nullif(btrim(au.raw_user_meta_data ->> 'name'), ''),
                    initcap(replace(split_part(split_part(au.email, '@', 1), '.', 1), '_', ' ')) || ' ' ||
                    initcap(replace(split_part(split_part(au.email, '@', 1), '.', 2), '_', ' '))) as nombre,
           au.last_sign_in_at
    from auth.users au
    where au.email ilike '%@petstable.mx'
      and (au.email ilike '%' || v_q || '%' or coalesce(au.raw_user_meta_data ->> 'full_name', '') ilike '%' || v_q || '%')
    order by au.email
    limit 12
  )
  select c.email, btrim(c.nombre), c.last_sign_in_at,
         exists (select 1 from public.usuarios_med u where lower(u.email) = c.email),
         (select 'https://domumnsezocubigfqwry.supabase.co/storage/v1/object/public/avatares/' || o.name
            from storage.objects o
           where o.bucket_id = 'avatares'
             and translate(lower(split_part(split_part(o.name, '.', 1), ' ', 1)), 'áéíóúñ', 'aeioun')
                 = translate(lower(split_part(split_part(c.email, '@', 1), '.', 1)), 'áéíóúñ', 'aeioun')
           order by char_length(o.name), o.name limit 1)
  from cuentas c;
end $$;
revoke all on function public.med_buscar_cuentas(text) from public, anon;
grant execute on function public.med_buscar_cuentas(text) to authenticated;
