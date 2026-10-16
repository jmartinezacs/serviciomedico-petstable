// =====================================================================
// Reportes (solo administradores): exportaciones a Excel (CSV) y
// respaldo completo en JSON. Todo se lee con la sesión del usuario,
// por lo que respeta las mismas reglas de acceso (RLS).
// =====================================================================
import {
  sb, esc, icon, toast, errMsg, todayISO, addDays, fmtDate, fmtTime, fmtDateTime, MOTIVOS, ESTADOS,
  fetchAll, toCSV, descargar, must, dayStartTs, dayEndTs, APP_VERSION, refreshIcons,
} from '../core.js';

let root;
const TIPOS_MOV = { entrada: 'Entrada', salida: 'Salida', ajuste: 'Ajuste', dispensacion: 'Dispensación' };

const REPORTES = [
  { id: 'citas', ico: 'calendar-days', titulo: 'Citas', texto: 'Todas las citas del periodo con colaborador, área, motivo, estado y quién la solicitó.' },
  { id: 'consumo', ico: 'pill', titulo: 'Consumo de medicamentos por mes', texto: 'Piezas entregadas en consultas y salidas manuales, agrupadas por mes y medicamento.' },
  { id: 'padecimientos', ico: 'stethoscope', titulo: 'Padecimientos por área', texto: 'Consultas atendidas por padecimiento en cada área (sin datos personales).' },
  { id: 'movimientos', ico: 'arrow-left-right', titulo: 'Movimientos de inventario', texto: 'Kardex completo del periodo: entradas, salidas, ajustes y dispensaciones.' },
  { id: 'inventario', ico: 'boxes', titulo: 'Inventario actual', texto: 'Existencias por lote con caducidad (no depende del periodo).' },
];

export default {
  async render(el) {
    root = el;
    const hoy = todayISO();
    el.innerHTML = `
      <section class="page-intro">
        <div><span class="eyebrow">Información</span><h1>Reportes y respaldo</h1>
          <p>Descarga la información en archivos que se abren en Excel.</p></div>
      </section>
      <div class="card">
        <div class="toolbar">
          <span class="date-range"><label for="r-desde">Periodo</label> <input type="date" id="r-desde" value="${hoy.slice(0, 8)}01"> a <input type="date" id="r-hasta" value="${hoy}"></span>
          <button class="btn ghost" data-r="mes-ant">Mes anterior</button>
          <button class="btn ghost" data-r="anio">Este año</button>
        </div>
        <div class="report-grid">
          ${REPORTES.map((r) => `<div class="report-card"><div class="report-ico">${icon(r.ico)}</div>
            <div><b>${esc(r.titulo)}</b><p>${esc(r.texto)}</p></div>
            <button class="btn secondary" data-exp="${r.id}">${icon('file-spreadsheet')} Descargar</button></div>`).join('')}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>${icon('database-backup')} Respaldo completo</h3>
          <p>Descarga en un archivo JSON todos los catálogos, citas, atenciones, inventario, bitácora y configuración de Servicio Médico. Útil para conservar una copia o migrar.</p></div>
          <button class="btn primary" data-exp="respaldo">${icon('download')} Descargar respaldo</button></div>
        <div class="notice warn">${icon('shield-alert')}<span>El respaldo incluye <b>datos de salud</b> (sintomatología y notas). Guárdalo en un lugar seguro, con acceso restringido, y no lo envíes por correo ni chat.</span></div>
      </div>`;
    el.addEventListener('click', onClick);
  },
  destroy() { root = null; },
};

function periodo() {
  const d = root.querySelector('#r-desde').value, h = root.querySelector('#r-hasta').value;
  if (!d || !h || h < d) { toast('Revisa el periodo: la fecha final debe ser igual o posterior a la inicial.', 'warning'); return null; }
  return { desde: d, hasta: h };
}

