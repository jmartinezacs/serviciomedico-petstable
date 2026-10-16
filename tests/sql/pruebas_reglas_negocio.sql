-- =====================================================================
-- Pruebas de reglas de negocio, RLS y permisos (Servicio Médico).
-- Se ejecuta en el SQL Editor de Supabase. TODO se revierte al final:
-- el bloque termina con RAISE EXCEPTION que muestra los resultados y
-- deshace cualquier dato de prueba. No deja registros en la base.
-- Simula sesiones con request.jwt.claims (usuario, admin, externo, anon).
-- =====================================================================
do $t$
declare
  r text := '';
  v_area uuid; v_col uuid; v_cita uuid; v_cita2 uuid; v_cita_hoy uuid; v_med uuid; v_lote uuid; n int; j jsonb;
  d_fut date := public.med_hoy() + ((8 - extract(isodow from public.med_hoy())::int) % 7 + 8);
  d_sab date;
  v_hoy date := public.med_hoy();
begin
  d_sab := d_fut + (6 - extract(isodow from d_fut)::int);
  perform set_config('role', 'authenticated', true);

  -- USUARIO
  perform set_config('request.jwt.claims', '{"email":"abigail.ordaz@petstable.mx","role":"authenticated"}', true);
  r := r || E'\n[U] miembro=' || public.med_es_miembro() || ' admin=' || public.med_es_admin();
  select id into v_area from public.areas_med where nombre = 'Calidad';
  insert into public.colaboradores_med (nombre, area_id, num_empleado) values ('  Prueba   Colaborador ', v_area, 'T-0001') returning id into v_col;
  insert into public.citas_med (colaborador_id, fecha, hora, motivo, estado, solicitado_por)
  values (v_col, d_fut, '10:00', 'malestar', 'confirmada', gen_random_uuid()) returning id into v_cita;
  r := r || E'\n[U] cita creada estado=' || (select estado from public.citas_med where id = v_cita) || ' (esperado: pendiente)';
  begin insert into public.citas_med (colaborador_id, fecha, hora, motivo) values (v_col, d_sab, '10:00', 'malestar'); r := r || E'\n[U] FALLA sábado';
  exception when others then r := r || E'\n[U] OK sábado rechazado'; end;
  begin insert into public.citas_med (colaborador_id, fecha, hora, motivo) values (v_col, d_fut, '17:30', 'malestar'); r := r || E'\n[U] FALLA 17:30';
  exception when others then r := r || E'\n[U] OK 17:30 rechazado'; end;
  begin insert into public.citas_med (colaborador_id, fecha, hora, motivo) values (v_col, d_fut, '09:15', 'malestar'); r := r || E'\n[U] FALLA 09:15';
  exception when others then r := r || E'\n[U] OK 09:15 rechazado'; end;
  begin insert into public.citas_med (colaborador_id, fecha, hora, motivo) values (v_col, d_fut, '10:00', 'otro'); r := r || E'\n[U] FALLA traslape';
  exception when unique_violation then r := r || E'\n[U] OK traslape rechazado'; end;
  begin insert into public.citas_med (colaborador_id, fecha, hora, motivo) values (v_col, v_hoy - 7, '10:00', 'otro'); r := r || E'\n[U] FALLA fecha pasada';
  exception when others then r := r || E'\n[U] OK fecha pasada rechazada'; end;
  begin update public.citas_med set estado = 'confirmada' where id = v_cita; r := r || E'\n[U] FALLA usuario confirmó';
  exception when others then r := r || E'\n[U] OK usuario no puede confirmar'; end;
  select count(*) into n from public.medicamentos_med; r := r || E'\n[U] medicamentos visibles=' || n || ' (esperado 0)';
  begin perform public.med_registrar_entrada(gen_random_uuid(), 'X', v_hoy + 100, 5, null); r := r || E'\n[U] FALLA entrada permitida';
  exception when others then r := r || E'\n[U] OK entrada rechazada'; end;

  -- ADMIN
  perform set_config('request.jwt.claims', '{"email":"javier.martinez@petstable.mx","role":"authenticated"}', true);
  update public.citas_med set estado = 'confirmada' where id = v_cita;
  insert into public.medicamentos_med (clave, nombre, unidad, stock_minimo) values ('TEST-001', 'Medicamento de prueba', 'tableta', 20) returning id into v_med;
  v_lote := public.med_registrar_entrada(v_med, 'l-test', v_hoy + 30, 10, 'Prueba');
  perform public.med_registrar_entrada(v_med, 'L-TEST', v_hoy + 30, 5, null);
  r := r || E'\n[A] existencia tras 2 entradas=' || (select existencia from public.lotes_med where id = v_lote) || ' (esperado 15)';
  begin perform public.med_registrar_entrada(v_med, 'L-TEST', v_hoy + 90, 1, null); r := r || E'\n[A] FALLA caducidad distinta';
  exception when others then r := r || E'\n[A] OK caducidad distinta rechazada'; end;

  -- USUARIO cancela / no puede reprogramar confirmada
  perform set_config('request.jwt.claims', '{"email":"abigail.ordaz@petstable.mx","role":"authenticated"}', true);
  begin update public.citas_med set hora = '11:00' where id = v_cita; r := r || E'\n[U] FALLA reprogramó confirmada';
  exception when others then r := r || E'\n[U] OK no reprograma confirmada'; end;
  insert into public.citas_med (colaborador_id, fecha, hora, motivo) values (v_col, d_fut, '11:00', 'seguimiento') returning id into v_cita2;
  begin update public.citas_med set estado = 'cancelada' where id = v_cita2; r := r || E'\n[U] FALLA cancelación sin motivo';
  exception when others then r := r || E'\n[U] OK cancelación exige motivo'; end;
  update public.citas_med set estado = 'cancelada', motivo_cancelacion = 'Prueba' where id = v_cita2;
  insert into public.citas_med (colaborador_id, fecha, hora, motivo) values (v_col, d_fut, '11:00', 'seguimiento');
  r := r || E'\n[U] OK bloque liberado tras cancelar';

  -- ADMIN atiende (solo si hoy es día hábil)
  perform set_config('request.jwt.claims', '{"email":"javier.martinez@petstable.mx","role":"authenticated"}', true);
  begin perform public.med_atender_cita(v_cita, 'x', 'y', '[]'); r := r || E'\n[A] FALLA atendió futura';
  exception when others then r := r || E'\n[A] OK no atiende cita futura'; end;
  if extract(isodow from v_hoy) between 1 and 5 then
    insert into public.citas_med (colaborador_id, fecha, hora, motivo) values (v_col, v_hoy, '09:00', 'malestar') returning id into v_cita_hoy;
    begin perform public.med_atender_cita(v_cita_hoy, 'x', 'y', jsonb_build_array(jsonb_build_object('lote_id', v_lote, 'cantidad', 100)));
      r := r || E'\n[A] FALLA dispensó sin existencia';
    exception when others then r := r || E'\n[A] OK sin existencia rechazado (atómico: estado=' || (select estado from public.citas_med where id = v_cita_hoy) || ')'; end;
    perform public.med_atender_cita(v_cita_hoy, 'Cefalea', 'Hidratación', jsonb_build_array(jsonb_build_object('lote_id', v_lote, 'cantidad', 3)));
    r := r || E'\n[A] atendida; existencia=' || (select existencia from public.lotes_med where id = v_lote) || ' (esperado 12)';
  end if;
  begin update public.citas_med set estado = 'atendida' where id = v_cita; r := r || E'\n[A] FALLA atendida directa';
  exception when others then r := r || E'\n[A] OK atendida solo vía RPC'; end;
  perform public.med_registrar_salida(v_lote, 2, 'Merma');
  perform public.med_ajustar_lote(v_lote, 5, 'Conteo físico');
  r := r || E'\n[A] tras salida+ajuste existencia=' || (select existencia from public.lotes_med where id = v_lote) || ' (esperado 5)';
  begin delete from public.medicamentos_med where id = v_med; r := r || E'\n[A] FALLA borró con lotes';
  exception when foreign_key_violation then r := r || E'\n[A] OK no borra medicamento con lotes'; end;
  begin update public.usuarios_med set activo = false where email = 'javier.martinez@petstable.mx'; r := r || E'\n[A] FALLA auto-desactivación';
  exception when others then r := r || E'\n[A] OK no se auto-desactiva'; end;
  select count(*) into n from public.bitacora_med where tabla = 'atenciones_med' and cambios is not null;
  r := r || E'\n[A] bitácora con contenido clínico=' || n || ' (esperado 0)';

  -- USUARIO: visibilidad
  perform set_config('request.jwt.claims', '{"email":"abigail.ordaz@petstable.mx","role":"authenticated"}', true);
  select count(*) into n from public.atenciones_med; r := r || E'\n[U] atenciones visibles=' || n || ' (esperado 0)';

  -- EXTERNO (cuenta Auth sin acceso)
  perform set_config('request.jwt.claims', '{"email":"otro@petstable.mx","role":"authenticated"}', true);
  select count(*) into n from public.citas_med; r := r || E'\n[X] citas visibles=' || n || ' (esperado 0)';
  begin insert into public.citas_med (colaborador_id, fecha, hora, motivo) values (v_col, d_fut, '12:00', 'otro'); r := r || E'\n[X] FALLA externo creó cita';
  exception when others then r := r || E'\n[X] OK externo rechazado'; end;

  -- ANON
  perform set_config('role', 'anon', true);
  begin select count(*) into n from public.citas_med; r := r || E'\n[anon] FALLA lectura';
  exception when others then r := r || E'\n[anon] OK lectura rechazada'; end;

  raise exception 'RESULTADOS (todo revertido):%', r;
