// =====================================================================
// Inventario de medicamentos (solo administradores):
// existencias por medicamento, lotes con caducidad y movimientos.
// Las existencias solo cambian mediante funciones del servidor
// (med_registrar_entrada, med_registrar_salida, med_ajustar_lote,
// med_atender_cita), que registran cada movimiento.
// =====================================================================
import {
  sb, esc, icon, toast, errMsg, openModal, confirmDialog, checkForm, formValues, nullIfEmpty, bindCounters,
  DataTable, paged, sanitizeSearch, debounce, pill, must, fmtNum, fmtDate, fmtDateTime, todayISO, addDays,
  dayStartTs, dayEndTs, plural, cantUnidad, equivEmpaque, existenciaHTML,
  emptyState, errorState, refreshIcons, toCSV, descargar,
} from '../core.js';

let root, tStock, tLotes, tMovs, tab = 'stock';

const STOCK_PILL = { ok: ['Suficiente', 'ok'], bajo: ['Bajo mínimo', 'warn'], agotado: ['Agotado', 'bad'] };
const CAD_PILL = { vigente: ['Vigente', 'ok'], por_caducar: ['Por caducar', 'warn'], caducado: ['Caducado', 'bad'], sin_caducidad: ['Sin caducidad', 'gray'] };
const TIPO_PILL = { entrada: ['Entrada', 'ok'], salida: ['Salida', 'bad'], ajuste: ['Ajuste', 'info'], dispensacion: ['Dispensación', 'orange'], uso: ['Uso de envase', 'gray'] };
// Unidad mínima de control (se cuenta pieza por pieza o de forma aproximada en líquidos)
const UNIDADES = ['tableta', 'cápsula', 'gragea', 'pieza', 'sobre', 'ampolleta', 'parche', 'óvulo', 'supositorio', 'ml', 'g', 'dosis'];
// Empaque o presentación de compra
const EMPAQUES = ['caja', 'frasco', 'bote', 'blíster', 'tubo', 'sobre', 'bolsa', 'paquete', 'pieza'];

const CATEGORIAS = { medicamento: 'Medicamento', insumo: 'Insumo médico', equipo: 'Equipo y mobiliario' };
const NIVELES = { 100: 'Lleno', 75: '¾', 50: '½', 25: '¼' };
const nivelTxt = (n) => (n ? `abierto, queda ${NIVELES[n] === 'Lleno' ? 'lleno' : NIVELES[n]}` : '');
const envase = (m) => m?.control === 'envase';

// Captura de cantidad: por unidad mínima (tableta, cápsula…) o por empaque (caja, bote…),
// indicando cuántas unidades trae cada empaque; el total se calcula en unidad mínima.
function capturaHTML(id, m) {
  if (!m) return '<span class="hint">Selecciona un artículo.</span>';
  if (envase(m) || m.unidad === m.empaque) return `<span class="hint">Se captura por ${esc(m.unidad)}.</span>`;
  const c = Number(m.contenido_empaque) || 1;
  return `<div class="seg" role="radiogroup" aria-label="Capturar cantidad" id="${id}">
      <button type="button" data-modo="unidad" class="active">Por ${esc(m.unidad)}</button>
      <button type="button" data-modo="empaque">Por ${esc(m.empaque)}</button></div>
    <div class="field hidden" data-cont style="margin:10px 0 0"><label for="${id}-cont">Cada ${esc(m.empaque)} contiene (${esc(plural(m.unidad, 2))}) <span class="req">*</span></label>
      <input id="${id}-cont" type="number" inputmode="numeric" min="1" max="100000" step="1" value="${c > 1 ? c : ''}" placeholder="Ej. 10"></div>`;
}
function bindCaptura(form, segId, inputName, getMed, getMax = () => null) {
  const input = form.elements[inputName];
  const out = form.querySelector(`[data-total="${inputName}"]`);
  const label = form.querySelector(`label[for="${input.id}"]`);
  let modo = 'unidad';
  const contIn = () => form.querySelector(`#${segId}-cont`);
  const contenido = () => (modo === 'empaque' ? Number(contIn()?.value) || 0 : 1);
  const total = () => (Number(input.value) || 0) * contenido();
  const paint = () => {
    const m = getMed(); const t = total(); const max = getMax();
    const nom = m ? (modo === 'empaque' ? m.empaque : m.unidad) : '';
    if (label) label.innerHTML = `Cantidad${nom ? ` de ${esc(plural(nom, 2))}` : ''} <span class="req">*</span>`;
    form.querySelector(`#${segId}`)?.querySelectorAll('[data-modo]').forEach((x) => x.classList.toggle('active', x.dataset.modo === modo));
    const cw = form.querySelector('[data-cont]');
    if (cw) { cw.classList.toggle('hidden', modo !== 'empaque'); contIn().required = modo === 'empaque'; }
    if (out) out.textContent = input.value && m && t ? `Total: ${cantUnidad(t, m.unidad)}${max != null ? ` de ${cantUnidad(max, m.unidad)} disponibles` : ''}` : '';
    input.max = max != null && modo === 'unidad' ? String(max) : '100000';
  };
  form.addEventListener('click', (e) => {
    const b = e.target.closest(`#${segId} [data-modo]`); if (!b) return;
    modo = b.dataset.modo; paint();
  });
  form.addEventListener('input', (e) => { if (e.target === input || e.target === contIn()) paint(); });
  paint();
  return { total, paint, contenido, modo: () => modo, reset: () => { modo = 'unidad'; paint(); } };
}

