-- =====================================================================
-- Servicio Médico · Migración 14 (v1.9): Omeprazol 20mg y Captopril 25mg
-- pasan de control por envase a control por tableta (indicación del médico):
-- Omeprazol = frasco de 28 tabletas; Captopril = frasco de 30 tabletas.
-- La existencia se convierte con un ajuste registrado en el kardex.
-- =====================================================================
do $$
declare r record; v_lote uuid;
begin
  perform set_config('request.jwt.claims', '{"email":"servicio.medico@petstable.mx","role":"authenticated"}', true);
  for r in select * from (values ('Omeprazol 20mg', 28), ('Captopril 25mg', 30)) v(nombre, contenido) loop
    update public.medicamentos_med
       set control = 'pieza', unidad = 'tableta', empaque = 'frasco', contenido_empaque = r.contenido, stock_minimo = 10
     where nombre = r.nombre;
    for v_lote in select l.id from public.lotes_med l join public.medicamentos_med m on m.id = l.medicamento_id
                   where m.nombre = r.nombre and l.existencia > 0 loop
      update public.lotes_med set nivel = null where id = v_lote;
      perform public.med_ajustar_lote(v_lote, (select existencia from public.lotes_med where id = v_lote) * r.contenido,
        format('Conversión a tabletas: frasco de %s tabletas', r.contenido));
    end loop;
  end loop;
end $$;

-- Corrección aplicada el 19/10/2026: el lote de Omeprazol tenía además una entrada de 28 capturada
-- cuando el control era por envase (28 "botes"); la existencia real confirmada es 28 tabletas.
do $$ begin
  perform set_config('request.jwt.claims', '{"email":"servicio.medico@petstable.mx","role":"authenticated"}', true);
  perform public.med_ajustar_lote((select l.id from public.lotes_med l join public.medicamentos_med m on m.id = l.medicamento_id where m.nombre = 'Omeprazol 20mg'), 28,
    'Corrección: existencia real 28 tabletas (1 frasco). La entrada previa se capturó cuando el control era por envase');
end $$;

-- ---------- Clave automática por categoría (MED-, INS-, EQ-) ----------
create or replace function public.med_clave_automatica() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_pref text := case new.categoria when 'insumo' then 'INS' when 'equipo' then 'EQ' else 'MED' end;
begin
  perform pg_advisory_xact_lock(hashtext('medicamentos_med_clave'));
  new.clave := v_pref || '-' || lpad((coalesce((
      select max((regexp_match(clave, '^' || v_pref || '-(\d+)$'))[1]::int) from public.medicamentos_med
       where clave ~ ('^' || v_pref || '-\d+$')), 0) + 1)::text, 3, '0');
  return new;
end $$;
revoke all on function public.med_clave_automatica() from public, anon, authenticated;
drop trigger if exists medicamentos_med_clave on public.medicamentos_med;
create trigger medicamentos_med_clave before insert on public.medicamentos_med
  for each row execute function public.med_clave_automatica();
-- La clave no cambia al editar
create or replace function public.med_clave_fija() returns trigger
language plpgsql set search_path = '' as $$
begin new.clave := old.clave; return new; end $$;
revoke all on function public.med_clave_fija() from public, anon, authenticated;
drop trigger if exists medicamentos_med_clave_fija on public.medicamentos_med;
create trigger medicamentos_med_clave_fija before update on public.medicamentos_med
  for each row execute function public.med_clave_fija();
