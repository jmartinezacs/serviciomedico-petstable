-- =====================================================================
-- Servicio Médico v1.20
-- 1) Folios de exámenes por tipo: EX-IN-001 (ingreso) y EX-EG-001 (egreso),
--    cada uno con su propia secuencia. El folio es único por tipo.
-- 2) v_bitacora_med: la bitácora con el nombre y la foto de quien hizo la
--    acción y el nombre del registro afectado (colaborador, medicamento…),
--    para mostrar una descripción breve. security_invoker: solo la ven los
--    administradores (política de bitacora_med).
-- Datos: se eliminó el examen de prueba EX-00001 del médico (y sus avisos y
-- movimientos de bitácora) y se restauró el puesto previo de la colaboradora
-- que el examen había modificado.
-- =====================================================================

-- ---------- 1) Folios por tipo ----------
create sequence if not exists public.examenes_med_ingreso_seq;
create sequence if not exists public.examenes_med_egreso_seq;
select setval('public.examenes_med_ingreso_seq', coalesce((select max(folio) from public.examenes_med where tipo = 'ingreso'), 1),
              exists (select 1 from public.examenes_med where tipo = 'ingreso'));
select setval('public.examenes_med_egreso_seq', coalesce((select max(folio) from public.examenes_med where tipo = 'egreso'), 1),
              exists (select 1 from public.examenes_med where tipo = 'egreso'));

alter table public.examenes_med alter column folio drop default;
alter table public.examenes_med drop constraint if exists examenes_med_folio_uk;
alter table public.examenes_med add constraint examenes_med_folio_uk unique (tipo, folio);
drop sequence if exists public.examenes_med_folio_seq;

create or replace function public.med_folio_examen()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.folio := nextval(case when new.tipo = 'egreso' then 'public.examenes_med_egreso_seq' else 'public.examenes_med_ingreso_seq' end::regclass);
  return new;
end $$;
revoke all on function public.med_folio_examen() from public, anon, authenticated;

drop trigger if exists examenes_med_folio on public.examenes_med;
create trigger examenes_med_folio before insert on public.examenes_med
  for each row execute function public.med_folio_examen();

create or replace view public.v_examenes_med with (security_invoker = true) as
select e.id,
       e.folio,
       'EX-' || case when e.tipo = 'egreso' then 'EG' else 'IN' end || '-' || lpad(e.folio::text, 3, '0') as folio_txt,
       e.tipo, e.estado, e.fecha, e.hora, e.candidato, e.colaborador_id,
       col.nombre as colaborador,
       coalesce(e.candidato, col.nombre) as persona,
       e.area_id, ar.nombre as area, e.puesto, e.motivo, e.resultado, e.observaciones,
       e.solicitado_por, su.nombre as solicitante,
       e.atendido_por,
       case when au.es_medico then 'Dr. ' || au.nombre else au.nombre end as atendio,
       e.realizado_at, e.motivo_cancelacion, e.cancelado_por,
       cu.nombre as cancelado_por_nombre,
       e.created_at, e.updated_at
  from public.examenes_med e
  join public.areas_med ar on ar.id = e.area_id
  join public.usuarios_med su on su.id = e.solicitado_por
  left join public.colaboradores_med col on col.id = e.colaborador_id
  left join public.usuarios_med au on au.id = e.atendido_por
  left join public.usuarios_med cu on cu.id = e.cancelado_por;

-- ---------- 2) Bitácora descriptiva ----------
create or replace view public.v_bitacora_med with (security_invoker = true) as
select b.id, b.tabla, b.registro_id, b.accion, b.cambios, b.usuario_email, b.created_at,
       u.nombre as actor_nombre,
       u.foto_url as actor_foto,
       coalesce(u.es_medico, false) as actor_medico,
       case b.tabla
         when 'citas_med' then coalesce(
           (select co.nombre from public.citas_med c join public.colaboradores_med co on co.id = c.colaborador_id where c.id::text = b.registro_id),
           (select co.nombre from public.colaboradores_med co where co.id::text = b.cambios ->> 'colaborador_id'))
         when 'atenciones_med' then
           (select co.nombre from public.citas_med c join public.colaboradores_med co on co.id = c.colaborador_id where c.id::text = b.registro_id)
         when 'colaboradores_med' then coalesce(
           (select co.nombre from public.colaboradores_med co where co.id::text = b.registro_id), b.cambios ->> 'nombre')
         when 'medicamentos_med' then coalesce(
           (select m.nombre from public.medicamentos_med m where m.id::text = b.registro_id), b.cambios ->> 'nombre')
         when 'lotes_med' then coalesce(
           (select m.nombre from public.lotes_med l join public.medicamentos_med m on m.id = l.medicamento_id where l.id::text = b.registro_id),
           (select m.nombre from public.medicamentos_med m where m.id::text = b.cambios ->> 'medicamento_id'))
         when 'usuarios_med' then coalesce(
           (select x.nombre from public.usuarios_med x where x.id::text = b.registro_id), b.cambios ->> 'nombre')
         when 'areas_med' then coalesce(
           (select a.nombre from public.areas_med a where a.id::text = b.registro_id), b.cambios ->> 'nombre')
         when 'padecimientos_med' then coalesce(
           (select p.nombre from public.padecimientos_med p where p.id::text = b.registro_id), b.cambios ->> 'nombre')
         when 'examenes_med' then coalesce(
           (select coalesce(e.candidato, co.nombre) from public.examenes_med e left join public.colaboradores_med co on co.id = e.colaborador_id where e.id::text = b.registro_id),
           b.cambios ->> 'candidato',
           (select co.nombre from public.colaboradores_med co where co.id::text = b.cambios ->> 'colaborador_id'))
       end as objeto,
       case b.tabla
         when 'citas_med' then
           (select 'CM-' || lpad(c.folio::text, 5, '0') from public.citas_med c where c.id::text = b.registro_id)
         when 'examenes_med' then
           (select 'EX-' || case when e.tipo = 'egreso' then 'EG' else 'IN' end || '-' || lpad(e.folio::text, 3, '0') from public.examenes_med e where e.id::text = b.registro_id)
         when 'lotes_med' then coalesce(
           (select l.lote from public.lotes_med l where l.id::text = b.registro_id), b.cambios ->> 'lote')
       end as referencia,
       case when b.tabla = 'citas_med' then coalesce(
           (select c.tipo from public.citas_med c where c.id::text = b.registro_id), b.cambios ->> 'tipo')
         when b.tabla = 'examenes_med' then coalesce(
           (select e.tipo from public.examenes_med e where e.id::text = b.registro_id), b.cambios ->> 'tipo')
       end as subtipo
  from public.bitacora_med b
  left join public.usuarios_med u on lower(u.email) = lower(b.usuario_email);

revoke all on public.v_bitacora_med from anon;
grant select on public.v_bitacora_med to authenticated;