export default {
  async render(el, params = {}) {
    root = el;
    tab = ['stock', 'lotes', 'movs', 'reabasto'].includes(params.tab) ? params.tab : 'stock';
    el.innerHTML = `
      <section class="page-intro">
        <div><span class="eyebrow">Medicamentos, insumos y equipo</span><h1>Inventario</h1>
          <p>Existencias por lote, caducidades y trazabilidad de movimientos.</p></div>
        <div class="page-actions">
          <button class="btn secondary" data-i="nuevo-med">${icon('plus')} Nuevo artículo</button>
          <button class="btn secondary" data-i="salida">${icon('package-minus')} Registrar salida</button>
          <button class="btn primary" data-i="entrada">${icon('package-plus')} Registrar entrada</button>
        </div>
      </section>
      <div class="tabs" role="tablist">
        <button role="tab" data-tab="stock">${icon('boxes')} Existencias</button>
        <button role="tab" data-tab="lotes">${icon('layers')} Lotes y caducidades</button>
        <button role="tab" data-tab="movs">${icon('arrow-left-right')} Movimientos</button>
        <button role="tab" data-tab="reabasto">${icon('shopping-cart')} Reabasto</button>
      </div>
      <div class="card hidden" data-pane="reabasto"><div id="reabasto-box"></div></div>
      <div class="card" data-pane="stock">
        <div class="toolbar">
          <div class="search">${icon('search')}<input type="search" id="s-q" placeholder="Buscar por clave o nombre" aria-label="Buscar"></div>
          <select id="s-cat" aria-label="Categoría"><option value="">Todas las categorías</option>${Object.entries(CATEGORIAS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <select id="s-estado" aria-label="Estado de existencia"><option value="">Todas las existencias</option><option value="alerta">Con alerta (bajo mínimo o agotado)</option><option value="ok">Suficiente</option><option value="bajo">Bajo mínimo</option><option value="agotado">Agotado</option></select>
          <select id="s-activo" aria-label="Estado"><option value="true">Activos</option><option value="false">Inactivos</option><option value="">Todos</option></select>
        </div>
        <div id="stock-table"></div>
      </div>
      <div class="card hidden" data-pane="lotes">
        <div class="toolbar">
          <div class="search">${icon('search')}<input type="search" id="l-q" placeholder="Buscar por artículo o lote" aria-label="Buscar"></div>
          <select id="l-estado" aria-label="Caducidad"><option value="">Todas las caducidades</option><option value="vigente">Vigentes</option><option value="por_caducar">Por caducar</option><option value="caducado">Caducados</option><option value="sin_caducidad">Sin caducidad</option></select>
          <select id="l-exist" aria-label="Existencia"><option value="con">Con existencia</option><option value="">Todos</option><option value="sin">Sin existencia</option></select>
        </div>
        <div id="lotes-table"></div>
      </div>
      <div class="card hidden" data-pane="movs">
        <div class="toolbar">
          <div class="search">${icon('search')}<input type="search" id="m-q" placeholder="Buscar artículo, lote o folio de cita" aria-label="Buscar"></div>
          <select id="m-tipo" aria-label="Tipo"><option value="">Todos los tipos</option>${Object.entries(TIPO_PILL).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}</select>
          <span class="date-range"><input type="date" id="m-desde" aria-label="Desde"> a <input type="date" id="m-hasta" aria-label="Hasta"></span>
        </div>
        <div id="movs-table"></div>
      </div>`;
    if (params.estado && (STOCK_PILL[params.estado] || params.estado === 'alerta')) el.querySelector('#s-estado').value = params.estado;
    if (params.cad && CAD_PILL[params.cad]) { el.querySelector('#l-estado').value = params.cad; tab = 'lotes'; }
    el.addEventListener('click', onClick);
    bindFilters();
    await showTab(tab);
  },
  destroy() { root = null; tStock = tLotes = tMovs = null; },
};

function bindFilters() {
  const q = (s) => root.querySelector(s);
  const applyStock = () => tStock?.setFilters({ q: q('#s-q').value, cat: q('#s-cat').value, estado: q('#s-estado').value, activo: q('#s-activo').value });
  q('#s-q').addEventListener('input', debounce(applyStock, 350));
  ['#s-cat', '#s-estado', '#s-activo'].forEach((s) => q(s).addEventListener('change', applyStock));
  const applyLotes = () => tLotes?.setFilters({ q: q('#l-q').value, estado: q('#l-estado').value, exist: q('#l-exist').value });
  q('#l-q').addEventListener('input', debounce(applyLotes, 350));
  ['#l-estado', '#l-exist'].forEach((s) => q(s).addEventListener('change', applyLotes));
  const applyMovs = () => tMovs?.setFilters({ q: q('#m-q').value, tipo: q('#m-tipo').value, desde: q('#m-desde').value, hasta: q('#m-hasta').value });
  q('#m-q').addEventListener('input', debounce(applyMovs, 350));
  ['#m-tipo', '#m-desde', '#m-hasta'].forEach((s) => q(s).addEventListener('change', applyMovs));
  root._apply = { stock: applyStock, lotes: applyLotes, movs: applyMovs };
}

async function showTab(name) {
  tab = name;
  root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  root.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
  if (name === 'stock') { tStock ??= stockTable(); return root._apply.stock(); }
  if (name === 'lotes') { tLotes ??= lotesTable(); return root._apply.lotes(); }
  if (name === 'reabasto') return renderReabasto();
  tMovs ??= movsTable(); return root._apply.movs();
}