async function onClick(e) {
  const r = e.target.closest('[data-r]');
  if (r) {
    const hoy = todayISO();
    const desde = root.querySelector('#r-desde'), hasta = root.querySelector('#r-hasta');
    if (r.dataset.r === 'mes-ant') {
      const ini = addDays(`${hoy.slice(0, 8)}01`, -1).slice(0, 8) + '01';
      desde.value = ini; hasta.value = addDays(`${hoy.slice(0, 8)}01`, -1);
    } else { desde.value = `${hoy.slice(0, 4)}-01-01`; hasta.value = hoy; }
    return;
  }
  const b = e.target.closest('[data-exp]');
  if (!b || b.disabled) return;
  const p = b.dataset.exp === 'inventario' || b.dataset.exp === 'respaldo' ? {} : periodo();
  if (!p) return;
  const label = b.innerHTML;
  b.disabled = true; b.innerHTML = '<span class="spinner sm"></span> Generando…';
  try {
    const n = await EXPORTS[b.dataset.exp](p);
    toast(n === 0 ? 'No hay información en ese periodo; se descargó el archivo vacío.' : 'Archivo descargado.', n === 0 ? 'warning' : 'success');
  } catch (err) { console.error(err); toast(errMsg(err), 'error'); }
  b.disabled = false; b.innerHTML = label; refreshIcons();
}

const sufijo = ({ desde, hasta }) => `${desde}_a_${hasta}`;

