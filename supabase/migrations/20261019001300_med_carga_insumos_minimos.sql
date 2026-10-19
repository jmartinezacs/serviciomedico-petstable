-- =====================================================================
-- Servicio Médico · Migración 13 (v1.8): datos
--  1) Medicamentos que no se cuentan por pieza pasan a control por envase.
--  2) Carga de insumos médicos y equipo (segunda columna del archivo).
--  3) Stock mínimo propuesto para medicamentos e insumos (equipo: sin alerta).
--  4) Puesto "Auxiliar" para colaboradores sin cuenta y sin puesto.
--  5) KPI "Medicamentos activos" del panel: solo categoría medicamento.
-- =====================================================================

-- ---------- 1. Medicamentos por envase ----------
update public.medicamentos_med
   set control = 'envase',
       empaque = case when nombre = 'Salbutamol Aerosol 100picogr' then 'aerosol' else empaque end,
       unidad  = case when nombre = 'Salbutamol Aerosol 100picogr' then 'aerosol' else empaque end
 where nombre in ('Omeprazol 20mg', 'Diclofenaco gel 1.16/100g', 'Diclofenaco gel 2.32%', 'Hidrocortisona 0.1% crema',
                  'Salbutamol Aerosol 100picogr', 'Captopril 25mg', 'Norfenefrina 10mg/ml',
                  'Hidrocortisona/cloranfenicol/benzocaina otica', 'Oximetazolina nasal 0.005%',
                  'Dexametasona/neomicina 1mg/3.5mg/1ml', 'Solutina F (Feniramina/nafazolina 3mg/0.25mg)');
-- Uno de los dos tubos de Diclofenaco gel 1.16 está a la mitad
update public.lotes_med set nivel = 50
 where medicamento_id = (select id from public.medicamentos_med where nombre = 'Diclofenaco gel 1.16/100g') and existencia > 0;

-- ---------- 3. Stock mínimo de medicamentos ----------
update public.medicamentos_med m set stock_minimo = v.minimo
  from (values
    ('Omeprazol 20mg', 1), ('Pantoprazol 40mg', 10), ('Diclofenaco 100mg', 10), ('Diclofenaco gel 1.16/100g', 1),
    ('Diclofenaco gel 2.32%', 1), ('Metamizol sódico 1g/2ml Sol. inyectable', 2), ('Metamizol sódico 500mg', 10),
    ('Ketorolaco 30mg sublingual', 4), ('Ketorolaco 30mg/ml', 2), ('Ácido acetilsalicílico 500mg', 20), ('Aspirina 500mg', 20),
    ('Paracetamol 500mg', 20), ('Metacarbol/ibuprofeno 500/200mg', 10), ('Metacarbamol/ibuprofeno 375/200mg', 10),
    ('Graneodín pastilla 10mg', 6), ('Agrifen', 6), ('Antiflu-Des', 10), ('Desenfriol D tab', 10), ('Sensibit D', 6),
    ('Butilhioscina 20mg/1ml Sol. Inyectabe', 2), ('Butilhioscina 10mg tab', 10), ('Butilhioscina/Metamizol 10/250mg', 10),
    ('Loratadina 10mg', 10), ('Isopentilo 4mg tab', 6), ('Cetirizina 10mg', 10), ('Dimenhidrato 50mg (nauseas, mareo, vómito)', 6),
    ('Hidrocortisona 0.1% crema', 1), ('Benzonatato 100mg capsulas', 10), ('Ambroxol 30mg tabletas', 10),
    ('Salbutamol Aerosol 100picogr', 1), ('Treda', 6), ('Loperamida 2mg', 6), ('Electrolitos sobre oral', 6),
    ('Captopril 25mg', 1), ('Dinitrato de isosorbide sublingual 5mg', 10), ('Amlodipino 5mg', 10), ('Norfenefrina 10mg/ml', 1),
    ('Hidrocortisona/cloranfenicol/benzocaina otica', 1), ('Fenazopiridina 100mg', 6), ('Oximetazolina nasal 0.005%', 1),
    ('Dexametasona/neomicina 1mg/3.5mg/1ml', 1), ('Solutina F (Feniramina/nafazolina 3mg/0.25mg)', 1),
    ('Tribedoce Compuesto Solución inyectable', 2), ('Tribedoce solo sol. inyectable', 2)
  ) v(nombre, minimo)
 where m.nombre = v.nombre;