// ---------- Reabasto: consumo, cobertura y pedido sugerido ----------
let reabastoRows = [];
async function renderReabasto() {
  const box = root?.querySelector('#reabasto-box');
  if (!box) return;
  box.innerHTML = '<div class="skeleton" style="height:120px"></div>';
  try {
    const [{ data }, { data: cfg }] = await Promise.all([
      sb.rpc('med_reabasto', { p_dias: 90 }).then(must),
      sb.from('config_med').select('dias_cobertura').eq('id', 1).single().then(must),
    ]);
    if (!root) return;
    reabastoRows = data;
    const pedir = data.filter((m) => m.sugerido > 0);
    const row = (m) => `<tr>
      <td data-label="Medicamento"><div class="td-in"><div class="cell-main">${esc(m.nombre)}</div><div class="cell-sub mono">${esc(m.clave)}</div></div></td>
      <td data-label="Existencia" class="num"><div class="td-in">${existenciaHTML(m.existencia, m)}</div></td>
      <td data-label="Consumo mensual" class="num"><div class="td-in">${m.consumo ? `${esc(cantUnidad(Number(m.consumo_mensual), m.unidad))}<div class="cell-sub">${esc(cantUnidad(m.consumo, m.unidad))} en 90 días</div>` : '<span class="cell-sub">Sin consumo</span>'}</div></td>
      <td data-label="Cobertura" class="num"><div class="td-in">${m.dias_cobertura == null ? '<span class="cell-sub">—</span>' : pill(`${fmtNum(m.dias_cobertura)} días`, m.dias_cobertura < 15 ? 'bad' : m.dias_cobertura < cfg.dias_cobertura ? 'warn' : 'ok')}</div></td>
      <td data-label="Pedido sugerido" class="num"><div class="td-in">${m.sugerido > 0 ? `<b>${esc(cantUnidad(m.sugerido, m.unidad))}</b>${Number(m.contenido_empaque) > 1 ? `<div class="cell-sub">≈ ${esc(`${fmtNum(m.sugerido_empaques)} ${plural(m.empaque, m.sugerido_empaques)}`)}</div>` : ''}` : '<span class="cell-sub">No requiere</span>'}</div></td>
    </tr>`;
    box.innerHTML = `
      <div class="card-head"><div><h3>Pedido sugerido</h3>
        <p>Consumo real de los últimos 90 días (medicamentos entregados en consultas). Se sugiere cubrir ${fmtNum(cfg.dias_cobertura)} días y nunca quedar por debajo del mínimo. La cobertura objetivo se cambia en Usuarios → Configuración.</p></div>
        <button class="btn secondary" data-i="exportar-reabasto" ${data.length ? '' : 'disabled'}>${icon('file-spreadsheet')} Exportar a Excel</button></div>
      ${data.length ? `<p class="hint">${pedir.length ? `${fmtNum(pedir.length)} de ${fmtNum(data.length)} medicamentos requieren reabasto.` : 'Ningún medicamento requiere reabasto por ahora.'}</p>
        <div class="table-wrap responsive"><table class="table"><thead><tr><th>Medicamento</th><th class="num">Existencia</th><th class="num">Consumo mensual</th><th class="num">Cobertura</th><th class="num">Pedido sugerido</th></tr></thead>
        <tbody>${data.map(row).join('')}</tbody></table></div>`
        : emptyState({ ico: 'pill', title: 'Sin medicamentos activos', text: 'Registra medicamentos para calcular el reabasto.' })}`;
  } catch (err) {
    console.error(err);
    box.innerHTML = errorState(err).replace('data-action="retry"', 'data-i="reabasto-retry"');
  }
  refreshIcons();
}
function exportarReabasto() {
  descargar(`reabasto-${todayISO()}.csv`, toCSV(reabastoRows, [
    { label: 'Clave', get: (m) => m.clave }, { label: 'Medicamento', get: (m) => m.nombre },
    { label: 'Unidad', get: (m) => m.unidad }, { label: 'Existencia vigente', get: (m) => m.existencia },
    { label: 'Stock mínimo', get: (m) => m.stock_minimo }, { label: 'Consumo 90 días', get: (m) => m.consumo },
    { label: 'Consumo mensual', get: (m) => Number(m.consumo_mensual) }, { label: 'Días de cobertura', get: (m) => m.dias_cobertura },
    { label: 'Pedido sugerido (unidades)', get: (m) => m.sugerido }, { label: 'Empaque', get: (m) => m.empaque },
    { label: 'Contenido por empaque', get: (m) => m.contenido_empaque }, { label: 'Pedido sugerido (empaques)', get: (m) => m.sugerido_empaques },
  ]));
}

function stockTable() {
  return new DataTable(root.querySelector('#stock-table'), {
    sort: { key: 'nombre', asc: true },
    columns: [
      { label: 'Clave', sort: 'clave', render: (m) => `<span class="mono cell-main">${esc(m.clave)}</span>` },
      { label: 'Artículo', sort: 'nombre', render: (m) => `<div class="cell-main">${esc(m.nombre)}</div><div class="cell-sub">${esc([CATEGORIAS[m.categoria], m.presentacion].filter(Boolean).join(' · '))}</div>` },
      { label: 'Existencia vigente', cls: 'num', sort: 'existencia_vigente', render: (m) => `${existenciaHTML(m.existencia_vigente, m)}${envase(m) && m.nivel_abierto ? `<div class="cell-sub">1 ${esc(m.unidad)} ${esc(nivelTxt(m.nivel_abierto))}</div>` : ''}${m.existencia_caducada ? `<div class="cell-sub" style="color:var(--bad)">${esc(cantUnidad(m.existencia_caducada, m.unidad))} caducadas</div>` : ''}` },
      { label: 'Empaque', render: (m) => (envase(m) ? `<span class="cell-sub">Por envase (nivel de uso)</span>` : Number(m.contenido_empaque) > 1 ? `${esc(m.empaque)}<div class="cell-sub">${esc(cantUnidad(m.contenido_empaque, m.unidad))} c/u</div>` : `<span class="cell-sub">Por ${esc(m.unidad)}</span>`) },
      { label: 'Mínimo', cls: 'num', sort: 'stock_minimo', render: (m) => (m.stock_minimo ? esc(cantUnidad(m.stock_minimo, m.unidad)) : '<span class="cell-sub">Sin alerta</span>') },
      { label: 'Próx. caducidad', sort: 'proxima_caducidad', render: (m) => (m.proxima_caducidad ? fmtDate(m.proxima_caducidad) : '<span class="cell-sub">—</span>') },
      { label: 'Estado', render: (m) => (!m.activo ? pill('Inactivo', 'gray') : m.categoria === 'equipo' ? pill('Equipo', 'gray') : pill(...stockPill(m))) },
      { label: 'Acciones', cls: 'actions', render: (m) => `<div class="row-actions">
        ${m.activo ? `<button class="icon-btn ok" data-ia="entrada" data-id="${esc(m.id)}" title="Registrar entrada" aria-label="Registrar entrada">${icon('package-plus')}</button>` : ''}
        <button class="icon-btn" data-ia="lotes" data-id="${esc(m.id)}" title="Ver lotes" aria-label="Ver lotes">${icon('layers')}</button>
        <button class="icon-btn" data-ia="editar" data-id="${esc(m.id)}" title="Editar" aria-label="Editar">${icon('pencil')}</button>
        <button class="icon-btn ${m.activo ? 'warn' : 'ok'}" data-ia="toggle" data-id="${esc(m.id)}" title="${m.activo ? 'Desactivar' : 'Activar'}" aria-label="${m.activo ? 'Desactivar' : 'Activar'}">${icon(m.activo ? 'eye-off' : 'eye')}</button>
        <button class="icon-btn bad" data-ia="eliminar" data-id="${esc(m.id)}" title="Eliminar" aria-label="Eliminar">${icon('trash-2')}</button></div>` },
    ],
    empty: { ico: 'pill', title: 'Sin medicamentos registrados', text: 'Da de alta el catálogo de medicamentos y después registra sus entradas por lote.',
      action: `<button class="btn primary" data-i="nuevo-med">${icon('plus')} Nuevo medicamento</button>` },
    fetch: async ({ from, to, sort, filters: f }) => {
      let q = sb.from('v_stock_med').select('*', { count: 'exact' });
      const s = sanitizeSearch(f.q);
      if (s) q = q.or(`clave.ilike.*${s}*,nombre.ilike.*${s}*`);
      // "alerta" usa el mismo criterio que el KPI del panel (med_dashboard.bajo_minimo)
      if (f.estado === 'alerta') q = q.in('estado_stock', ['bajo', 'agotado']).gt('stock_minimo', 0);
      else if (f.estado) q = q.eq('estado_stock', f.estado);
      if (f.cat) q = q.eq('categoria', f.cat);
      if (f.activo !== '' && f.activo !== undefined) q = q.eq('activo', f.activo === 'true');
      const { data, count } = must(await paged(q, { from, to, sort }, [['nombre', true]]));
      return { rows: data, count };
    },
  });
}
function stockPill(m) {
  if (m.estado_stock === 'agotado') return STOCK_PILL.agotado;
  if (m.estado_stock === 'bajo') return STOCK_PILL.bajo;
  return STOCK_PILL.ok;
}

