-- v2.7: resumen mensual por correo.
-- El día 1 de cada mes a las 08:00 (Ciudad de México) pg_cron llama a la Edge
-- Function resumen_mensual_med, que envía el resumen del mes anterior a los
-- usuarios activos cuyo puesto esté en config_med.resumen_puestos.
-- Solo datos agregados: no incluye nombres de colaboradores ni notas clínicas.

alter table public.config_med add column if not exists resumen_puestos text[] not null default array[
  'Supervisor de seguridad, salud y ambiente',
  'Gerente de procesos y mejora continua',
  'Ingeniero de procesos y mejora continua'];

-- Registro de envíos (evita mandar dos veces el mismo mes). Sin políticas: solo
-- la Edge Function (service role) lo usa.
create table if not exists public.resumenes_med (
  periodo date primary key,
  enviado_at timestamptz not null default now(),
  enviados integer not null default 0
);
alter table public.resumenes_med enable row level security;
revoke all on public.resumenes_med from anon, authenticated;

-- Estadísticas del mes que contiene p_mes y del mes anterior (para comparar)
create or replace function public.med_resumen_mensual(p_mes date)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_desde date := date_trunc('month', p_mes)::date;
  v_hasta date := (date_trunc('month', p_mes) + interval '1 month - 1 day')::date;
  v_desde0 date := (date_trunc('month', p_mes) - interval '1 month')::date;
  v_hasta0 date := (date_trunc('month', p_mes) - interval '1 day')::date;
  v jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.med_es_admin() then
    raise exception 'Solo administradores.' using errcode = '42501';
  end if;

  with per(clave, d, h) as (values ('actual', v_desde, v_hasta), ('anterior', v_desde0, v_hasta0)),
  citas as (
    select per.clave,
           count(c.id) filter (where c.estado <> 'cancelada') as solicitadas,
           count(c.id) filter (where c.estado = 'atendida') as atendidas,
           count(c.id) filter (where c.estado = 'cancelada') as canceladas,
           count(c.id) filter (where c.estado = 'no_asistio') as no_asistio,
           count(c.id) filter (where c.tipo = 'urgente' and c.estado <> 'cancelada') as urgentes,
           count(distinct c.colaborador_id) filter (where c.estado = 'atendida') as colaboradores
    from per left join public.citas_med c on c.fecha between per.d and per.h
    group by per.clave
  ),
  ex as (
    select per.clave,
           count(e.id) filter (where e.tipo = 'ingreso' and e.estado = 'realizado') as ingreso,
           count(e.id) filter (where e.tipo = 'egreso' and e.estado = 'realizado') as egreso,
           count(e.id) filter (where e.tipo = 'ingreso' and e.estado = 'realizado' and e.resultado = 'no_apto') as no_aptos,
           count(e.id) filter (where e.tipo = 'ingreso' and e.estado = 'realizado' and e.resultado like 'apto_restricciones%') as con_restricciones
    from per left join public.examenes_med e on e.fecha between per.d and per.h
    group by per.clave
  ),
  disp as (
    select per.clave, coalesce(sum(-mv.cantidad), 0) as unidades
    from per left join public.movimientos_med mv on mv.tipo = 'dispensacion'
      and (mv.created_at at time zone 'America/Mexico_City')::date between per.d and per.h
    group by per.clave
  )
  select jsonb_build_object(
    'desde', v_desde, 'hasta', v_hasta,
    'citas', (select jsonb_object_agg(clave, to_jsonb(citas) - 'clave') from citas),
    'examenes', (select jsonb_object_agg(clave, to_jsonb(ex) - 'clave') from ex),
    'dispensadas', (select jsonb_object_agg(clave, unidades) from disp),
    'por_area', coalesce((
      select jsonb_agg(jsonb_build_object('nombre', area, 'n', n) order by n desc, area)
      from (select ar.nombre as area, count(*) n
            from public.citas_med c
            join public.colaboradores_med co on co.id = c.colaborador_id
            join public.areas_med ar on ar.id = co.area_id
            where c.estado = 'atendida' and c.fecha between v_desde and v_hasta
            group by ar.nombre order by n desc limit 6) s), '[]'::jsonb),
    'por_motivo', coalesce((
      select jsonb_agg(jsonb_build_object('motivo', motivo, 'n', n) order by n desc)
      from (select motivo, count(*) n from public.citas_med
            where estado = 'atendida' and fecha between v_desde and v_hasta
            group by motivo order by n desc limit 6) s), '[]'::jsonb),
    'padecimientos', coalesce((
      select jsonb_agg(jsonb_build_object('nombre', nombre, 'n', n) order by n desc, nombre)
      from (select coalesce(p.nombre, 'Sin clasificar') as nombre, count(*) n
            from public.citas_med c
            join public.atenciones_med a on a.cita_id = c.id
            left join public.padecimientos_med p on p.id = a.padecimiento_id
            where c.estado = 'atendida' and c.fecha between v_desde and v_hasta
            group by 1 order by n desc, 1 limit 6) s), '[]'::jsonb),
    'medicamentos', coalesce((
      select jsonb_agg(jsonb_build_object('nombre', nombre, 'n', n) order by n desc)
      from (select m.nombre, sum(-mv.cantidad) n
            from public.movimientos_med mv join public.medicamentos_med m on m.id = mv.medicamento_id
            where mv.tipo = 'dispensacion'
              and (mv.created_at at time zone 'America/Mexico_City')::date between v_desde and v_hasta
            group by m.nombre order by n desc limit 5) s), '[]'::jsonb),
    'inventario', jsonb_build_object(
      'bajo_minimo', (select count(*) from public.v_stock_med where activo and stock_minimo > 0 and estado_stock in ('bajo', 'agotado')),
      'agotados', (select count(*) from public.v_stock_med where activo and stock_minimo > 0 and estado_stock = 'agotado'),
      'por_caducar', (select count(*) from public.v_lotes_med where existencia > 0 and estado_caducidad = 'por_caducar'),
      'caducados', (select count(*) from public.v_lotes_med where existencia > 0 and estado_caducidad = 'caducado'))
  ) into v;
  return v;
end $$;

revoke all on function public.med_resumen_mensual(date) from public, anon;
grant execute on function public.med_resumen_mensual(date) to authenticated, service_role;

-- Día 1 de cada mes, 08:00 h de Ciudad de México (14:00 UTC; sin horario de verano)
select cron.unschedule(jobid) from cron.job where jobname = 'med_resumen_mensual';
select cron.schedule('med_resumen_mensual', '0 14 1 * *', $cron$
  select net.http_post(
    url := 'https://domumnsezocubigfqwry.supabase.co/functions/v1/resumen_mensual_med',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-med-cron', (select secreto from med_private.cron where id = 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000)
$cron$);
