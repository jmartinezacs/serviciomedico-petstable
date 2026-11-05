-- v2.6: recordatorio 5 minutos antes de la cita.
-- Un trabajo de pg_cron revisa cada minuto (en SQL, sin llamar a nada) si hay
-- citas confirmadas que empiezan en 4-6 minutos (hora de Ciudad de México); solo
-- entonces invoca recordatorios_med con modo "inminente". avisos_med evita que el
-- mismo recordatorio se envíe dos veces.

alter table public.avisos_med drop constraint if exists avisos_med_evento_check;
alter table public.avisos_med add constraint avisos_med_evento_check
  check (evento in ('nueva_cita', 'confirmada', 'cancelada', 'reprogramada',
                    'recordatorio_dia', 'recordatorio_hora', 'recordatorio_5min'));

select cron.unschedule(jobid) from cron.job where jobname = 'med_recordatorio_5min';
select cron.schedule('med_recordatorio_5min', '* * * * *', $cron$
  select net.http_post(
    url := 'https://domumnsezocubigfqwry.supabase.co/functions/v1/recordatorios_med',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-med-cron', (select secreto from med_private.cron where id = 1)),
    body := '{"modo":"inminente"}'::jsonb,
    timeout_milliseconds := 20000)
  where exists (
    select 1 from public.citas_med c
    where c.estado = 'confirmada' and c.hora is not null
      and (c.fecha + c.hora) >= (now() at time zone 'America/Mexico_City') + interval '4 minutes'
      and (c.fecha + c.hora) <  (now() at time zone 'America/Mexico_City') + interval '6 minutes')
$cron$);