function lotesTable() {
  return new DataTable(root.querySelector('#lotes-table'), {
    sort: { key: 'caducidad', asc: true },
    columns: [
      { label: 'Artículo', sort: 'medicamento', render: (l) => `<div class="cell-main">${esc(l.medicamento)}</div><div class="cell-sub mono">${esc(l.clave)}</div>` },
      { label: 'Lote', sort: 'lote', render: (l) => `<span class="mono">${esc(l.lote)}</span>` },
      { label: 'Caducidad', sort: 'caducidad', render: (l) => (l.caducidad ? `${fmtDate(l.caducidad)}<div class="cell-sub">${l.dias_para_caducar < 0 ? `Hace ${fmtNum(-l.dias_para_caducar)} días` : `En ${fmtNum(l.dias_para_caducar)} días`}</div>` : '<span class="cell-sub">Sin caducidad</span>') },
      { label: 'Existencia', cls: 'num', sort: 'existencia', render: (l) => `${existenciaHTML(l.existencia, l)}${envase(l) && l.nivel && l.existencia ? `<div class="cell-sub">1 ${esc(l.unidad)} ${esc(nivelTxt(l.nivel))}</div>` : ''}` },
      { label: 'Estado', render: (l) => pill(...CAD_PILL[l.estado_caducidad]) },
      { label: 'Acciones', cls: 'actions', render: (l) => `<div class="row-actions">
        ${envase(l) ? `<button class="icon-btn ok" data-la="uso" data-id="${esc(l.id)}" title="Registrar uso del envase" aria-label="Registrar uso del envase" ${l.existencia > 0 && l.estado_caducidad !== 'caducado' ? '' : 'disabled'}>${icon('droplet')}</button>` : ''}
        <button class="icon-btn bad" data-la="salida" data-id="${esc(l.id)}" title="Registrar salida" aria-label="Registrar salida" ${l.existencia > 0 ? '' : 'disabled'}>${icon('package-minus')}</button>
        <button class="icon-btn" data-la="ajuste" data-id="${esc(l.id)}" title="Ajuste por conteo físico" aria-label="Ajuste por conteo físico">${icon('clipboard-check')}</button>
        <button class="icon-btn" data-la="historial" data-id="${esc(l.id)}" title="Ver movimientos" aria-label="Ver movimientos">${icon('history')}</button></div>` },
    ],
    empty: { ico: 'layers', title: 'Sin lotes', text: 'Los lotes se crean al registrar una entrada de medicamento.' },
    fetch: async ({ from, to, sort, filters: f }) => {
      let q = sb.from('v_lotes_med').select('*', { count: 'exact' });
      const s = sanitizeSearch(f.q);
      if (s) q = q.or(`medicamento.ilike.*${s}*,lote.ilike.*${s}*,clave.ilike.*${s}*`);
      if (f.estado) q = q.eq('estado_caducidad', f.estado);
      if (f.exist === 'con') q = q.gt('existencia', 0);
      if (f.exist === 'sin') q = q.eq('existencia', 0);
      if (f.med) q = q.eq('medicamento_id', f.med);
      const { data, count } = must(await paged(q, { from, to, sort }, [['medicamento', true]]));
      return { rows: data, count };
    },
  });
}

function movsTable() {
  return new DataTable(root.querySelector('#movs-table'), {
    sort: { key: 'created_at', asc: false },
    columns: [
      { label: 'Fecha', sort: 'created_at', render: (m) => `<span class="mono">${fmtDateTime(m.created_at)}</span>` },
      { label: 'Tipo', sort: 'tipo', render: (m) => pill(...TIPO_PILL[m.tipo]) },
      { label: 'Artículo', sort: 'medicamento', render: (m) => `<div class="cell-main">${esc(m.medicamento)}</div><div class="cell-sub">Lote <span class="mono">${esc(m.lote)}</span>${m.caducidad ? ` · cad. ${fmtDate(m.caducidad)}` : ''}</div>` },
      { label: 'Cantidad', cls: 'num', render: (m) => (m.tipo === 'uso' ? '<span class="cell-sub">Sin descuento</span>' : `<span class="${m.cantidad > 0 ? 'qty-pos' : 'qty-neg'}">${m.cantidad > 0 ? '+' : '−'}${esc(cantUnidad(Math.abs(m.cantidad), m.unidad))}</span>${Math.abs(m.cantidad) >= (Number(m.contenido_empaque) || 1) && equivEmpaque(m.cantidad, m) ? `<div class="cell-sub">≈ ${esc(equivEmpaque(m.cantidad, m))}</div>` : ''}`) },
      { label: 'Existencia resultante', cls: 'num', render: (m) => existenciaHTML(m.existencia_resultante, m) },
      { label: 'Referencia', render: (m) => (m.cita_folio ? `<span class="mono">${esc(m.cita_folio)}</span>` : `<span class="cell-sub">${esc(m.motivo || '—')}</span>`) },
      { label: 'Usuario', render: (m) => `<span class="cell-sub">${esc(m.usuario)}</span>` },
    ],
    empty: { ico: 'arrow-left-right', title: 'Sin movimientos', text: 'Las entradas, salidas, ajustes y dispensaciones aparecerán aquí.' },
    fetch: async ({ from, to, sort, filters: f }) => {
      let q = sb.from('v_movimientos_med').select('*', { count: 'exact' });
      const s = sanitizeSearch(f.q);
      if (s) q = q.or(`medicamento.ilike.*${s}*,lote.ilike.*${s}*,cita_folio.ilike.*${s}*,clave.ilike.*${s}*`);
      if (f.tipo) q = q.eq('tipo', f.tipo);
      if (f.desde) q = q.gte('created_at', dayStartTs(f.desde));
      if (f.hasta) q = q.lt('created_at', dayEndTs(f.hasta));
      if (f.lote) q = q.eq('lote_id', f.lote);
      const { data, count } = must(await paged(q, { from, to, sort }));
      return { rows: data, count };
    },
  });
}