end $t$;

-- =====================================================================
-- v1.6: días sin servicio, reapertura de inasistencias, constancia,
-- reabasto, aviso de privacidad e inasistencia automática.
-- Ejecutar como bloque independiente en un día hábil (también se revierte por completo).
-- =====================================================================
do $t$
declare
  r text := '';
  v_area uuid; v_col uuid; v_c1 uuid; v_c2 uuid; n int; v_txt text;
  v_hoy date := public.med_hoy();
  d_fut date := public.med_hoy() + ((8 - extract(isodow from public.med_hoy())::int) % 7 + 8);
  d_fest date := (select min(fecha) from public.dias_sin_servicio_med where tipo = 'festivo' and hora_inicio is null and fecha > public.med_hoy());
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"email":"javier.martinez@petstable.mx","role":"authenticated"}', true);
  insert into public.dias_sin_servicio_med (fecha, hora_inicio, hora_fin, tipo, motivo) values (d_fut, '10:00', '11:00', 'ausencia', 'Junta médica');
  select id into v_area from public.areas_med limit 1;
  insert into public.colaboradores_med (nombre, area_id) values ('Prueba V16', v_area) returning id into v_col;

  perform set_config('request.jwt.claims', '{"email":"abigail.ordaz@petstable.mx","role":"authenticated"}', true);
  begin insert into public.citas_med (colaborador_id, fecha, hora, motivo) values (v_col, d_fut, '10:20', 'malestar'); r := r || E'\n[U] FALLA cita en bloqueo';
  exception when others then r := r || E'\n[U] OK horario bloqueado rechazado'; end;
  insert into public.citas_med (colaborador_id, fecha, hora, motivo) values (v_col, d_fut, '11:00', 'malestar') returning id into v_c1;
  r := r || E'\n[U] OK 11:00 permitido';
  if d_fest is not null then
    begin insert into public.citas_med (colaborador_id, fecha, hora, motivo) values (v_col, d_fest, '10:00', 'malestar'); r := r || E'\n[U] FALLA festivo';
    exception when others then r := r || E'\n[U] OK festivo rechazado'; end;
    insert into public.citas_med (colaborador_id, fecha, motivo, descripcion, tipo) values (v_col, d_fest, 'malestar', 'dolor fuerte', 'urgente');
    r := r || E'\n[U] OK urgencia en festivo permitida';
  end if;
  begin insert into public.dias_sin_servicio_med (fecha, motivo) values (d_fut + 1, 'x'); r := r || E'\n[U] FALLA usuario creó bloqueo';
  exception when others then r := r || E'\n[U] OK usuario no crea bloqueos'; end;
  begin perform * from public.med_reabasto(90); r := r || E'\n[U] FALLA reabasto visible';
  exception when others then r := r || E'\n[U] OK reabasto solo admin'; end;

  perform set_config('request.jwt.claims', '{"email":"javier.martinez@petstable.mx","role":"authenticated"}', true);
  begin update public.citas_med set hora = '10:40' where id = v_c1; r := r || E'\n[A] FALLA reprogramó a bloqueo';
  exception when others then r := r || E'\n[A] OK reprogramar a bloqueo rechazado'; end;
  insert into public.citas_med (colaborador_id, fecha, hora, motivo) values (v_col, v_hoy, '09:00', 'malestar') returning id into v_c2;
  update public.citas_med set estado = 'confirmada' where id = v_c2;
  update public.citas_med set estado = 'no_asistio' where id = v_c2;
  update public.citas_med set estado = 'confirmada' where id = v_c2;
  r := r || E'\n[A] reapertura estado=' || (select estado from public.citas_med where id = v_c2) || ' (esperado confirmada)';
  perform public.med_atender_cita(v_c2, null, null, '[]'::jsonb, (select id from public.padecimientos_med limit 1));
  perform set_config('request.jwt.claims', '{"email":"abigail.ordaz@petstable.mx","role":"authenticated"}', true);
  select count(*) into n from public.med_constancia(v_c2); r := r || E'\n[U] constancia de cita ajena=' || n || ' (esperado 0)';
  perform set_config('request.jwt.claims', '{"email":"javier.martinez@petstable.mx","role":"authenticated"}', true);
  select folio_txt into v_txt from public.med_constancia(v_c2); r := r || E'\n[A] constancia=' || coalesce(v_txt, 'NULL');
  begin update public.config_med set aviso_privacidad_url = 'http://inseguro.com' where id = 1; r := r || E'\n[A] FALLA url http aceptada';
  exception when others then r := r || E'\n[A] OK url sin https rechazada'; end;

  insert into public.citas_med (colaborador_id, fecha, hora, motivo) values (v_col, v_hoy, '09:20', 'malestar') returning id into v_c2;
  update public.citas_med set estado = 'confirmada' where id = v_c2;
  perform set_config('role', 'postgres', true);
  perform public.med_marcar_inasistencias();
  r := r || E'\n[cron] estado=' || (select estado from public.citas_med where id = v_c2) || ' (esperado no_asistio)';
  raise exception 'RESULTADOS v1.6:%', r;
end $t$;
