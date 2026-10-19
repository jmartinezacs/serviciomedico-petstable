-- =====================================================================
-- Servicio Médico · Migración 15 (v1.10): edición manual de un lote
-- (número de lote y caducidad) por Servicio Médico. La existencia no se
-- toca aquí. El cambio queda en la bitácora.
-- =====================================================================
create or replace function public.med_editar_lote(p_lote uuid, p_codigo text, p_caducidad date)
returns void language plpgsql security definer set search_path = '' as $function$
declare
  v_lote public.lotes_med%rowtype; v_cat text;
  v_codigo text := upper(btrim(coalesce(p_codigo, '')));
begin
  if not public.med_es_admin() then
    raise exception 'Solo Servicio Médico puede editar lotes.' using errcode = '42501';
  end if;
  select * into v_lote from public.lotes_med where id = p_lote for update;
  if not found then raise exception 'Lote no encontrado.' using errcode = 'P0001'; end if;
  select categoria into v_cat from public.medicamentos_med where id = v_lote.medicamento_id;
  if char_length(v_codigo) < 1 or char_length(v_codigo) > 40 then
    raise exception 'Indique un número de lote válido.' using errcode = 'P0001';
  end if;
  if p_caducidad is null and v_cat = 'medicamento' then
    raise exception 'Indique la caducidad del medicamento.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.lotes_med where medicamento_id = v_lote.medicamento_id and id <> v_lote.id
               and lower(btrim(lote)) = lower(v_codigo)) then
    raise exception 'Ya existe otro lote % para este artículo.', v_codigo using errcode = 'P0001';
  end if;
  if (v_lote.lote, v_lote.caducidad) is not distinct from (v_codigo, p_caducidad) then return; end if;
  update public.lotes_med set lote = v_codigo, caducidad = p_caducidad where id = v_lote.id;
  insert into public.bitacora_med (tabla, registro_id, accion, cambios, usuario_email)
  values ('lotes_med', v_lote.id::text, 'UPDATE',
          jsonb_build_object('lote', jsonb_build_array(v_lote.lote, v_codigo), 'caducidad', jsonb_build_array(v_lote.caducidad, p_caducidad)),
          auth.jwt() ->> 'email');
end $function$;
revoke all on function public.med_editar_lote(uuid, text, date) from public, anon;
grant execute on function public.med_editar_lote(uuid, text, date) to authenticated;