async function onClick(e) {
  const t = e.target.closest('[data-tab]');
  if (t) { history.replaceState(null, '', `#/inventario?tab=${t.dataset.tab}`); showTab(t.dataset.tab); return; }
  const i = e.target.closest('[data-i]');
  if (i) {
    if (i.dataset.i === 'exportar-reabasto') { exportarReabasto(); return; }
    if (i.dataset.i === 'reabasto-retry') { renderReabasto(); return; }
    if (i.dataset.i === 'nuevo-med' && await openMedicamentoForm()) refresh();
    if (i.dataset.i === 'entrada' && await openEntrada()) refresh();
    if (i.dataset.i === 'salida' && await openSalida()) refresh();
    return;
  }
  const ia = e.target.closest('[data-ia]');
  if (ia) {
    const m = tStock.row(ia.dataset.id);
    if (!m) return;
    try {
      switch (ia.dataset.ia) {
        case 'entrada': if (await openEntrada(m.id)) refresh(); break;
        case 'editar': if (await openMedicamentoForm(m)) refresh(); break;
        case 'lotes':
          root.querySelector('#l-q').value = m.clave; root.querySelector('#l-exist').value = '';
          await showTab('lotes'); break;
        case 'toggle': {
          const ok = await confirmDialog({ title: m.activo ? 'Desactivar medicamento' : 'Activar medicamento', danger: m.activo,
            message: m.activo ? `${m.nombre} no se podrá registrar en entradas ni dispensar. Su historial se conserva.` : `${m.nombre} volverá a estar disponible.`,
            confirmText: m.activo ? 'Desactivar' : 'Activar' });
          if (!ok) return;
          must(await sb.from('medicamentos_med').update({ activo: !m.activo }).eq('id', m.id).select('id').single());
          toast('Medicamento actualizado.', 'success'); refresh(); break;
        }
        case 'eliminar': {
          const ok = await confirmDialog({ title: 'Eliminar medicamento', danger: true, confirmText: 'Eliminar',
            message: `¿Eliminar ${m.nombre} del catálogo? Solo es posible si nunca tuvo lotes ni movimientos; de lo contrario, desactívalo.` });
          if (!ok) return;
          const { error, count } = await sb.from('medicamentos_med').delete({ count: 'exact' }).eq('id', m.id);
          if (error) throw error;
          if (!count) throw new Error('No se pudo eliminar el registro.');
          toast('Medicamento eliminado.', 'success'); refresh(); break;
        }
        default: break;
      }
    } catch (err) { toast(errMsg(err), 'error'); }
    return;
  }
  const la = e.target.closest('[data-la]');
  if (la) {
    const l = tLotes.row(la.dataset.id);
    if (!l) return;
    if (la.dataset.la === 'uso' && await openUso(l)) refresh();
    if (la.dataset.la === 'salida' && await openSalida(l)) refresh();
    if (la.dataset.la === 'ajuste' && await openAjuste(l)) refresh();
    if (la.dataset.la === 'historial') {
      root.querySelector('#m-q').value = l.lote;
      await showTab('movs');
    }
  }
}

function refresh() {
  if (tab === 'stock') tStock?.load();
  if (tab === 'lotes') tLotes?.load();
  if (tab === 'movs') tMovs?.load();
  if (tab === 'reabasto') renderReabasto();
}