const EXPORTS = {
  async citas(p) {
    const rows = await fetchAll(() => sb.from('v_citas_med').select('folio_txt, fecha, hora, tipo, colaborador, num_empleado, area, motivo, descripcion, estado, motivo_cancelacion, solicitante, created_at')
      .gte('fecha', p.desde).lte('fecha', p.hasta).order('fecha').order('hora'));
    descargar(`citas_${sufijo(p)}.csv`, toCSV(rows, [
      { label: 'Folio', get: (c) => c.folio_txt }, { label: 'Fecha', get: (c) => fmtDate(c.fecha) },
      { label: 'Hora', get: (c) => (c.hora ? fmtTime(c.hora) : '') }, { label: 'Tipo', get: (c) => (c.tipo === 'urgente' ? 'Urgente' : 'Normal') },
      { label: 'Colaborador', get: (c) => c.colaborador }, { label: 'No. empleado', get: (c) => c.num_empleado },
      { label: 'Área', get: (c) => c.area }, { label: 'Motivo', get: (c) => MOTIVOS[c.motivo] || c.motivo },
      { label: 'Descripción', get: (c) => c.descripcion }, { label: 'Estado', get: (c) => ESTADOS[c.estado]?.label || c.estado },
      { label: 'Motivo de cancelación', get: (c) => c.motivo_cancelacion }, { label: 'Solicitó', get: (c) => c.solicitante },
      { label: 'Registrada', get: (c) => fmtDateTime(c.created_at) },
    ]));
    return rows.length;
  },
  async consumo(p) {
    const rows = await fetchAll(() => sb.from('v_movimientos_med').select('created_at, tipo, cantidad, clave, medicamento, unidad')
      .in('tipo', ['dispensacion', 'salida']).gte('created_at', dayStartTs(p.desde)).lt('created_at', dayEndTs(p.hasta)).order('created_at'));
    const mes = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit' }).format(new Date(ts));
    const g = new Map();
    for (const r of rows) {
      const k = `${mes(r.created_at)}|${r.clave}`;
      const o = g.get(k) || { mes: mes(r.created_at), clave: r.clave, medicamento: r.medicamento, unidad: r.unidad, disp: 0, sal: 0 };
      if (r.tipo === 'dispensacion') o.disp += -r.cantidad; else o.sal += -r.cantidad;
      g.set(k, o);
    }
    const out = [...g.values()].sort((a, b) => a.mes.localeCompare(b.mes) || a.medicamento.localeCompare(b.medicamento));
    descargar(`consumo_medicamentos_${sufijo(p)}.csv`, toCSV(out, [
      { label: 'Mes', get: (o) => o.mes }, { label: 'Clave', get: (o) => o.clave }, { label: 'Medicamento', get: (o) => o.medicamento },
      { label: 'Unidad', get: (o) => o.unidad }, { label: 'Entregado en consultas', get: (o) => o.disp },
      { label: 'Salidas manuales', get: (o) => o.sal }, { label: 'Total', get: (o) => o.disp + o.sal },
    ]));
    return out.length;
  },
  async padecimientos(p) {
    const { data } = must(await sb.rpc('med_estadisticas_padecimientos', { p_desde: p.desde, p_hasta: p.hasta }));
    const out = [];
    for (const a of data.por_area || []) for (const i of a.items) out.push({ area: a.area, padecimiento: i.padecimiento, n: i.n, total: a.total });
    descargar(`padecimientos_por_area_${sufijo(p)}.csv`, toCSV(out, [
      { label: 'Área', get: (o) => o.area }, { label: 'Padecimiento', get: (o) => o.padecimiento },
      { label: 'Consultas', get: (o) => o.n }, { label: 'Total del área', get: (o) => o.total },
      { label: '% del área', get: (o) => Math.round((o.n / Math.max(1, o.total)) * 1000) / 10 },
    ]));
    return out.length;
  },
  async movimientos(p) {
    const rows = await fetchAll(() => sb.from('v_movimientos_med').select('created_at, tipo, clave, medicamento, unidad, lote, caducidad, cantidad, existencia_resultante, cita_folio, motivo, usuario')
      .gte('created_at', dayStartTs(p.desde)).lt('created_at', dayEndTs(p.hasta)).order('created_at'));
    descargar(`movimientos_inventario_${sufijo(p)}.csv`, toCSV(rows, [
      { label: 'Fecha y hora', get: (m) => fmtDateTime(m.created_at) }, { label: 'Tipo', get: (m) => TIPOS_MOV[m.tipo] || m.tipo },
      { label: 'Clave', get: (m) => m.clave }, { label: 'Medicamento', get: (m) => m.medicamento }, { label: 'Unidad', get: (m) => m.unidad },
      { label: 'Lote', get: (m) => m.lote }, { label: 'Caducidad', get: (m) => fmtDate(m.caducidad) },
      { label: 'Cantidad', get: (m) => m.cantidad }, { label: 'Existencia resultante', get: (m) => m.existencia_resultante },
      { label: 'Cita', get: (m) => (m.cita_folio ? `CM-${String(m.cita_folio).padStart(5, '0')}` : '') },
      { label: 'Motivo', get: (m) => m.motivo }, { label: 'Usuario', get: (m) => m.usuario },
    ]));
    return rows.length;
  },
  async inventario() {
    const rows = await fetchAll(() => sb.from('v_lotes_med').select('*').gt('existencia', 0).order('caducidad'));
    const meds = new Map((await fetchAll(() => sb.from('medicamentos_med').select('id, clave, nombre, unidad, stock_minimo, empaque, contenido_empaque'))).map((m) => [m.id, m]));
    const CAD = { vigente: 'Vigente', por_caducar: 'Por caducar', caducado: 'Caducado' };
    descargar(`inventario_${todayISO()}.csv`, toCSV(rows, [
      { label: 'Clave', get: (l) => meds.get(l.medicamento_id)?.clave }, { label: 'Medicamento', get: (l) => meds.get(l.medicamento_id)?.nombre },
      { label: 'Lote', get: (l) => l.lote }, { label: 'Caducidad', get: (l) => fmtDate(l.caducidad) },
      { label: 'Estado', get: (l) => CAD[l.estado_caducidad] || l.estado_caducidad },
      { label: 'Existencia', get: (l) => l.existencia }, { label: 'Unidad', get: (l) => meds.get(l.medicamento_id)?.unidad },
      { label: 'Empaque', get: (l) => meds.get(l.medicamento_id)?.empaque },
      { label: 'Contenido por empaque', get: (l) => meds.get(l.medicamento_id)?.contenido_empaque },
    ]));
    return rows.length;
  },
  async respaldo() {
    const tablas = ['config_med', 'areas_med', 'usuarios_med', 'colaboradores_med', 'padecimientos_med', 'dias_sin_servicio_med',
      'citas_med', 'atenciones_med', 'medicamentos_med', 'lotes_med', 'movimientos_med', 'bitacora_med'];
    const datos = {};
    for (const t of tablas) datos[t] = await fetchAll(() => sb.from(t).select('*').order(t === 'atenciones_med' ? 'cita_id' : 'id'), 200000);
    const total = Object.values(datos).reduce((s, x) => s + x.length, 0);
    descargar(`respaldo_servicio_medico_${todayISO()}.json`, JSON.stringify({
      sistema: 'Servicio Médico · Pet\'s Table', version: APP_VERSION, generado: new Date().toISOString(), tablas: datos,
    }, null, 1), 'application/json');
    return total;
  },
};
