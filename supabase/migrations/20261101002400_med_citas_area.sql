-- =====================================================================
-- Servicio Médico v2.2 · Citas visibles para el área de quien las solicita
-- Cada usuario ve (solo lectura) las citas solicitadas por usuarios de su
-- misma área, para que, p. ej., los supervisores de otro turno se enteren de
-- la confirmación. Modificar o cancelar sigue siendo solo de quien solicitó
-- (y del médico). El contenido clínico (atenciones_med) sigue siendo solo del
-- médico. notificar_med avisa también a los usuarios del área.
-- Datos (con autorización del usuario):
--  - Cita CM-00025 trasladada de "Heydi Castro" (Limpieza, duplicada) a
--    "Heidy Castro" (Procesos y Mejora continua), con su edad (42); se
--    eliminó la colaboradora duplicada.
--  - Se eliminaron las citas CM-00019 y CM-00024, que el médico registró para
--    sí mismo por error (sin medicamentos entregados), con su atención,
--    avisos y bitácora. CM-00021 se conserva porque tiene medicamentos
--    entregados (pendiente de aclarar con el médico).
-- =====================================================================
create or replace function public.med_misma_area(p_usuario uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.usuarios_med yo
      join public.usuarios_med otro on otro.area_id = yo.area_id
     where lower(yo.email) = lower(coalesce(auth.jwt() ->> 'email', '')) and yo.activo
       and yo.area_id is not null and otro.id = p_usuario)
$$;
revoke all on function public.med_misma_area(uuid) from public, anon;
grant execute on function public.med_misma_area(uuid) to authenticated;

drop policy if exists citas_med_sel on public.citas_med;
create policy citas_med_sel on public.citas_med for select to authenticated
  using ((select public.med_es_admin())
         or solicitado_por = (select public.med_usuario_actual_id())
         or public.med_misma_area(solicitado_por));