// ---------- Formularios ----------
async function openMedicamentoForm(m = null) {
  return openModal({
    title: m ? 'Editar artículo' : 'Nuevo artículo', submitText: m ? 'Guardar cambios' : 'Registrar', size: 'lg',
    body: `
      <div class="form-grid">
        <div class="field"><label for="md-cat">Categoría <span class="req">*</span></label>
          <select id="md-cat" name="categoria" required>${Object.entries(CATEGORIAS).map(([k, v]) => `<option value="${k}" ${(m?.categoria || 'medicamento') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <small class="hint">El equipo no se entrega en consultas ni genera alertas.</small></div>
        <div class="field"><label for="md-ctrl">Cómo se controla <span class="req">*</span></label>
          <select id="md-ctrl" name="control" required>
            <option value="pieza" ${m?.control !== 'envase' ? 'selected' : ''}>Por pieza (se cuenta: tabletas, jeringas…)</option>
            <option value="envase" ${m?.control === 'envase' ? 'selected' : ''}>Por envase (gel, crema, frasco, aerosol, rollo…)</option></select>
          <small class="hint">Por envase: se registra cuánto queda del envase abierto en cada uso y se descuenta al terminarse.</small></div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="md-clave">Clave <span class="req">*</span></label>
          <input id="md-clave" name="clave" required maxlength="30" autocomplete="off" value="${esc(m?.clave || '')}" placeholder="Ej. PARA-500">
          <small class="hint">Identificador interno único.</small></div>
        <div class="field"><label for="md-nombre">Nombre y concentración <span class="req">*</span></label>
          <input id="md-nombre" name="nombre" required minlength="2" maxlength="120" value="${esc(m?.nombre || '')}" placeholder="Ej. Paracetamol 500 mg"></div>
      </div>
      <fieldset><legend>Doble unidad de control</legend>
        <div class="form-grid">
          <div class="field"><label for="md-unidad">Unidad mínima <span class="req">*</span></label>
            <input id="md-unidad" name="unidad" required maxlength="30" list="md-unidades" value="${esc(m?.unidad || 'tableta')}">
            <datalist id="md-unidades">${UNIDADES.map((u) => `<option value="${u}">`).join('')}</datalist>
            <small class="hint">Lo que se entrega al paciente: tableta, cápsula, ml (aproximado en líquidos)…</small></div>
          <div class="field"><label for="md-empaque">Empaque <span class="req">*</span></label>
            <input id="md-empaque" name="empaque" required maxlength="30" list="md-empaques" value="${esc(m?.empaque || 'caja')}">
            <datalist id="md-empaques">${EMPAQUES.map((u) => `<option value="${u}">`).join('')}</datalist>
            <small class="hint">Como se compra o almacena: caja, frasco, bote…</small></div>
          <div class="field"><label for="md-cont">Contenido por empaque <span class="req">*</span></label>
            <input id="md-cont" name="contenido_empaque" type="number" inputmode="numeric" min="1" max="100000" step="1" required value="${esc(m?.contenido_empaque ?? 1)}">
            <small class="hint" id="md-cont-hint"></small></div>
          <div class="field"><label for="md-min">Stock mínimo (en unidad mínima) <span class="req">*</span></label>
            <input id="md-min" name="stock_minimo" type="number" inputmode="numeric" min="0" max="1000000" step="1" required value="${esc(m?.stock_minimo ?? 0)}">
            <small class="hint" id="md-min-hint"></small></div>
        </div>
      </fieldset>
      <div class="field"><label for="md-pres">Descripción de la presentación</label>
        <input id="md-pres" name="presentacion" maxlength="120" value="${esc(m?.presentacion || '')}" placeholder="Ej. Caja con 2 blísteres de 10 tabletas"></div>`,
    onOpen: ({ form }) => {
      const upd = () => {
        const mm = { unidad: form.elements.unidad.value || 'unidad', empaque: form.elements.empaque.value || 'empaque', contenido_empaque: Number(form.elements.contenido_empaque.value) || 1 };
        form.querySelector('#md-cont-hint').textContent = `1 ${mm.empaque} = ${cantUnidad(mm.contenido_empaque, mm.unidad)}`;
        const min = Number(form.elements.stock_minimo.value) || 0;
        const eq = equivEmpaque(min, mm);
        form.querySelector('#md-min-hint').textContent = min ? `Alerta por debajo de ${cantUnidad(min, mm.unidad)}${eq ? ` (≈ ${eq})` : ''}.` : 'Sin alerta de stock mínimo.';
      };
      form.addEventListener('input', upd); upd();
    },
    onSubmit: async ({ form }) => {
      if (!checkForm(form)) return false;
      const v = formValues(form);
      const payload = {
        clave: v.clave, nombre: v.nombre, unidad: v.unidad, empaque: v.empaque, contenido_empaque: Number(v.contenido_empaque),
        presentacion: nullIfEmpty(v.presentacion), stock_minimo: Number(v.stock_minimo),
        categoria: v.categoria, control: v.control,
      };
      // Por envase la unidad es el propio envase (tubo, frasco…)
      if (v.control === 'envase') { payload.unidad = v.empaque; payload.contenido_empaque = 1; }
      if (m) must(await sb.from('medicamentos_med').update(payload).eq('id', m.id).select('id').single());
      else must(await sb.from('medicamentos_med').insert(payload).select('id').single());
      toast(m ? 'Artículo actualizado.' : 'Artículo registrado.', 'success');
    },
  });
}

export async function openEntrada(medId = null) {
  let meds;
  try {
    meds = must(await sb.from('medicamentos_med').select('id, clave, nombre, unidad, empaque, contenido_empaque, categoria, control').eq('activo', true).order('nombre')).data;
  } catch (err) { toast(errMsg(err), 'error'); return false; }
  if (!meds.length) { toast('Primero registra un artículo activo en el catálogo.', 'warning'); return false; }
  const manana = addDays(todayISO(), 1);
  let lotes = [], cap = null;
  const medSel = (form) => meds.find((x) => x.id === form.elements.medicamento.value) || null;
  return openModal({
    title: 'Registrar entrada', subtitle: 'Ingresa existencias por lote. Si el lote ya existe, se suma a su existencia.',
    submitText: 'Registrar entrada', size: 'lg',
    body: `
      <div class="form-grid">
        <div class="field full"><label for="en-med">Artículo <span class="req">*</span></label>
          <select id="en-med" name="medicamento" required><option value="">Selecciona…</option>
            ${meds.map((m) => `<option value="${esc(m.id)}" ${m.id === medId ? 'selected' : ''}>${esc(m.nombre)} · ${esc(m.clave)}</option>`).join('')}</select></div>
        <div class="field"><label for="en-lote">Lote <span class="req" id="en-lote-req">*</span></label>
          <input id="en-lote" name="lote" required maxlength="40" autocomplete="off" list="en-lotes" placeholder="Número de lote del fabricante">
          <datalist id="en-lotes"></datalist>
          <small class="hint" id="en-lote-hint"></small></div>
        <div class="field"><label for="en-cad">Caducidad <span class="req" id="en-cad-req">*</span></label>
          <input id="en-cad" name="caducidad" type="date" required min="${manana}">
          <small class="hint" id="en-cad-hint"></small></div>
        <div class="field full"><label>Capturar cantidad</label><div id="en-modo-wrap"><span class="hint">Selecciona un artículo.</span></div></div>
        <div class="field"><label for="en-cant">Cantidad <span class="req">*</span></label>
          <input id="en-cant" name="cantidad" type="number" inputmode="numeric" min="1" max="100000" step="1" required>
          <small class="hint" data-total="cantidad"></small></div>
      </div>`,
    onOpen: ({ form }) => {
      const sel = form.elements.medicamento, lote = form.elements.lote, cad = form.elements.caducidad;
      const hint = form.querySelector('#en-lote-hint');
      const setModo = () => {
        const m = medSel(form);
        const esMed = !m || m.categoria === 'medicamento';
        // Insumos y equipo: lote y caducidad opcionales
        lote.required = esMed; cad.required = esMed;
        form.querySelector('#en-lote-req').hidden = !esMed;
        form.querySelector('#en-cad-req').hidden = !esMed;
        lote.placeholder = esMed ? 'Número de lote del fabricante' : 'Opcional (si no tiene, se registra S/N)';
        form.querySelector('#en-cad-hint').textContent = esMed ? '' : 'Opcional: déjala vacía si no caduca.';
        form.querySelector('#en-modo-wrap').innerHTML = capturaHTML('en-modo', m);
        if (!cap) cap = bindCaptura(form, 'en-modo', 'cantidad', () => medSel(form));
        else cap.reset();
      };
      const loadLotes = async () => {
        setModo();
        lotes = [];
        form.querySelector('#en-lotes').innerHTML = '';
        if (!sel.value) return;
        const { data } = await sb.from('lotes_med').select('lote, caducidad').eq('medicamento_id', sel.value).order('caducidad', { ascending: false }).limit(50);
        lotes = data || [];
        form.querySelector('#en-lotes').innerHTML = lotes.map((l) => `<option value="${esc(l.lote)}">${l.caducidad ? `Cad. ${fmtDate(l.caducidad)}` : 'Sin caducidad'}</option>`).join('');
        checkLote();
      };
      const checkLote = () => {
        const ex = lotes.find((l) => l.lote.toLowerCase() === lote.value.trim().toLowerCase());
        if (ex) { cad.value = ex.caducidad || ''; cad.readOnly = true; hint.textContent = `Lote existente (${ex.caducidad ? `cad. ${fmtDate(ex.caducidad)}` : 'sin caducidad'}): la cantidad se sumará.`; }
        else { if (cad.readOnly) cad.value = ''; cad.readOnly = false; hint.textContent = ''; }
      };
      sel.addEventListener('change', loadLotes);
      lote.addEventListener('input', checkLote);
      loadLotes();
    },
    onSubmit: async ({ form, setError }) => {
      if (!checkForm(form, { caducidad: (v) => (v && v < manana && !form.elements.caducidad.readOnly ? 'La caducidad debe ser posterior a hoy.' : '') })) return false;
      const v = formValues(form);
      const m = medSel(form);
      const total = cap.total();
      if (!total) { setError('Indica cuántas unidades trae cada empaque.'); return false; }
      if (total > 100000) { setError(`El total (${cantUnidad(total, m.unidad)}) excede el máximo de 100,000 por movimiento.`); return false; }
      const lote = await sb.rpc('med_registrar_entrada', {
        p_medicamento: v.medicamento, p_lote: v.lote, p_caducidad: v.caducidad || null, p_cantidad: total, p_motivo: null,
      });
      must(lote);
      // Se recuerda el contenido por empaque capturado para la próxima vez
      if (cap.modo() === 'empaque' && cap.contenido() !== Number(m.contenido_empaque)) {
        await sb.from('medicamentos_med').update({ contenido_empaque: cap.contenido() }).eq('id', m.id);
      }
      const det = cap.modo() === 'empaque' ? ` (${fmtNum(Number(v.cantidad))} ${plural(m.empaque, Number(v.cantidad))} de ${fmtNum(cap.contenido())})` : '';
      toast(`Entrada registrada: ${cantUnidad(total, m.unidad)}${det}.`, 'success', 6000);
    },
  });
}

const MOTIVOS_SALIDA = ['Merma o daño', 'Caducado / destrucción', 'Entrega sin cita', 'Devolución a proveedor', 'Otro'];
// Salida: si no se recibe el lote, se elige artículo y lote en el mismo formulario
async function openSalida(l0 = null) {
  let lotes = l0 ? [l0] : null;
  if (!lotes) {
    try {
      lotes = must(await sb.from('v_lotes_med').select('*').gt('existencia', 0).order('medicamento').order('caducidad', { nullsFirst: false })).data;
    } catch (err) { toast(errMsg(err), 'error'); return false; }
    if (!lotes.length) { toast('No hay lotes con existencia para registrar una salida.', 'warning'); return false; }
  }
  const meds = [...new Map(lotes.map((l) => [l.medicamento_id, l.medicamento])).entries()];
  let cap = null;
  const loteSel = (form) => (l0 || lotes.find((l) => l.id === form.elements.lote.value) || null);
  const loteTxt = (l) => `${l.lote} · ${l.caducidad ? `cad. ${fmtDate(l.caducidad)}` : 'sin caducidad'} · ${cantUnidad(l.existencia, l.unidad)} disponibles${l.estado_caducidad === 'caducado' ? ' · CADUCADO' : ''}`;
  return openModal({
    title: 'Registrar salida', subtitle: l0 ? `${l0.medicamento} · Lote ${l0.lote}` : 'Elige el artículo, el lote y la cantidad que sale.',
    submitText: 'Registrar salida', danger: true,
    body: `
      ${l0 ? '' : `<div class="form-grid">
        <div class="field"><label for="sa-med">Artículo <span class="req">*</span></label>
          <select id="sa-med" name="med" required><option value="">Selecciona…</option>
            ${meds.map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join('')}</select></div>
        <div class="field"><label for="sa-lote">Lote <span class="req">*</span></label>
          <select id="sa-lote" name="lote" required disabled><option value="">—</option></select>
          <small class="hint">Se propone primero el lote que caduca antes.</small></div>
      </div>`}
      <div class="notice" id="sa-disp" ${l0 ? '' : 'hidden'}>${l0 ? `${icon('package')}<span>Disponible: <b>${esc(loteTxt(l0))}</b></span>` : ''}</div>
      <div class="notice warn" id="sa-cad" ${l0?.estado_caducidad === 'caducado' ? '' : 'hidden'}>${icon('alert-triangle')}<span>Este lote está caducado. Regístralo como “Caducado / destrucción”.</span></div>
      <div class="field"><label>Capturar cantidad</label><div id="sa-modo-wrap">${capturaHTML('sa-modo', l0)}</div></div>
      <div class="form-grid">
        <div class="field"><label for="sa-cant">Cantidad <span class="req">*</span></label>
          <input id="sa-cant" name="cantidad" type="number" inputmode="numeric" min="1" step="1" required>
          <small class="hint" data-total="cantidad"></small></div>
        <div class="field"><label for="sa-tipo">Motivo <span class="req">*</span></label>
          <select id="sa-tipo" name="tipo" required><option value="">Selecciona…</option>
            ${MOTIVOS_SALIDA.map((m) => `<option ${l0?.estado_caducidad === 'caducado' && m.startsWith('Caducado') ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
        <div class="field full"><label for="sa-det">Detalle</label>
          <textarea id="sa-det" name="detalle" maxlength="250" data-counter placeholder="Describe brevemente la salida"></textarea></div>
      </div>`,
    onOpen: ({ form }) => {
      bindCounters(form);
      cap = bindCaptura(form, 'sa-modo', 'cantidad', () => loteSel(form), () => loteSel(form)?.existencia ?? null);
      if (l0) return;
      const pintaLote = () => {
        const l = loteSel(form);
        const disp = form.querySelector('#sa-disp');
        disp.hidden = !l;
        disp.innerHTML = l ? `${icon('package')}<span>Disponible: <b>${esc(loteTxt(l))}</b></span>` : '';
        form.querySelector('#sa-cad').hidden = l?.estado_caducidad !== 'caducado';
        if (l?.estado_caducidad === 'caducado') form.elements.tipo.value = 'Caducado / destrucción';
        form.querySelector('#sa-modo-wrap').innerHTML = capturaHTML('sa-modo', l);
        cap.reset(); refreshIcons();
      };
      form.elements.med.addEventListener('change', () => {
        const ls = lotes.filter((l) => l.medicamento_id === form.elements.med.value);
        form.elements.lote.innerHTML = ls.map((l) => `<option value="${esc(l.id)}">${esc(loteTxt(l))}</option>`).join('') || '<option value="">—</option>';
        form.elements.lote.disabled = !ls.length;
        pintaLote();
      });
      form.elements.lote.addEventListener('change', pintaLote);
    },
    onSubmit: async ({ form, setError }) => {
      if (!checkForm(form, { detalle: (v, f) => (f.tipo.value === 'Otro' && !v ? 'Describe el motivo de la salida.' : '') })) return false;
      const v = formValues(form);
      const l = loteSel(form);
      const total = cap.total();
      if (!total) { setError('Indica cuántas unidades trae cada empaque.'); return false; }
      if (total > l.existencia) { setError(`Solo hay ${cantUnidad(l.existencia, l.unidad)} en este lote.`); return false; }
      must(await sb.rpc('med_registrar_salida', { p_lote: l.id, p_cantidad: total, p_motivo: v.detalle ? `${v.tipo}: ${v.detalle}` : v.tipo }));
      toast(`Salida registrada: ${cantUnidad(total, l.unidad)} de ${l.medicamento}.`, 'success');
    },
  });
}

// Uso de un envase (gel, crema, frasco…): se registra cuánto queda; al terminarse se descuenta
export function nivelesHTML(name, actual = null) {
  return `<div class="nivel-seg" role="radiogroup" aria-label="Cuánto queda del envase">
    ${[100, 75, 50, 25].map((n) => `<label><input type="radio" name="${name}" value="${n}" required ${actual === n ? 'checked' : ''}><span>${NIVELES[n]}</span></label>`).join('')}
    <label class="fin"><input type="radio" name="${name}" value="0" required><span>Se terminó</span></label></div>`;
}
async function openUso(l) {
  return openModal({
    title: 'Registrar uso del envase', subtitle: `${l.medicamento} · Lote ${l.lote} · ${cantUnidad(l.existencia, l.unidad)}`,
    submitText: 'Registrar uso', size: 'sm',
    body: `
      <div class="notice">${icon('droplet')}<span>${l.nivel ? `El envase abierto tenía: <b>${esc(NIVELES[l.nivel])}</b>.` : 'Aún no hay un envase abierto en este lote.'} Marca cuánto queda después de usarlo. Si se terminó, se descuenta 1 ${esc(l.unidad)} del inventario.</span></div>
      <div class="field"><label>¿Cuánto queda del envase? <span class="req">*</span></label>${nivelesHTML('nivel', l.nivel)}</div>
      <div class="field"><label for="us-det">Detalle</label>
        <input id="us-det" name="detalle" maxlength="250" placeholder="Opcional. Ej. curación en área de producción"></div>`,
    onSubmit: async ({ form, setError }) => {
      const n = form.querySelector('input[name="nivel"]:checked');
      if (!n) { setError('Indica cuánto queda del envase.'); return false; }
      must(await sb.rpc('med_registrar_uso', { p_lote: l.id, p_nivel: Number(n.value), p_motivo: nullIfEmpty(form.elements.detalle.value.trim()) }));
      toast(n.value === '0' ? `Envase terminado: se descontó 1 ${l.unidad}.` : 'Uso registrado.', 'success');
    },
  });
}

async function openAjuste(l) {
  return openModal({
    title: 'Ajuste por conteo físico', subtitle: `${l.medicamento} · Lote ${l.lote}`, submitText: 'Aplicar ajuste',
    body: `
      <div class="notice">${icon('info')}<span>Existencia registrada: <b>${esc(cantUnidad(l.existencia, l.unidad))}</b>${equivEmpaque(l.existencia, l) ? ` (≈ ${esc(equivEmpaque(l.existencia, l))})` : ''}. Captura lo contado físicamente en <b>${esc(plural(l.unidad, 2))}</b>; el sistema registrará la diferencia como ajuste.</span></div>
      <div class="form-grid">
        <div class="field"><label for="aj-fis">Existencia física (${esc(plural(l.unidad, 2))}) <span class="req">*</span></label>
          <input id="aj-fis" name="fisica" type="number" inputmode="numeric" min="0" max="100000" step="1" required>
          <small class="hint" id="aj-eq"></small></div>
        <div class="field"><label>Diferencia</label><input id="aj-dif" disabled value="—"></div>
        <div class="field full"><label for="aj-mot">Motivo del ajuste <span class="req">*</span></label>
          <textarea id="aj-mot" name="motivo" required maxlength="300" data-counter placeholder="Ej. inventario físico mensual"></textarea></div>
      </div>`,
    onOpen: ({ form }) => {
      bindCounters(form);
      form.elements.fisica.addEventListener('input', () => {
        const raw = form.elements.fisica.value;
        const n = raw === '' ? null : Number(raw) - l.existencia;
        form.querySelector('#aj-dif').value = n === null ? '—' : `${n > 0 ? '+' : ''}${fmtNum(n)} ${plural(l.unidad, n)}`;
        const eq = raw === '' ? '' : equivEmpaque(Number(raw), l);
        form.querySelector('#aj-eq').textContent = eq ? `≈ ${eq}` : '';
      });
    },
    onSubmit: async ({ form }) => {
      if (!checkForm(form, { fisica: (v) => (Number(v) === l.existencia ? 'Es igual a la existencia registrada; no hay ajuste.' : '') })) return false;
      const v = formValues(form);
      must(await sb.rpc('med_ajustar_lote', { p_lote: l.id, p_existencia_fisica: Number(v.fisica), p_motivo: v.motivo }));
      toast('Ajuste aplicado.', 'success');
    },
  });
}
