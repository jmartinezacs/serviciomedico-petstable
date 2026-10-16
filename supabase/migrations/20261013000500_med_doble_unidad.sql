-- =====================================================================
-- Servicio Médico · Migración 5: inventario en doble unidad.
-- La existencia se controla en la UNIDAD MÍNIMA (tableta, cápsula, ml…)
-- y se expresa también en EMPAQUES (caja, frasco, bote…) mediante
-- "contenido_empaque" (unidades mínimas por empaque).
-- =====================================================================
alter table public.medicamentos_med
  add column if not exists empaque text not null default 'caja'
    check (char_length(btrim(empaque)) between 1 and 30),
  add column if not exists contenido_empaque integer not null default 1
    check (contenido_empaque between 1 and 100000);

comment on column public.medicamentos_med.unidad is 'Unidad mínima de control (tableta, cápsula, ml…). Las existencias se guardan en esta unidad.';
comment on column public.medicamentos_med.empaque is 'Presentación de compra (caja, frasco, bote…).';
comment on column public.medicamentos_med.contenido_empaque is 'Unidades mínimas por empaque (ej. 20 tabletas por caja).';

create or replace function public.med_normalizar_medicamento()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.clave := upper(btrim(new.clave));
  new.nombre := btrim(regexp_replace(new.nombre, '\s+', ' ', 'g'));
  new.presentacion := nullif(btrim(new.presentacion), '');
  new.unidad := lower(btrim(new.unidad));
  new.empaque := lower(btrim(new.empaque));
  return new;
end $$;
revoke all on function public.med_normalizar_medicamento() from public, anon, authenticated;

-- Vistas: se agregan columnas al final (compatible con create or replace)
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
       end as estado_stock,
       m.empaque, m.contenido_empaque
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
       l.created_at, l.updated_at,
       m.empaque, m.contenido_empaque
from public.lotes_med l
join public.medicamentos_med m on m.id = l.medicamento_id;

create or replace view public.v_movimientos_med with (security_invoker = true) as
select mv.id, mv.tipo, mv.cantidad, mv.existencia_resultante, mv.motivo, mv.created_at,
       mv.medicamento_id, m.clave, m.nombre as medicamento, m.unidad,
       mv.lote_id, l.lote, l.caducidad,
       mv.cita_id, case when c.folio is null then null else 'CM-' || lpad(c.folio::text, 5, '0') end as cita_folio,
       mv.usuario_id, u.nombre as usuario,
       m.empaque, m.contenido_empaque
from public.movimientos_med mv
join public.medicamentos_med m on m.id = mv.medicamento_id
join public.lotes_med l on l.id = mv.lote_id
join public.usuarios_med u on u.id = mv.usuario_id
left join public.citas_med c on c.id = mv.cita_id;
