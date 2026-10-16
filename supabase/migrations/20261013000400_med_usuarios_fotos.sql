-- =====================================================================
-- Servicio Médico · Migración 4
-- Puesto y foto de usuarios, bucket propio de fotos (avatares_med) y
-- funciones para el alta de usuarios desde el sitio.
-- No modifica el bucket "avatares" ni sus políticas (solo se enlazan URLs).
-- =====================================================================
alter table public.usuarios_med
  add column if not exists puesto   text check (puesto is null or char_length(puesto) <= 100),
  add column if not exists foto_url text check (foto_url is null or (char_length(foto_url) <= 500 and foto_url ~ '^https://'));

-- Bucket propio: lectura pública (las fotos se muestran con <img>), escritura solo administradores
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatares_med', 'avatares_med', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists avatares_med_select on storage.objects;
create policy avatares_med_select on storage.objects for select to authenticated
  using (bucket_id = 'avatares_med' and (select public.med_es_admin()));
drop policy if exists avatares_med_insert on storage.objects;
create policy avatares_med_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatares_med' and (select public.med_es_admin()));
drop policy if exists avatares_med_update on storage.objects;
create policy avatares_med_update on storage.objects for update to authenticated
  using (bucket_id = 'avatares_med' and (select public.med_es_admin()))
  with check (bucket_id = 'avatares_med' and (select public.med_es_admin()));
drop policy if exists avatares_med_delete on storage.objects;
create policy avatares_med_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatares_med' and (select public.med_es_admin()));

-- Perfil de sesión con puesto y foto (cambia el tipo de retorno)
drop function if exists public.med_mi_perfil();
create function public.med_mi_perfil()
returns table (id uuid, email text, nombre text, rol text, area_id uuid, area text, puesto text, foto_url text)
language sql stable security definer set search_path = '' as $$
  select u.id, u.email, u.nombre, u.rol, u.area_id, a.nombre, u.puesto, u.foto_url
  from public.usuarios_med u left join public.areas_med a on a.id = u.area_id
  where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', '')) and u.activo
$$;
revoke all on function public.med_mi_perfil() from public, anon;
grant execute on function public.med_mi_perfil() to authenticated;

-- ¿El correo ya tiene cuenta en Supabase Auth? (solo administradores; solo @petstable.mx)
create or replace function public.med_correo_tiene_cuenta(p_email text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.med_es_admin() then
    raise exception 'Solo administradores.' using errcode = '42501';
  end if;
  if p_email !~* '^[a-z0-9._%+-]+@petstable\.mx$' then
    raise exception 'Correo inválido.' using errcode = 'P0001';
  end if;
  return exists (select 1 from auth.users where lower(email) = lower(btrim(p_email)));
end $$;
revoke all on function public.med_correo_tiene_cuenta(text) from public, anon;
grant execute on function public.med_correo_tiene_cuenta(text) to authenticated;

-- Fotos existentes en el bucket público "avatares" (solo se enlazan)
update public.usuarios_med u set foto_url = 'https://domumnsezocubigfqwry.supabase.co/storage/v1/object/public/avatares/' || v.archivo
from (values
  ('javier.martinez@petstable.mx', 'Javier.png'),
  ('kevin.hernandez@petstable.mx', 'Kevin.png'),
  ('nelisa.ramirez@petstable.mx',  'Nelisa.png'),
  ('julian.pacheco@petstable.mx',  'Julian.png'),
  ('abigail.ordaz@petstable.mx',   'Abigail.png')
) as v(email, archivo)
where u.email = v.email and u.foto_url is null
  and exists (select 1 from storage.objects o where o.bucket_id = 'avatares' and o.name = v.archivo);
