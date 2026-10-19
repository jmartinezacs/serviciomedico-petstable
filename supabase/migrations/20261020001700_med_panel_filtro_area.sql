-- =====================================================================
-- Servicio Médico · Migración 17 (v1.13): filtro por área en el Panel.
-- med_dashboard y med_estadisticas_padecimientos aceptan p_area (opcional):
-- las cifras de citas y consumo se limitan a colaboradores de esa área.
-- =====================================================================
drop function if exists public.med_dashboard(date, date);
create function public.med_dashboard(p_desde date, p_hasta date, p_area uuid default null)
 returns jsonb
 language plpgsql
 stable
 set search_path to ''
as $function$
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
    select * from public.v_citas_med where fecha between p_desde and p_hasta and (p_area is null or area_id = p_area)
  ), ca as (
    select ci.* from public.citas_med ci join public.colaboradores_med co on co.id = ci.colaborador_id
     where p_area is null or co.area_id = p_area
  )
  select jsonb_build_object(
    'hoy', v_hoy,
    'dias_alerta', v_dias,
    'citas_hoy', (select count(*) from ca where fecha = v_hoy and estado in ('pendiente','confirmada','atendida')),
    'pendientes', (select count(*) from ca where estado = 'pendiente' and fecha >= v_hoy),
    'confirmadas_proximas', (select count(*) from ca where estado = 'confirmada' and fecha >= v_hoy),
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
      'medicamentos_activos', (select count(*) from public.medicamentos_med where activo and categoria = 'medicamento'),
      'top_dispensados', coalesce((
        select jsonb_agg(jsonb_build_object('medicamento', medicamento, 'n', n) order by n desc)
        from (select m.nombre as medicamento, sum(-mv.cantidad) n
              from public.movimientos_med mv
              join public.medicamentos_med m on m.id = mv.medicamento_id
              join public.citas_med ci on ci.id = mv.cita_id
              join public.colaboradores_med co on co.id = ci.colaborador_id
              where mv.tipo = 'dispensacion'
                and (p_area is null or co.area_id = p_area)
                and (mv.created_at at time zone 'America/Mexico_City')::date between p_desde and p_hasta
              group by m.nombre order by n desc limit 8) s), '[]'::jsonb)
    );
  end if;
  return v_res;
end $function$;
revoke all on function public.med_dashboard(date, date, uuid) from public, anon;
grant execute on function public.med_dashboard(date, date, uuid) to authenticated;

drop function if exists public.med_estadisticas_padecimientos(date, date);
create function public.med_estadisticas_padecimientos(p_desde date, p_hasta date, p_area uuid default null)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
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
      and (p_area is null or col.area_id = p_area)
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
end $function$;
revoke all on function public.med_estadisticas_padecimientos(date, date, uuid) from public, anon;
grant execute on function public.med_estadisticas_padecimientos(date, date, uuid) to authenticated;
