-- =====================================================================
-- Servicio Médico · Migración 11: carga inicial del inventario de
-- FÁRMACOS (archivo "Inventario médico y colaboradores" del médico).
-- Criterios:
--  * Caducidad con solo mes y año → último día de ese mes.
--  * Sin número de lote en el archivo → lote "S/N-AAAA-MM-DD" (por caducidad);
--    renglones del mismo medicamento y caducidad se suman en un lote.
--  * Contenedores que no se cuentan por pieza (tubo, bote, frasco gotero,
--    aerosol) se registran como "pieza" con el empaque correspondiente.
--  * Contenido por empaque = 1 (el archivo no indica el contenido de una caja
--    completa) y stock mínimo = 0 (sin alerta) hasta que el médico los defina.
--  * Lotes ya caducados se registran tal cual (aparecen como Caducado para
--    darlos de baja); los vigentes entran con med_registrar_entrada.
--  * Los movimientos quedan a nombre de servicio.medico@petstable.mx.
-- =====================================================================
do $$
declare
  r record; v_med uuid; v_lote uuid; v_uid uuid; n int := 0;
  v_motivo text := 'Carga inicial de inventario (archivo del médico)';
begin
  select id into v_uid from public.usuarios_med where email = 'servicio.medico@petstable.mx';
  perform set_config('request.jwt.claims', '{"email":"servicio.medico@petstable.mx","role":"authenticated"}', true);

  for r in select * from (values
    ('Omeprazol 20mg', 'pieza', 'bote', 1, date '2027-02-15'),
    ('Pantoprazol 40mg', 'tableta', 'caja', 13, date '2026-11-30'),
    ('Diclofenaco 100mg', 'tableta', 'caja', 7, date '2028-04-30'),
    ('Diclofenaco gel 1.16/100g', 'pieza', 'tubo', 2, date '2026-11-30'),
    ('Diclofenaco gel 2.32%', 'pieza', 'tubo', 1, date '2027-08-31'),
    ('Metamizol sódico 1g/2ml Sol. inyectable', 'ampolleta', 'caja', 2, date '2029-08-31'),
    ('Metamizol sódico 500mg', 'tableta', 'caja', 9, date '2028-09-30'),
    ('Ketorolaco 30mg sublingual', 'tableta', 'caja', 2, date '2027-09-30'),
    ('Ketorolaco 30mg/ml', 'ampolleta', 'caja', 2, date '2027-11-30'),
    ('Ácido acetilsalicílico 500mg', 'tableta', 'caja', 40, date '2027-11-30'),
    ('Aspirina 500mg', 'tableta', 'caja', 72, date '2028-09-30'),
    ('Paracetamol 500mg', 'tableta', 'frasco', 8, date '2027-11-30'),
    ('Metacarbol/ibuprofeno 500/200mg', 'tableta', 'caja', 7, date '2027-09-30'),
    ('Metacarbamol/ibuprofeno 375/200mg', 'cápsula', 'caja', 22, date '2028-05-31'),
    ('Graneodín pastilla 10mg', 'pieza', 'caja', 13, date '2027-07-31'),
    ('Agrifen', 'tableta', 'caja', 6, date '2027-01-31'),
    ('Antiflu-Des', 'cápsula', 'caja', 5, date '2027-09-30'),
    ('Antiflu-Des', 'cápsula', 'caja', 20, date '2027-11-30'),
    ('Desenfriol D tab', 'tableta', 'caja', 20, date '2027-11-30'),
    ('Sensibit D', 'tableta', 'caja', 6, date '2028-10-31'),
    ('Butilhioscina 20mg/1ml Sol. Inyectabe', 'ampolleta', 'caja', 2, date '2027-05-31'),
    ('Butilhioscina 10mg tab', 'tableta', 'caja', 7, date '2027-01-31'),
    ('Butilhioscina/Metamizol 10/250mg', 'tableta', 'caja', 15, date '2027-10-31'),
    ('Loratadina 10mg', 'tableta', 'caja', 18, date '2027-08-31'),
    ('Isopentilo 4mg tab', 'tableta', 'caja', 19, date '2026-12-31'),
    ('Cetirizina 10mg', 'tableta', 'caja', 8, date '2028-02-29'),
    ('Dimenhidrato 50mg (nauseas, mareo, vómito)', 'cápsula', 'caja', 10, date '2027-01-31'),
    ('Hidrocortisona 0.1% crema', 'pieza', 'tubo', 1, date '2028-02-29'),
    ('Benzonatato 100mg capsulas', 'cápsula', 'caja', 20, date '2027-12-31'),
    ('Ambroxol 30mg tabletas', 'tableta', 'caja', 19, date '2028-01-31'),
    ('Ambroxol 30mg tabletas', 'tableta', 'caja', 19, date '2027-10-31'),
    ('Salbutamol Aerosol 100picogr', 'pieza', 'pieza', 1, date '2027-05-31'),
    ('Treda', 'tableta', 'caja', 16, date '2026-09-30'),
    ('Loperamida 2mg', 'tableta', 'caja', 4, date '2027-12-31'),
    ('Loperamida 2mg', 'tableta', 'caja', 2, date '2026-11-30'),
    ('Electrolitos sobre oral', 'sobre', 'caja', 4, date '2031-05-31'),
    ('Captopril 25mg', 'pieza', 'bote', 1, date '2027-10-31'),
    ('Dinitrato de isosorbide sublingual 5mg', 'tableta', 'caja', 40, date '2028-02-29'),
    ('Amlodipino 5mg', 'tableta', 'caja', 29, date '2027-10-31'),
    ('Norfenefrina 10mg/ml', 'pieza', 'frasco', 1, date '2028-03-31'),
    ('Hidrocortisona/cloranfenicol/benzocaina otica', 'pieza', 'frasco', 1, date '2027-09-30'),
    ('Hidrocortisona/cloranfenicol/benzocaina otica', 'pieza', 'frasco', 1, date '2027-06-30'),
    ('Fenazopiridina 100mg', 'tableta', 'frasco', 10, date '2027-08-31'),
    ('Fenazopiridina 100mg', 'tableta', 'frasco', 10, date '2027-08-31'),
    ('Oximetazolina nasal 0.005%', 'pieza', 'frasco', 1, date '2027-10-31'),
    ('Dexametasona/neomicina 1mg/3.5mg/1ml', 'pieza', 'frasco', 1, date '2028-02-29'),
    ('Solutina F (Feniramina/nafazolina 3mg/0.25mg)', 'pieza', 'frasco', 1, date '2027-07-31'),
    ('Tribedoce Compuesto Solución inyectable', 'ampolleta', 'caja', 3, date '2028-03-26'),
    ('Tribedoce solo sol. inyectable', 'ampolleta', 'caja', 3, date '2027-10-23')
  ) v(nombre, unidad, empaque, cantidad, caducidad) loop
    select id into v_med from public.medicamentos_med where lower(nombre) = lower(r.nombre);
    if v_med is null then
      n := n + 1;
      insert into public.medicamentos_med (clave, nombre, unidad, empaque, contenido_empaque, stock_minimo)
      values ('MED-' || lpad(((select count(*) from public.medicamentos_med) + 1)::text, 3, '0'), r.nombre, r.unidad, r.empaque, 1, 0)
      returning id into v_med;
    end if;
    if r.caducidad > public.med_hoy() then
      perform public.med_registrar_entrada(v_med, 'S/N-' || to_char(r.caducidad, 'YYYY-MM-DD'), r.caducidad, r.cantidad, v_motivo);
    else
      insert into public.lotes_med (medicamento_id, lote, caducidad, existencia)
      values (v_med, 'S/N-' || to_char(r.caducidad, 'YYYY-MM-DD'), r.caducidad, r.cantidad) returning id into v_lote;
      insert into public.movimientos_med (tipo, medicamento_id, lote_id, cantidad, existencia_resultante, motivo, usuario_id)
      values ('entrada', v_med, v_lote, r.cantidad, r.cantidad, v_motivo || ' · lote ya caducado', v_uid);
    end if;
  end loop;
end $$;