-- ---------- 2. Insumos médicos y equipo ----------
do $$
declare
  r record; v_med uuid; v_lote uuid; n_ins int; n_eq int;
  v_motivo text := 'Carga inicial de inventario (archivo del médico)';
begin
  perform set_config('request.jwt.claims', '{"email":"servicio.medico@petstable.mx","role":"authenticated"}', true);
  for r in select * from (values
    -- nombre, categoría, control, unidad, empaque, contenido, cantidad, caducidad, nivel abierto, stock mínimo
    ('Microdacyn', 'insumo', 'envase', 'frasco', 'frasco', 1, 1, date '2027-11-30', null::int, 1),
    ('Guantes', 'insumo', 'envase', 'caja', 'caja', 1, 1, null, null, 1),
    ('Algodon', 'insumo', 'envase', 'bolsa', 'bolsa', 1, 1, null, null, 1),
    ('Abatalenguas', 'insumo', 'pieza', 'pieza', 'paquete', 25, 450, null, null, 50),
    ('Gasas #10', 'insumo', 'pieza', 'pieza', 'pieza', 1, 46, null, null, 20),
    ('Vendas #5', 'insumo', 'pieza', 'pieza', 'pieza', 1, 26, null, null, 5),
    ('Venda #10', 'insumo', 'pieza', 'pieza', 'pieza', 1, 12, null, null, 4),
    ('Normogoteros', 'insumo', 'pieza', 'pieza', 'pieza', 1, 3, null, null, 2),
    ('Punzocat 21G', 'insumo', 'pieza', 'pieza', 'pieza', 1, 5, null, null, 2),
    ('Punzocat 18G', 'insumo', 'pieza', 'pieza', 'pieza', 1, 4, null, null, 2),
    ('Punzocat 17G', 'insumo', 'pieza', 'pieza', 'pieza', 1, 5, null, null, 2),
    ('Solución Hartmann 500ml', 'insumo', 'pieza', 'frasco', 'frasco', 1, 1, date '2027-06-30', null, 2),
    ('Solución Hartmann 500ml', 'insumo', 'pieza', 'frasco', 'frasco', 1, 1, date '2027-11-30', null, 2),
    ('Solución NaCl 0.9% 500ml', 'insumo', 'pieza', 'frasco', 'frasco', 1, 1, date '2028-01-31', null, 2),
    ('Micropore', 'insumo', 'envase', 'rollo', 'rollo', 1, 1, null, 50, 1),
    ('Tela adhesiva', 'insumo', 'envase', 'rollo', 'rollo', 1, 1, null, 25, 1),
    ('Psicaína 2%', 'insumo', 'envase', 'frasco', 'frasco', 1, 1, date '2029-09-30', null, 1),
    ('Lava ojos', 'insumo', 'envase', 'frasco', 'frasco', 1, 1, null, null, 1),
    ('Jabón quirúrgico', 'insumo', 'envase', 'frasco', 'frasco', 1, 1, null, null, 1),
    ('Yodo Germisin', 'insumo', 'envase', 'frasco', 'frasco', 1, 1, null, null, 1),
    ('Jeringa para insulina 30UI', 'insumo', 'pieza', 'pieza', 'pieza', 1, 6, null, null, 5),
    ('Jeringa 10ml', 'insumo', 'pieza', 'pieza', 'pieza', 1, 9, null, null, 5),
    ('Jeringa 5ml', 'insumo', 'pieza', 'pieza', 'pieza', 1, 7, null, null, 5),
    ('Jeringa 3ml', 'insumo', 'pieza', 'pieza', 'pieza', 1, 5, null, null, 5),
    ('Cloruro de etilo sol.', 'insumo', 'envase', 'frasco', 'frasco', 1, 2, date '2027-05-31', null, 1),
    ('Sutura Nylon 4-0', 'insumo', 'pieza', 'pieza', 'pieza', 1, 2, date '2030-11-30', null, 2),
    ('Sutura Nylon 3-0', 'insumo', 'pieza', 'pieza', 'pieza', 1, 3, date '2030-09-30', null, 2),
    ('Sutura Nylon 2-0', 'insumo', 'pieza', 'pieza', 'pieza', 1, 4, date '2029-07-31', null, 2),
    ('Curitas', 'insumo', 'pieza', 'pieza', 'pieza', 1, 70, date '2028-06-30', null, 20),
    ('Venda malla tubular n1', 'insumo', 'envase', 'rollo', 'rollo', 1, 1, null, null, 1),
    ('Tiras reactivas Accu Check', 'insumo', 'pieza', 'tira', 'frasco', 1, 25, date '2027-05-31', null, 10),
    ('Agua oxigenada', 'insumo', 'envase', 'frasco', 'frasco', 1, 1, null, null, 1),
    ('Alcohol', 'insumo', 'envase', 'frasco', 'frasco', 1, 1, null, null, 1),
    ('Cotonetes', 'insumo', 'envase', 'bolsa', 'bolsa', 1, 1, null, null, 1),
    ('Baumanómetro manual', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Estetoscopio', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Termómetro digital', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Lámpara grande', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Báscula con estadímetro', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Cartilla Snell', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Báscula portátil', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Glucómetro', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Collarín suave', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Camilla de masajes', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Lámpara de chicote', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Banco', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Banco de altura', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Biombo', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Negatoscopio', 'equipo', 'pieza', 'pieza', 'pieza', 1, 2, null, null, 0),
    ('Mesa de mayo', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Bote rojo punzocortantes', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Bote rojo líquidos biológicos', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Oxímetro', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Organizador de papel rejilla negra 1 departamento', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Bote basura común', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Repetidor wifi', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Extensión eléctrica', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Silla paciente', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Silla con ruedas médico', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Archivero metal cojín verde', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0),
    ('Archivero metal medicamentos', 'equipo', 'pieza', 'pieza', 'pieza', 1, 1, null, null, 0)
  ) v(nombre, categoria, control, unidad, empaque, contenido, cantidad, caducidad, nivel, minimo) loop
    select id into v_med from public.medicamentos_med where lower(nombre) = lower(r.nombre);
    if v_med is null then
      select count(*) into n_ins from public.medicamentos_med where categoria = r.categoria;
      insert into public.medicamentos_med (clave, nombre, categoria, control, unidad, empaque, contenido_empaque, stock_minimo)
      values (case r.categoria when 'insumo' then 'INS-' else 'EQ-' end || lpad((n_ins + 1)::text, 3, '0'),
              r.nombre, r.categoria, r.control, r.unidad, r.empaque, r.contenido, r.minimo)
      returning id into v_med;
    end if;
    v_lote := public.med_registrar_entrada(v_med, '', r.caducidad, r.cantidad, v_motivo);
    if r.nivel is not null then update public.lotes_med set nivel = r.nivel where id = v_lote; end if;
  end loop;
end $$;

-- ---------- 4. Puesto predeterminado ----------
update public.colaboradores_med set puesto = 'Auxiliar' where usuario_id is null and puesto is null;

-- ---------- 5. KPI del panel ----------
do $$
declare v_def text := pg_get_functiondef('public.med_dashboard(date, date)'::regprocedure);
begin
  if position('from public.medicamentos_med where activo)' in v_def) > 0 then
    execute replace(v_def, 'from public.medicamentos_med where activo)', 'from public.medicamentos_med where activo and categoria = ''medicamento'')');
  end if;
end $$;
