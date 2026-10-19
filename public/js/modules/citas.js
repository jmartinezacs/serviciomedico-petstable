// =====================================================================
// Citas: lista filtrable, agenda diaria, solicitud/reprogramación,
// confirmación, atención (con dispensación), inasistencia y cancelación.
// Las reglas se validan en la base de datos (trigger med_validar_cita y
// RPC med_atender_cita); la interfaz solo anticipa los mismos criterios.
// =====================================================================
import {
  sb, state, esc, icon, refreshIcons, toast, errMsg, openModal, confirmDialog, checkForm, formValues,
  nullIfEmpty, bindCounters, todayISO, nowHHMM, addDays, isWeekday, fmtDate, fmtTime, fmtDateTime,
  fmtLongDate, fmtNum, SLOTS, MOTIVOS, ESTADOS, estadoPill, pill, DataTable, paged, sanitizeSearch,
  debounce, emptyState, errorState, getAreas, must, fieldError, cantUnidad, plural, avisar,
  getBloqueos, bloqueoDe, bloqueoTxt, isoDow, ganchos,
} from '../core.js';
import { openColaboradorForm } from './colaboradores.js';
import { nivelesHTML } from './inventario.js';

let root, table, agendaDate, agendaToken = 0;

export default {
  async render(el, params = {}) {
    root = el;
    const admin = state.isAdmin;
    const vista = ['agenda', 'semana'].includes(params.vista) ? params.vista : 'lista';
    el.innerHTML = `
      <section class="page-intro">
        <div><span class="eyebrow">Citas médicas</span>
          <h1>${admin ? 'Citas' : 'Mis citas'}</h1>
          <p>${admin ? 'Solicitudes, confirmaciones y atención del servicio médico.' : 'Citas que has solicitado para ti o para colaboradores.'}</p></div>
        <div class="page-actions">
          ${admin ? `<button class="btn secondary" data-c="bloqueos">${icon('calendar-off')} Días sin servicio</button>` : ''}
          <button class="btn primary" data-c="nueva">${icon('calendar-plus')} ${admin ? 'Nueva cita' : 'Solicitar cita'}</button>
        </div>
      </section>
      <div class="tabs" role="tablist">
        <button role="tab" data-tab="lista" class="${vista === 'lista' ? 'active' : ''}">${icon('list')} Lista</button>
        <button role="tab" data-tab="agenda" class="${vista === 'agenda' ? 'active' : ''}">${icon('calendar-range')} Agenda del día</button>
        <button role="tab" data-tab="semana" class="${vista === 'semana' ? 'active' : ''}">${icon('calendar-days')} Semana</button>
      </div>
      <div id="tab-lista" class="${vista === 'lista' ? '' : 'hidden'}">
        <div class="card">
          <div class="toolbar">
            <div class="search">${icon('search')}<input type="search" id="f-q" placeholder="Buscar folio, colaborador o No. empleado" aria-label="Buscar"></div>
            <select id="f-estado" aria-label="Estado"><option value="">Todos los estados</option>
              ${Object.entries(ESTADOS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
            <select id="f-area" aria-label="Área"><option value="">Todas las áreas</option></select>
            <select id="f-motivo" aria-label="Motivo"><option value="">Todos los motivos</option>
              ${Object.entries(MOTIVOS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
            <span class="date-range"><input type="date" id="f-desde" aria-label="Desde"> a <input type="date" id="f-hasta" aria-label="Hasta"></span>
            <button class="btn ghost" data-c="limpiar">${icon('filter-x')} Limpiar</button>
          </div>
          <div id="citas-table"></div>
        </div>
      </div>
      <div id="tab-agenda" class="${vista === 'agenda' ? '' : 'hidden'}"><div class="card" id="agenda-card"></div></div>
      <div id="tab-semana" class="${vista === 'semana' ? '' : 'hidden'}"><div class="card" id="semana-card"></div></div>`;

    table = new DataTable(el.querySelector('#citas-table'), {
      columns: columns(),
      sort: { key: 'fecha', asc: false },
      empty: { ico: 'calendar', title: admin ? 'Aún no hay citas' : 'Aún no has solicitado citas',
        text: 'Las citas se agendan de lunes a viernes de 9:00 a 17:30 en bloques de 20 minutos. Para urgencias usa la opción Cita de urgencia.',
        action: `<button class="btn primary" data-c="nueva">${icon('calendar-plus')} ${admin ? 'Nueva cita' : 'Solicitar cita'}</button>` },
      fetch: fetchCitas,
    });

    // Filtros
    const f = (id) => el.querySelector(id);
    if (params.estado && ESTADOS[params.estado]) f('#f-estado').value = params.estado;
    const apply = () => table.setFilters({
      q: f('#f-q').value, estado: f('#f-estado').value, area: f('#f-area').value, motivo: f('#f-motivo').value,
      desde: f('#f-desde').value, hasta: f('#f-hasta').value,
    });
    f('#f-q').addEventListener('input', debounce(apply, 350));
    ['#f-estado', '#f-area', '#f-motivo', '#f-desde', '#f-hasta'].forEach((s) => f(s).addEventListener('change', apply));
    getAreas().then((areas) => {
      f('#f-area').insertAdjacentHTML('beforeend', areas.map((a) => `<option value="${esc(a.id)}">${esc(a.nombre)}</option>`).join(''));
    }).catch(() => {});

    el.addEventListener('click', onClick);
    agendaDate = params.fecha && /^\d{4}-\d{2}-\d{2}$/.test(params.fecha) ? params.fecha : todayISO();
    if (vista === 'agenda') await renderAgenda(); else if (vista === 'semana') await renderSemana(); else await apply();
  },
  destroy() { agendaToken++; semanaToken++; root = null; table = null; },
};

function columns() {
  const cols = [
    { label: 'Folio', sort: 'folio', render: (c) => `<span class="cell-main mono">${esc(c.folio_txt)}</span>` },
    { label: 'Fecha', sort: 'fecha', render: (c) => `<div class="cell-main">${fmtDate(c.fecha)}</div><div class="cell-sub mono">${horaTxt(c)}</div>` },
    { label: 'Colaborador', sort: 'colaborador', render: (c) => `<div class="cell-main">${esc(c.colaborador)}</div><div class="cell-sub">${esc([c.num_empleado, c.area].filter(Boolean).join(' · '))}</div>` },
    { label: 'Motivo', render: (c) => esc(MOTIVOS[c.motivo] || c.motivo) },
    { label: 'Estado', sort: 'estado', render: (c) => `${estadoPill(c.estado)}${c.tipo === 'urgente' ? ` ${pill('Urgente', 'bad')}` : ''}` },
  ];
  if (state.isAdmin) cols.push({ label: 'Solicitó', render: (c) => `<span class="cell-sub">${esc(c.solicitante)}</span>` });
  cols.push({ label: 'Acciones', cls: 'actions', render: (c) => actionsHTML(c) });
  return cols;
}

async function fetchCitas({ from, to, sort, filters: f }) {
  let q = sb.from('v_citas_med').select('id, folio, folio_txt, fecha, hora, colaborador, num_empleado, area, motivo, descripcion, estado, solicitante, solicitado_por, tipo', { count: 'exact' });
  if (f.tipo) q = q.eq('tipo', f.tipo);
  const s = sanitizeSearch(f.q);
  if (s) q = q.or(`colaborador.ilike.*${s}*,folio_txt.ilike.*${s}*,num_empleado.ilike.*${s}*`);
  if (f.estado) q = q.eq('estado', f.estado);
  if (f.area) q = q.eq('area_id', f.area);
  if (f.motivo) q = q.eq('motivo', f.motivo);
  if (f.desde) q = q.gte('fecha', f.desde);
  if (f.hasta) q = q.lte('fecha', f.hasta);
  const second = sort?.key === 'fecha' ? [['hora', sort.asc]] : [['fecha', false], ['hora', false]];
  const { data, count } = must(await paged(q, { from, to, sort }, second));
  return { rows: data, count };
}

// Hora a mostrar: las urgencias sin horario asignado aparecen "Por asignar"
export function horaTxt(c) { return c.hora ? `${fmtTime(c.hora)} h` : 'Por asignar'; }

// ---------- Acciones disponibles según rol y estado ----------
function availableActions(c) {
  const hoy = todayISO();
  const abierta = c.estado === 'pendiente' || c.estado === 'confirmada';
  const own = c.solicitado_por === state.profile.id;
  const urg = c.tipo === 'urgente';
  const acts = [];
  // Solo el médico (servicio.medico) gestiona la cita; los demás, como solicitantes
  if (state.isMedico) {
    if (c.estado === 'pendiente') acts.push(urg ? ['asignar', 'clock-plus', 'Asignar horario especial y confirmar', 'fill-ok'] : ['confirmar', 'check', 'Confirmar', 'fill-ok']);
    if (abierta && c.fecha <= hoy) acts.push(['atender', 'stethoscope', 'Registrar atención', 'ok']);
    if (abierta) acts.push(urg ? ['asignar', 'calendar-clock', 'Cambiar horario', ''] : ['reprogramar', 'calendar-clock', 'Reprogramar', '']);
    if (abierta && c.fecha <= hoy) acts.push(['no_asistio', 'user-x', 'No asistió', 'fill-red']);
    if (abierta) acts.push(['cancelar', 'x-circle', c.estado === 'pendiente' ? 'Rechazar' : 'Cancelar', 'bad']);
    if (c.estado === 'no_asistio') acts.push(['reabrir', 'rotate-ccw', 'Reabrir (sí asistió)', '']);
  } else if (own) {
    if (c.estado === 'pendiente' && !urg) acts.push(['reprogramar', 'calendar-clock', 'Modificar', '']);
    if (abierta) acts.push(['cancelar', 'x-circle', 'Cancelar', 'bad']);
  }
  if (c.estado === 'atendida' && (state.isMedico || own)) acts.push(['constancia', 'printer', 'Constancia de atención', '']);
  // Evita duplicar "asignar" (pendiente urgente)
  return acts.filter((a, i, arr) => arr.findIndex((b) => b[0] === a[0]) === i);
}
function actionsHTML(c) {
  const btns = [['ver', 'eye', 'Ver detalle', ''], ...availableActions(c)];
  return `<div class="row-actions">${btns.map(([a, ic, t, cls]) =>
    `<button class="icon-btn ${cls}" data-act="${a}" data-id="${esc(c.id)}" title="${esc(t)}" aria-label="${esc(t)}">${icon(ic)}</button>`).join('')}</div>`;
}

async function onClick(e) {
  const c = e.target.closest('[data-c]');
  if (c) {
    if (c.dataset.c === 'nueva') { if (await openCitaForm()) reload(); }
    else if (c.dataset.c === 'bloqueos') { await openBloqueos(); reload(); }
    else if (c.dataset.c === 'limpiar') {
      root.querySelectorAll('#tab-lista .toolbar input, #tab-lista .toolbar select').forEach((i) => { i.value = ''; });
      table.setFilters({ q: '', estado: '', area: '', motivo: '', desde: '', hasta: '' });
    } else if (c.dataset.c === 'agenda-prev') { agendaDate = stepWeekday(agendaDate, -1); renderAgenda(); }
    else if (c.dataset.c === 'agenda-next') { agendaDate = stepWeekday(agendaDate, 1); renderAgenda(); }
    else if (c.dataset.c === 'agenda-hoy') { agendaDate = todayISO(); renderAgenda(); }
    else if (c.dataset.c === 'agenda-retry') renderAgenda();
    else if (c.dataset.c === 'agendar') { if (await openCitaForm({ fecha: c.dataset.fecha || agendaDate, hora: c.dataset.hora })) reload(); }
    else if (c.dataset.c === 'semana-prev') { agendaDate = addDays(lunesDe(agendaDate), -7); renderSemana(); }
    else if (c.dataset.c === 'semana-next') { agendaDate = addDays(lunesDe(agendaDate), 7); renderSemana(); }
    else if (c.dataset.c === 'semana-hoy') { agendaDate = todayISO(); renderSemana(); }
    else if (c.dataset.c === 'semana-retry') renderSemana();
    else if (c.dataset.c === 'ver-dia') {
      agendaDate = c.dataset.fecha;
      root.querySelector('[data-tab="agenda"]').click();
    }
    return;
  }
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === tab));
    const v = tab.dataset.tab;
    ['lista', 'agenda', 'semana'].forEach((k) => root.querySelector(`#tab-${k}`).classList.toggle('hidden', k !== v));
    history.replaceState(null, '', v === 'lista' ? '#/citas' : `#/citas?vista=${v}`);
    if (v === 'agenda') renderAgenda(); else if (v === 'semana') renderSemana(); else table.load();
    return;
  }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const cita = table?.row(a.dataset.id) || agendaRows.find((r) => r.id === a.dataset.id)
    || semanaRows.find((r) => r.id === a.dataset.id) || { id: a.dataset.id };
  if (await runAction(a.dataset.act, cita)) reload();
}

function reload() {
  if (!root) return;
  if (!root.querySelector('#tab-agenda').classList.contains('hidden')) renderAgenda();
  else if (!root.querySelector('#tab-semana').classList.contains('hidden')) renderSemana();
  else table.load();
}

// Ejecuta una acción; devuelve true si cambió información
export async function runAction(act, c) {
  try {
    switch (act) {
      case 'ver': return await openDetalle(c.id);
      case 'confirmar': {
        must(await sb.from('citas_med').update({ estado: 'confirmada' }).eq('id', c.id).select('id').single());
        avisar('confirmada', c.id);
        toast(`Cita ${c.folio_txt || ''} confirmada.`, 'success'); return true;
      }
      case 'reprogramar': return await openCitaForm({ cita: c });
      case 'asignar': return await openAsignarHorario(c);
      case 'atender': return await openAtender(c);
      case 'no_asistio': {
        const ok = await confirmDialog({ title: 'Marcar inasistencia', message: `¿Confirmas que ${c.colaborador || 'el colaborador'} no asistió a su cita? El horario quedará libre.`, confirmText: 'Marcar inasistencia', danger: true });
        if (!ok) return false;
        must(await sb.from('citas_med').update({ estado: 'no_asistio' }).eq('id', c.id).select('id').single());
        toast('Inasistencia registrada.', 'success'); return true;
      }
      case 'reabrir': {
        const ok = await confirmDialog({ title: 'Reabrir cita', message: `La cita ${c.folio_txt || ''} volverá a quedar confirmada para que puedas registrar la atención. Úsalo si el colaborador sí asistió.`, confirmText: 'Reabrir' });
        if (!ok) return false;
        must(await sb.from('citas_med').update({ estado: 'confirmada' }).eq('id', c.id).select('id').single());
        toast('Cita reabierta. Ya puedes registrar la atención.', 'success'); return true;
      }
      case 'constancia': await imprimirConstancia(c.id); return false;
      case 'cancelar': {
        const rechazo = state.isMedico && c.estado === 'pendiente';
        const r = await confirmDialog({
          title: rechazo ? 'Rechazar solicitud' : 'Cancelar cita', danger: true, confirmText: rechazo ? 'Rechazar' : 'Cancelar cita',
          message: `Se ${rechazo ? 'rechazará la solicitud' : 'cancelará la cita'} ${c.folio_txt || ''} del ${fmtDate(c.fecha)}${c.hora ? ` a las ${fmtTime(c.hora)} h` : ''}. Se avisará a quien la solicitó.`,
          input: { label: rechazo ? 'Motivo del rechazo' : 'Motivo de la cancelación', required: true, maxlength: 300, placeholder: rechazo ? 'Ej. no corresponde a una urgencia; agenda en horario normal' : 'Ej. el colaborador ya no requiere la consulta' },
        });
        if (!r) return false;
        must(await sb.from('citas_med').update({ estado: 'cancelada', motivo_cancelacion: r.value }).eq('id', c.id).select('id').single());
        avisar('cancelada', c.id);
        toast('Cita cancelada.', 'success'); return true;
      }
      default: return false;
    }
  } catch (err) {
    console.error(err);
    toast(errMsg(err), 'error');
    return false;
  }
}

// ---------- Horario especial para citas de urgencia (solo Servicio Médico) ----------
export async function openAsignarHorario(c) {
  if (!c.colaborador) {
    const { data, error } = await sb.from('v_citas_med').select('*').eq('id', c.id).single();
    if (error) { toast(errMsg(error), 'error'); return false; }
    c = data;
  }
  const hoy = todayISO();
  const confirmar = c.estado === 'pendiente';
  return openModal({
    title: confirmar ? 'Asignar horario especial' : 'Cambiar horario', size: 'sm',
    subtitle: `${c.folio_txt} · ${c.colaborador}`,
    submitText: confirmar ? 'Asignar y confirmar' : 'Guardar horario',
    body: `
      <div class="notice warn">${icon('siren')}<span><b>Cita de urgencia.</b> ${esc(c.descripcion || '')}</span></div>
      <div class="form-grid">
        <div class="field"><label for="as-fecha">Fecha <span class="req">*</span></label>
          <input id="as-fecha" name="fecha" type="date" required min="${hoy}" value="${esc(c.fecha >= hoy ? c.fecha : hoy)}"></div>
        <div class="field"><label for="as-hora">Hora <span class="req">*</span></label>
          <input id="as-hora" name="hora" type="time" required step="60" value="${c.hora ? fmtTime(c.hora) : ''}"></div>
      </div>
      <small class="hint" id="as-ocup"></small>`,
    onOpen: ({ form }) => {
      const ver = async () => {
        const f = form.elements.fecha.value; if (!f) return;
        const { data } = await sb.rpc('med_horarios_ocupados', { p_fecha: f });
        const oc = (data || []).map(fmtTime);
        form.querySelector('#as-ocup').textContent = oc.length ? `Horarios ya ocupados ese día: ${oc.join(', ')}.` : 'No hay otras citas ese día.';
      };
      form.elements.fecha.addEventListener('change', ver); ver();
    },
    onSubmit: async ({ form }) => {
      if (!checkForm(form)) return false;
      const v = formValues(form);
      const payload = { fecha: v.fecha, hora: v.hora };
      if (confirmar) payload.estado = 'confirmada';
      must(await sb.from('citas_med').update(payload).eq('id', c.id).select('id').single());
      avisar(confirmar ? 'confirmada' : 'reprogramada', c.id);
      toast(confirmar ? `Cita urgente confirmada para el ${fmtDate(v.fecha)} a las ${v.hora} h.` : 'Horario actualizado.', 'success');
    },
  });
}

// ---------- Agenda ----------
let agendaRows = [];
function stepWeekday(iso, dir) { let d = addDays(iso, dir); while (!isWeekday(d)) d = addDays(d, dir); return d; }

async function renderAgenda() {
  const t = ++agendaToken;
  const card = root?.querySelector('#agenda-card');
  if (!card) return;
  const hoy = todayISO();
  card.innerHTML = `
    <div class="agenda-nav">
      <button class="icon-btn" data-c="agenda-prev" aria-label="Día hábil anterior">${icon('chevron-left')}</button>
      <input type="date" id="agenda-fecha" value="${agendaDate}" aria-label="Fecha">
      <button class="icon-btn" data-c="agenda-next" aria-label="Día hábil siguiente">${icon('chevron-right')}</button>
      <button class="btn secondary" data-c="agenda-hoy">Hoy</button>
      <span class="agenda-day">${esc(fmtLongDate(agendaDate))}</span>
    </div>
    <div id="agenda-body"><div class="skeleton" style="height:48px"></div></div>`;
  card.querySelector('#agenda-fecha').addEventListener('change', (e) => { if (e.target.value) { agendaDate = e.target.value; renderAgenda(); } });
  refreshIcons();
  const body = card.querySelector('#agenda-body');
  if (!isWeekday(agendaDate)) {
    body.innerHTML = emptyState({ ico: 'calendar-off', title: 'Sin servicio en fin de semana', text: 'El servicio médico atiende de lunes a viernes de 9:00 a 17:30.' });
    refreshIcons(); return;
  }
  try {
    const [citasRes, ocupRes, bloqueos] = await Promise.all([
      sb.from('v_citas_med').select('id, folio_txt, fecha, hora, colaborador, num_empleado, area, motivo, descripcion, estado, solicitante, solicitado_por, tipo')
        .eq('fecha', agendaDate).neq('estado', 'cancelada').order('hora'),
      sb.rpc('med_horarios_ocupados', { p_fecha: agendaDate }),
      getBloqueos(agendaDate),
    ]);
    must(citasRes); must(ocupRes);
    if (t !== agendaToken) return;
    agendaRows = citasRes.data;
    const diaBloq = bloqueoDe(bloqueos, agendaDate);
    if (diaBloq && !agendaRows.length) {
      body.innerHTML = emptyState({ ico: 'calendar-off', title: `Sin servicio: ${diaBloq.motivo}`,
        text: state.isAdmin ? 'Puedes quitar o cambiar este bloqueo con el botón Días sin servicio.' : 'Este día no hay consulta. Elige otro día o usa Cita de urgencia.' });
      refreshIcons(); return;
    }
    const ocupados = new Set((ocupRes.data || []).map((h) => fmtTime(h)));
    const now = nowHHMM();
    const rows = SLOTS.map((slot) => {
      const here = agendaRows.filter((c) => c.tipo !== 'urgente' && fmtTime(c.hora) === slot);
      const pasada = agendaDate < hoy || (agendaDate === hoy && slot <= now);
      const libre = !ocupados.has(slot);
      const bloq = bloqueoDe(bloqueos, agendaDate, slot);
      if (bloq && !here.length) {
        return `<div class="agenda-slot blocked"><span class="hora">${slot}</span>
          <div class="who"><b>Sin servicio</b><span>${esc(bloq.motivo)}</span></div><span></span></div>`;
      }
      const puedeAgendar = libre && (state.isMedico ? agendaDate >= hoy : !pasada);
      const citasHTML = here.map((c) => `
        <div class="agenda-slot ${pasada ? 'past' : ''}">
          <span class="hora">${slot}</span>
          <div class="who"><b>${esc(c.colaborador)} ${estadoPill(c.estado)}</b>
            <span>${esc(c.folio_txt)} · ${esc(MOTIVOS[c.motivo] || c.motivo)} · ${esc(c.area)}${state.isAdmin ? ` · Solicitó ${esc(c.solicitante)}` : ''}</span></div>
          ${actionsHTML(c)}
        </div>`).join('');
      const active = here.some((c) => ['pendiente', 'confirmada', 'atendida'].includes(c.estado));
      if (active) return citasHTML;
      if (!libre) {
        return citasHTML + `<div class="agenda-slot ${pasada ? 'past' : ''}"><span class="hora">${slot}</span>
          <div class="who"><b>Ocupado</b><span>Horario reservado</span></div><span></span></div>`;
      }
      return citasHTML + `<div class="agenda-slot free ${pasada ? 'past' : ''}"><span class="hora">${slot}</span>
        <div class="who">${pasada ? 'Horario transcurrido' : 'Disponible'}</div>
        ${puedeAgendar ? `<button class="btn teal" data-c="agendar" data-hora="${slot}">${icon('plus')} Agendar</button>` : '<span></span>'}</div>`;
    });
    const total = agendaRows.filter((c) => c.estado !== 'no_asistio').length;
    const urgentes = agendaRows.filter((c) => c.tipo === 'urgente');
    const urgHTML = urgentes.length ? `<div class="section-title" style="margin-top:0">${icon('siren')} Citas de urgencia / extraordinarias</div>
      <div class="agenda" style="margin-bottom:14px">${urgentes.map((c) => `<div class="agenda-slot urg">
        <span class="hora">${c.hora ? fmtTime(c.hora) : '—'}</span>
        <div class="who"><b>${esc(c.colaborador)} ${estadoPill(c.estado)} ${pill('Urgente', 'bad')}</b>
          <span>${esc(c.folio_txt)} · ${esc(c.hora ? 'Horario especial' : 'Horario por asignar')} · ${esc(c.area)}${state.isAdmin ? ` · Solicitó ${esc(c.solicitante)}` : ''}</span></div>
        ${actionsHTML(c)}</div>`).join('')}</div>` : '';
    const bloqHTML = bloqueos.length ? `<div class="notice warn">${icon('calendar-off')}<span><b>Sin servicio:</b> ${bloqueos.map((b) => `${esc(bloqueoTxt(b))} · ${esc(b.motivo)}`).join('; ')}</span></div>` : '';
    body.innerHTML = `${bloqHTML}${urgHTML}<p class="hint" style="margin:0 0 10px">${fmtNum(ocupados.size)} de ${SLOTS.length} horarios ocupados${state.isAdmin ? '' : ` · ${fmtNum(total)} cita(s) tuyas este día`}.</p>
      <div class="agenda">${rows.join('')}</div>`;
    refreshIcons();
  } catch (err) {
    if (t !== agendaToken) return;
    console.error(err);
    body.innerHTML = errorState(err).replace('data-action="retry"', 'data-c="agenda-retry"');
    refreshIcons();
  }
}

// ---------- Agenda semanal ----------
let semanaRows = [], semanaToken = 0;
const lunesDe = (iso) => addDays(iso, 1 - isoDow(iso));
const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie'];

async function renderSemana() {
  const t = ++semanaToken;
  const card = root?.querySelector('#semana-card');
  if (!card) return;
  const hoy = todayISO();
  const lunes = lunesDe(agendaDate);
  const dias = DIAS.map((_, i) => addDays(lunes, i));
  card.innerHTML = `
    <div class="agenda-nav">
      <button class="icon-btn" data-c="semana-prev" aria-label="Semana anterior">${icon('chevron-left')}</button>
      <button class="icon-btn" data-c="semana-next" aria-label="Semana siguiente">${icon('chevron-right')}</button>
      <button class="btn secondary" data-c="semana-hoy">Esta semana</button>
      <span class="agenda-day" style="text-transform:none">Semana del ${esc(fmtDate(dias[0]))} al ${esc(fmtDate(dias[4]))}</span>
    </div>
    <div id="semana-body"><div class="skeleton" style="height:120px"></div></div>`;
  refreshIcons();
  const body = card.querySelector('#semana-body');
  try {
    const [citasRes, bloqueos, ...ocup] = await Promise.all([
      sb.from('v_citas_med').select('id, folio_txt, fecha, hora, colaborador, num_empleado, area, motivo, descripcion, estado, solicitante, solicitado_por, tipo')
        .gte('fecha', dias[0]).lte('fecha', dias[4]).neq('estado', 'cancelada').order('hora'),
      getBloqueos(dias[0], dias[4]),
      ...dias.map((d) => sb.rpc('med_horarios_ocupados', { p_fecha: d })),
    ]);
    must(citasRes); ocup.forEach(must);
    if (t !== semanaToken) return;
    semanaRows = citasRes.data;
    const ocupados = dias.map((_, i) => new Set((ocup[i].data || []).map(fmtTime)));
    const now = nowHHMM();
    const chip = (c) => `<button type="button" class="wk-chip st-${esc(c.estado)} ${c.tipo === 'urgente' ? 'urg' : ''}" data-act="ver" data-id="${esc(c.id)}" title="${esc(`${c.folio_txt} · ${c.colaborador} · ${ESTADOS[c.estado]?.label || c.estado}`)}">
        ${c.tipo === 'urgente' ? `<b>${esc(fmtTime(c.hora))}</b> ` : ''}${esc(c.colaborador)}</button>`;
    const head = dias.map((d, i) => {
      const b = bloqueoDe(bloqueos, d);
      return `<div class="wk-head ${d === hoy ? 'today' : ''}"><button type="button" class="link-btn" data-c="ver-dia" data-fecha="${d}">${DIAS[i]} ${esc(d.slice(8, 10))}/${esc(d.slice(5, 7))}</button>
        ${b ? `<small class="wk-off">${esc(b.motivo)}</small>` : ''}</div>`;
    }).join('');
    const urgentes = dias.map((d) => semanaRows.filter((c) => c.fecha === d && c.tipo === 'urgente'));
    const urgRow = urgentes.some((u) => u.length)
      ? `<div class="wk-hora">${icon('siren')}</div>${urgentes.map((u) => `<div class="wk-cell">${u.map(chip).join('')}</div>`).join('')}` : '';
    const filas = SLOTS.map((s) => `<div class="wk-hora mono">${s}</div>${dias.map((d, i) => {
      const here = semanaRows.filter((c) => c.fecha === d && c.tipo !== 'urgente' && fmtTime(c.hora) === s);
      if (here.length) return `<div class="wk-cell">${here.map(chip).join('')}</div>`;
      const pasada = d < hoy || (d === hoy && s <= now);
      if (bloqueoDe(bloqueos, d, s)) return '<div class="wk-cell off" title="Sin servicio"></div>';
      if (ocupados[i].has(s)) return '<div class="wk-cell busy"><span>Ocupado</span></div>';
      if (pasada) return '<div class="wk-cell past"></div>';
      return `<div class="wk-cell free"><button type="button" data-c="agendar" data-fecha="${d}" data-hora="${s}" aria-label="Agendar ${DIAS[i]} ${s}">${icon('plus')}</button></div>`;
    }).join('')}`).join('');
    body.innerHTML = `<div class="wk-scroll"><div class="wk-grid"><div class="wk-hora"></div>${head}${urgRow}${filas}</div></div>
      <p class="hint" style="margin:10px 0 0">Toca una cita para ver el detalle o un espacio libre (+) para agendar. ${state.isAdmin ? '' : 'Solo ves el nombre de las citas que tú solicitaste.'}</p>`;
    refreshIcons();
  } catch (err) {
    if (t !== semanaToken) return;
    console.error(err);
    body.innerHTML = errorState(err).replace('data-action="retry"', 'data-c="semana-retry"');
    refreshIcons();
  }
}

// ---------- Días u horarios sin servicio (solo Servicio Médico) ----------
async function openBloqueos() {
  const hoy = todayISO();
  const lista = async (cont) => {
    cont.innerHTML = '<div class="skeleton" style="height:60px"></div>';
    try {
      const rows = await getBloqueos(hoy, addDays(hoy, 730));
      cont.innerHTML = rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Fecha</th><th>Horario</th><th>Motivo</th><th class="actions"></th></tr></thead><tbody>
        ${rows.map((b) => `<tr><td>${esc(fmtDate(b.fecha))}<div class="cell-sub">${esc(fmtLongDate(b.fecha).split(',')[0])}</div></td>
          <td>${esc(bloqueoTxt(b))}</td><td>${esc(b.motivo)} ${b.tipo === 'festivo' ? pill('Festivo', 'info') : ''}</td>
          <td class="actions"><button type="button" class="icon-btn bad" data-del="${esc(b.id)}" title="Quitar" aria-label="Quitar">${icon('trash-2')}</button></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="hint">No hay días sin servicio próximos.</p>';
      refreshIcons();
    } catch (err) { cont.innerHTML = `<p class="hint" style="color:var(--bad)">${esc(errMsg(err))}</p>`; }
  };
  return openModal({
    title: 'Días sin servicio', size: 'lg', submitText: 'Agregar', confirmDiscard: false,
    subtitle: 'Festivos, vacaciones, cursos o ausencias. Nadie podrá agendar citas normales en esos horarios.',
    body: `
      <div class="form-grid">
        <div class="field"><label for="bq-fecha">Fecha <span class="req">*</span></label>
          <input id="bq-fecha" name="fecha" type="date" required min="${hoy}"></div>
        <div class="field"><label for="bq-hasta">Hasta (opcional, varios días)</label>
          <input id="bq-hasta" name="hasta" type="date" min="${hoy}"></div>
      </div>
      <label class="switch-row" for="bq-todo"><span><b>Todo el día</b></span><input type="checkbox" id="bq-todo" name="todo" checked></label>
      <div class="form-grid hidden" id="bq-horas">
        <div class="field"><label for="bq-ini">Desde</label><select id="bq-ini" name="ini">${SLOTS.map((s) => `<option>${s}</option>`).join('')}</select></div>
        <div class="field"><label for="bq-fin">Hasta</label><select id="bq-fin" name="fin">${[...SLOTS.slice(1), '17:20'].map((s) => `<option ${s === '17:20' ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="bq-tipo">Tipo</label><select id="bq-tipo" name="tipo">
          <option value="ausencia">Ausencia del médico</option><option value="festivo">Día festivo</option><option value="otro">Otro</option></select></div>
        <div class="field"><label for="bq-motivo">Motivo <span class="req">*</span></label>
          <input id="bq-motivo" name="motivo" required maxlength="120" placeholder="Ej. vacaciones, curso, junta"></div>
      </div>
      <div class="notice" id="bq-aviso" hidden></div>
      <div class="section-title">${icon('calendar-off')} Próximos</div>
      <div id="bq-lista"></div>`,
    onOpen: ({ form }) => {
      const cont = form.querySelector('#bq-lista');
      lista(cont);
      form.elements.todo.addEventListener('change', () => form.querySelector('#bq-horas').classList.toggle('hidden', form.elements.todo.checked));
      cont.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-del]'); if (!b) return;
        if (!(await confirmDialog({ title: 'Quitar día sin servicio', message: 'Se podrá volver a agendar en ese horario.', confirmText: 'Quitar', danger: true }))) return;
        const { error } = await sb.from('dias_sin_servicio_med').delete().eq('id', b.dataset.del);
        if (error) toast(errMsg(error), 'error'); else { toast('Día liberado.', 'success'); lista(cont); }
      });
    },
    onSubmit: async ({ form, setError }) => {
      if (!checkForm(form, { hasta: (v, f) => (v && v < f.fecha.value ? 'Debe ser igual o posterior a la fecha inicial.' : '') })) return false;
      const v = formValues(form);
      const todo = !!form.elements.todo.checked;
      if (!todo && v.fin <= v.ini) { setError('La hora final debe ser posterior a la inicial.'); return false; }
      const fechas = [];
      for (let d = v.fecha; d <= (v.hasta || v.fecha) && fechas.length < 120; d = addDays(d, 1)) if (isWeekday(d)) fechas.push(d);
      if (!fechas.length) { setError('El periodo no incluye días hábiles.'); return false; }
      must(await sb.from('dias_sin_servicio_med').insert(fechas.map((f) => ({
        fecha: f, tipo: v.tipo, motivo: v.motivo, hora_inicio: todo ? null : v.ini, hora_fin: todo ? null : v.fin,
      }))));
      // Avisar de citas ya agendadas que quedan dentro del bloqueo (no se cancelan solas)
      const { data } = await sb.from('v_citas_med').select('folio_txt, fecha, hora, colaborador')
        .in('fecha', fechas).in('estado', ['pendiente', 'confirmada']).not('hora', 'is', null);
      const afectadas = (data || []).filter((c) => todo || (fmtTime(c.hora) >= v.ini && fmtTime(c.hora) < v.fin));
      form.reset(); form.querySelector('#bq-horas').classList.add('hidden');
      const aviso = form.querySelector('#bq-aviso');
      aviso.hidden = !afectadas.length;
      aviso.innerHTML = afectadas.length ? `${icon('alert-triangle')}<span><b>${afectadas.length} cita(s) ya agendada(s) en ese periodo:</b> ${afectadas.map((c) => `${esc(c.folio_txt)} ${esc(fmtDate(c.fecha))} ${esc(fmtTime(c.hora))} h (${esc(c.colaborador)})`).join(', ')}. Reprográmalas o cancélalas para avisar a quien las pidió.</span>` : '';
      refreshIcons();
      toast(fechas.length === 1 ? 'Día sin servicio registrado.' : `${fechas.length} días sin servicio registrados.`, 'success');
      lista(form.querySelector('#bq-lista'));
      return false; // el modal sigue abierto para registrar más
    },
  });
}

// ---------- Constancia de atención (imprimible, sin datos clínicos) ----------
export async function imprimirConstancia(id) {
  const { data, error } = await sb.rpc('med_constancia', { p_cita: id });
  if (error || !data?.[0]) { toast(error ? errMsg(error) : 'La constancia solo está disponible para citas atendidas.', 'error'); return; }
  const c = data[0];
  const salida = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(c.atendido_at));
  document.getElementById('print-area')?.remove();
  const el = document.createElement('div');
  el.id = 'print-area';
  el.innerHTML = `
    <div class="pc-head"><div class="brand-logo pc-logo" role="img" aria-label="Pet's Table"></div>
      <div><h1>Constancia de atención</h1><p>Servicio Médico · Salud laboral · Pet's Table S.A. de C.V.</p></div></div>
    <p class="pc-text">Se hace constar que <b>${esc(c.colaborador)}</b>${c.num_empleado ? `, No. de empleado <b>${esc(c.num_empleado)}</b>` : ''}${c.area ? `, del área de <b>${esc(c.area)}</b>` : ''},
      acudió a Servicio Médico el <b>${esc(fmtLongDate(c.fecha))}</b>.</p>
    <table class="pc-table">
      <tr><th>Folio</th><td>${esc(c.folio_txt)}</td></tr>
      <tr><th>${c.tipo === 'urgente' ? 'Horario asignado (urgencia)' : 'Horario de la cita'}</th><td>${esc(fmtTime(c.hora))} h</td></tr>
      <tr><th>Registro de la atención</th><td>${esc(salida)} h</td></tr>
      ${c.puesto ? `<tr><th>Puesto</th><td>${esc(c.puesto)}</td></tr>` : ''}
    </table>
    <p class="pc-note">Este documento solo acredita la asistencia al servicio médico; no contiene información clínica.</p>
    <div class="pc-firmas"><div><span></span>${esc(c.atendio || 'Servicio Médico')}<small>Atendió</small></div><div><span></span>Jefe inmediato<small>Enterado</small></div></div>
    <p class="pc-foot">Emitida el ${esc(fmtDateTime(new Date().toISOString()))} h</p>`;
  document.body.appendChild(el);
  document.body.classList.add('printing');
  const limpiar = () => { document.body.classList.remove('printing'); el.remove(); window.removeEventListener('afterprint', limpiar); };
  window.addEventListener('afterprint', limpiar);
  setTimeout(() => window.print(), 50);
}

// ---------- Formulario de solicitud / reprogramación ----------
function defaultFecha() {
  const hoy = todayISO();
  if (isWeekday(hoy) && nowHHMM() < '17:00') return hoy;
  return stepWeekday(hoy, 1);
}

export async function openCitaForm({ cita = null, fecha = null, hora = null, urgente = false } = {}) {
  const hoy = todayISO();
  const editing = !!cita;
  if (editing && !cita.colaborador) {
    // La fila puede venir incompleta (p. ej. desde el detalle): recargar
    const { data, error } = await sb.from('v_citas_med').select('*').eq('id', cita.id).single();
    if (error) { toast(errMsg(error), 'error'); return false; }
    cita = data;
  }
  const f0 = editing ? cita.fecha : (fecha || defaultFecha());
  const h0 = editing ? fmtTime(cita.hora) : hora;
  const body = `
    ${editing ? '' : `<label class="switch-row urg-switch" for="cf-urg"><span><b>${icon('siren')} Cita de urgencia / extraordinaria</b><br>
      <small class="hint" style="margin:0">Úsala si no hay horario disponible o no puede esperar. Servicio Médico recibe el aviso de inmediato y asigna un horario especial o la rechaza.</small></span>
      <input type="checkbox" id="cf-urg" name="urgente" ${urgente ? 'checked' : ''}></label>`}
    <div class="field">
      <label for="cf-col-search">Colaborador <span class="req">*</span></label>
      ${editing
        ? `<div class="chip-selected"><div><b>${esc(cita.colaborador)}</b><br><span>${esc([cita.num_empleado, cita.area].filter(Boolean).join(' · '))}</span></div></div>`
        : `<div id="cf-col"></div>`}
      <input type="hidden" name="colaborador_id" value="${editing ? esc(cita.colaborador_id) : ''}" ${editing ? '' : 'required'}>
      ${!editing && !state.isAdmin ? '<small class="hint">Puedes solicitar la cita para ti o para un colaborador de tu misma área.</small>' : ''}
    </div>
    <div class="form-grid">
      <div class="field"><label for="cf-fecha">Fecha <span class="req">*</span></label>
        <input type="date" id="cf-fecha" name="fecha" required min="${hoy}" value="${esc(f0)}"></div>
      <div class="field"><label for="cf-motivo">Motivo <span class="req">*</span></label>
        <select id="cf-motivo" name="motivo" required>
          <option value="">Selecciona…</option>
          ${Object.entries(MOTIVOS).map(([k, v]) => `<option value="${k}" ${editing && cita.motivo === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
    </div>
    <div class="field" id="cf-horario">
      <label>Horario <span class="req">*</span></label>
      <div id="cf-slots" class="slots" role="radiogroup" aria-label="Horarios disponibles"></div>
      <small class="hint">Lunes a viernes de 9:00 a 17:30, bloques de 20 minutos. Los horarios tachados no están disponibles.</small>
    </div>
    ${state.isMedico && !editing ? `<div class="field hidden" id="cf-hora-esp"><label for="cf-hora-urg">Horario especial (opcional)</label>
      <input type="time" id="cf-hora-urg" name="hora_urg" step="60"><small class="hint">Si lo dejas vacío, podrás asignarlo después.</small></div>` : ''}
    <div class="notice warn hidden" id="cf-urg-nota">${icon('siren')}<span>La solicitud llegará como <b>urgente</b> a Servicio Médico, que te avisará el horario asignado o si la rechaza.</span></div>
    ${editing ? '' : `<div class="field hidden" id="cf-desc-f">
      <label for="cf-desc">Motivo de la urgencia <span class="req">*</span></label>
      <textarea id="cf-desc" name="descripcion" maxlength="300" data-counter placeholder="Ej. dolor intenso, herida que requiere curación"></textarea>
      <small class="hint">No incluyas diagnósticos ni información clínica sensible. Servicio Médico registrará lo necesario durante la atención.</small>
    </div>`}`;

  let slotToken = 0;
  return openModal({
    title: editing ? `Reprogramar cita ${cita.folio_txt || ''}` : (state.isAdmin ? 'Nueva cita' : 'Solicitar cita'),
    subtitle: editing ? 'Cambia la fecha, el horario o el motivo.' : 'La cita quedará pendiente hasta que Servicio Médico la confirme.',
    submitText: editing ? 'Guardar cambios' : 'Agendar cita',
    body,
    onOpen: ({ form }) => {
      bindCounters(form);
      if (!editing) {
        const picker = colaboradorPicker(form.querySelector('#cf-col'), form.elements.colaborador_id);
        // Quien solicita (usuario o administrador) aparece de inicio; se puede cambiar
        sb.from('colaboradores_med').select('id, nombre, num_empleado, usuario_id, area:areas_med(nombre)')
          .eq('usuario_id', state.profile.id).eq('activo', true).maybeSingle()
          .then(({ data }) => { if (data && !form.elements.colaborador_id.value) picker.select(data); });
      }
      const loadSlots = async (keep) => {
        const t = ++slotToken;
        const cont = form.querySelector('#cf-slots');
        const fecha = form.elements.fecha.value;
        const prev = keep || form.querySelector('input[name="hora"]:checked')?.value;
        if (form.elements.urgente?.checked) { cont.innerHTML = ''; return; }
        if (!fecha) { cont.innerHTML = '<span class="hint">Selecciona una fecha.</span>'; return; }
        if (!isWeekday(fecha)) { cont.innerHTML = '<span class="hint" style="color:var(--bad)">Sin servicio en fin de semana. Elige un día de lunes a viernes.</span>'; return; }
        if (fecha < hoy) { cont.innerHTML = '<span class="hint" style="color:var(--bad)">La fecha no puede ser pasada.</span>'; return; }
        cont.innerHTML = '<div class="skeleton" style="height:38px;grid-column:1/-1"></div>';
        let data, bloqueos;
        try {
          const [r, b] = await Promise.all([sb.rpc('med_horarios_ocupados', { p_fecha: fecha }), getBloqueos(fecha)]);
          data = must(r).data; bloqueos = b;
        } catch (error) {
          if (t === slotToken) cont.innerHTML = `<span class="hint" style="color:var(--bad)">${esc(errMsg(error))}</span>`;
          return;
        }
        if (t !== slotToken) return;
        const dia = bloqueoDe(bloqueos, fecha);
        if (dia) { cont.innerHTML = `<span class="hint" style="color:var(--bad)">Sin servicio ese día: ${esc(dia.motivo)}. Elige otra fecha o usa Cita de urgencia.</span>`; return; }
        const ocup = new Set((data || []).map(fmtTime));
        const now = nowHHMM();
        const own = editing && fecha === cita.fecha ? fmtTime(cita.hora) : null;
        cont.innerHTML = SLOTS.map((s) => {
          const past = fecha === hoy && s <= now && !state.isMedico;
          const bloq = bloqueoDe(bloqueos, fecha, s);
          const dis = (ocup.has(s) && s !== own) || past || !!bloq;
          return `<label class="slot" ${bloq ? `title="Sin servicio: ${esc(bloq.motivo)}"` : ''}><input type="radio" name="hora" value="${s}" required ${dis ? 'disabled' : ''} ${!dis && s === prev ? 'checked' : ''}><span>${s}</span></label>`;
        }).join('');
        if (bloqueos.length) cont.insertAdjacentHTML('beforeend', `<span class="hint" style="grid-column:1/-1">Sin servicio de ${bloqueos.map((b) => `${esc(bloqueoTxt(b))} (${esc(b.motivo)})`).join(', ')}.</span>`);
        if (!cont.querySelector('input:not(:disabled)')) cont.insertAdjacentHTML('beforeend', '<span class="hint" style="grid-column:1/-1;color:var(--bad)">No hay horarios disponibles este día.</span>');
      };
      form.elements.fecha.addEventListener('change', () => loadSlots());
      form._loadSlots = loadSlots;
      // Modo urgencia: sin bloques; el motivo de la urgencia es obligatorio
      const setUrg = () => {
        const urg = !!form.elements.urgente?.checked;
        form.querySelector('#cf-horario').classList.toggle('hidden', urg);
        form.querySelector('#cf-hora-esp')?.classList.toggle('hidden', !urg);
        form.querySelector('#cf-urg-nota').classList.toggle('hidden', !urg);
        if (form.elements.descripcion) { form.elements.descripcion.required = urg; form.querySelector('#cf-desc-f').classList.toggle('hidden', !urg); }
        if (urg && !form.elements.fecha.value) form.elements.fecha.value = hoy;
        loadSlots(h0);
      };
      form.elements.urgente?.addEventListener('change', setUrg);
      setUrg();
    },
    onSubmit: async ({ form, setError }) => {
      const urg = !!form.elements.urgente?.checked;
      if (!checkForm(form, {
        fecha: (v) => (!urg && !isWeekday(v) ? 'Solo de lunes a viernes (para otro día usa Cita de urgencia).' : v < hoy ? 'La fecha no puede ser pasada.' : ''),
        colaborador_id: (v) => (!v ? 'Selecciona un colaborador de la lista.' : ''),
      })) return false;
      const v = formValues(form);
      if (urg) {
        const { data } = must(await sb.from('citas_med').insert({
          colaborador_id: v.colaborador_id, fecha: v.fecha, motivo: v.motivo, descripcion: v.descripcion,
          tipo: 'urgente', hora: state.isMedico && v.hora_urg ? v.hora_urg : null,
        }).select('id, folio').single());
        avisar('nueva_cita', data.id);
        toast(`Solicitud urgente CM-${String(data.folio).padStart(5, '0')} enviada a Servicio Médico.`, 'success', 6000);
        return true;
      }
      if (!v.hora) { setError('Selecciona un horario disponible o marca Cita de urgencia.'); return false; }
      // Citas normales: sin descripción (al editar se conserva la que tuviera)
      const payload = { fecha: v.fecha, hora: v.hora, motivo: v.motivo };
      try {
        if (editing) {
          must(await sb.from('citas_med').update(payload).eq('id', cita.id).select('id').single());
          if (payload.fecha !== cita.fecha || payload.hora !== fmtTime(cita.hora)) avisar('reprogramada', cita.id);
          toast('Cita actualizada.', 'success');
        } else {
          const { data } = must(await sb.from('citas_med').insert({ ...payload, colaborador_id: v.colaborador_id }).select('id, folio').single());
          avisar('nueva_cita', data.id);
          toast(`Cita CM-${String(data.folio).padStart(5, '0')} registrada para el ${fmtDate(v.fecha)} a las ${v.hora} h.`, 'success', 6000);
        }
      } catch (err) {
        if (err.code === '23505' || /bloque_uk/.test(err.message || '')) {
          setError('Ese horario acaba de ocuparse. Elige otro.');
          await form._loadSlots();
          return false;
        }
        throw err;
      }
    },
  });
}

// Selector de colaborador con búsqueda en servidor
function colaboradorPicker(container, hidden) {
  container.innerHTML = `<div class="combo">
      <input type="text" id="cf-col-search" autocomplete="off" placeholder="Busca por nombre o No. de empleado" role="combobox" aria-expanded="false" aria-autocomplete="list">
      <div class="combo-list hidden" role="listbox"></div></div>`;
  const input = container.querySelector('input');
  const list = container.querySelector('.combo-list');
  let results = [], hl = -1, tok = 0;

  const select = (c) => {
    hidden.value = c.id;
    hidden.dispatchEvent(new Event('input', { bubbles: true }));
    const fld = hidden.closest('.field');
    fld.classList.remove('invalid');
    fld.querySelectorAll('.field-error').forEach((x) => x.remove());
    container.innerHTML = `<div class="chip-selected"><div><b>${esc(c.nombre)}</b><br><span>${esc([c.num_empleado, c.area?.nombre].filter(Boolean).join(' · '))}</span></div>
      <button type="button" class="btn ghost" data-change>${icon('repeat')} Cambiar</button></div>`;
    refreshIcons();
    container.querySelector('[data-change]').addEventListener('click', () => { hidden.value = ''; colaboradorPicker(container, hidden); container.querySelector('input').focus(); });
  };
  const draw = (q) => {
    list.innerHTML = results.map((c, i) => `<button type="button" role="option" data-i="${i}" class="${i === hl ? 'hl' : ''}">
        <b>${esc(c.nombre)}</b>${c.usuario_id && c.usuario_id === state.profile.id ? ' (tú)' : ''}<br><span class="muted">${esc([c.num_empleado, c.area?.nombre].filter(Boolean).join(' · '))}</span></button>`).join('')
      + (results.length ? '' : `<div class="muted" style="padding:9px 10px">${q ? 'Sin coincidencias.' : 'Escribe para buscar.'}</div>`)
      + `<button type="button" class="combo-new" data-new>${icon('user-plus')} Registrar nuevo colaborador${q ? `: “${esc(q)}”` : ''}</button>`;
    list.classList.remove('hidden'); input.setAttribute('aria-expanded', 'true');
    refreshIcons();
  };
  const search = debounce(async () => {
    const t = ++tok; const q = sanitizeSearch(input.value);
    let qb = sb.from('colaboradores_med').select('id, nombre, num_empleado, usuario_id, area:areas_med(nombre)').eq('activo', true).order('nombre').limit(8);
    // Sin importar acentos ni mayúsculas, y cada palabra en cualquier orden ("julian" encuentra "Julián")
    const palabras = q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(' ').filter(Boolean);
    for (const w of palabras) qb = qb.ilike('nombre_norm', `%${w}%`);
    // Usuarios: solo para sí mismos o para colaboradores de su área (también se valida en la base de datos)
    if (!state.isAdmin) {
      const { id, area_id: area } = state.profile;
      qb = area ? qb.or(`area_id.eq.${area},usuario_id.eq.${id}`) : qb.eq('usuario_id', id);
    }
    const { data, error } = await qb;
    if (t !== tok) return;
    results = error ? [] : data; hl = results.length ? 0 : -1;
    draw(input.value.trim());
  }, 220);
  input.addEventListener('input', search);
  input.addEventListener('focus', search);
  input.addEventListener('keydown', (e) => {
    if (list.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); hl = Math.min(results.length - 1, hl + 1); draw(input.value.trim()); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hl = Math.max(0, hl - 1); draw(input.value.trim()); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[hl]) select(results[hl]); }
    else if (e.key === 'Escape') { e.stopPropagation(); list.classList.add('hidden'); }
  });
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', async (e) => {
    const opt = e.target.closest('[data-i]');
    if (opt) { select(results[Number(opt.dataset.i)]); return; }
    if (e.target.closest('[data-new]')) {
      list.classList.add('hidden');
      const nuevo = await openColaboradorForm({ nombre: input.value.trim(), areaId: state.isAdmin ? '' : state.profile.area_id || '' });
      if (nuevo && nuevo.id) select(nuevo);
    }
  });
  input.addEventListener('blur', () => setTimeout(() => { list.classList.add('hidden'); input.setAttribute('aria-expanded', 'false'); }, 150));
  return { select };
}

// ---------- Detalle ----------
ganchos.openDetalle = (id) => openDetalle(id);
export async function openDetalle(id) {
  let c, at = null, meds = [];
  try {
    const reqs = [sb.from('v_citas_med').select('*').eq('id', id).single()];
    if (state.isMedico) {
      reqs.push(
        sb.from('atenciones_med').select('sintomatologia, nota, atendido_at, atendido:usuarios_med!atenciones_med_atendido_por_fkey(nombre), padecimiento:padecimientos_med(nombre)').eq('cita_id', id).maybeSingle(),
        sb.from('v_movimientos_med').select('medicamento, unidad, lote, caducidad, cantidad, tipo, motivo').eq('cita_id', id).order('created_at'),
      );
    }
    const res = await Promise.all(reqs);
    res.forEach(must);
    c = res[0].data; at = res[1]?.data || null; meds = res[2]?.data || [];
  } catch (err) { toast(errMsg(err), 'error'); return false; }

  const acts = availableActions(c);
  const box = (label, value, full = false) => `<div class="info-box ${full ? 'full' : ''}"><small>${esc(label)}</small><b>${value}</b></div>`;
  const body = `
    <div class="detail-grid">
      ${box('Folio', `<span class="mono">${esc(c.folio_txt)}</span>`)}
      ${box('Estado', estadoPill(c.estado))}
      ${box('Fecha', esc(fmtLongDate(c.fecha)))}
      ${box('Horario', `${horaTxt(c)}${c.tipo === 'urgente' ? ` ${pill('Urgente', 'bad')}` : ''}`)}
      ${box('Colaborador', `${esc(c.colaborador)}<div class="cell-sub">${esc([c.num_empleado, c.area].filter(Boolean).join(' · '))}</div>`)}
      ${box('Motivo', esc(MOTIVOS[c.motivo] || c.motivo))}
      ${c.descripcion ? box('Descripción', esc(c.descripcion), true) : ''}
      ${box('Solicitó', `${esc(c.solicitante)}<div class="cell-sub">${fmtDateTime(c.created_at)}</div>`)}
      ${box('Última actualización', fmtDateTime(c.updated_at))}
      ${c.estado === 'cancelada' ? box('Cancelación', `${esc(c.motivo_cancelacion || '')}<div class="cell-sub">Por ${esc(c.cancelado_por_nombre || '—')}</div>`, true) : ''}
    </div>
    ${state.isMedico && c.estado === 'atendida' ? `
      <div class="section-title">${icon('stethoscope')} Atención</div>
      <div class="detail-grid">
        ${box('Padecimiento', esc(at?.padecimiento?.nombre || 'Sin clasificar'), true)}
        ${box('Sintomatología', esc(at?.sintomatologia || 'Sin registro'), true)}
        ${box('Nota de atención', esc(at?.nota || 'Sin registro'), true)}
        ${box('Atendió', `${esc(at?.atendido?.nombre || '—')}<div class="cell-sub">${fmtDateTime(at?.atendido_at)}</div>`, true)}
      </div>
      <div class="section-title">${icon('pill')} Medicamentos e insumos entregados</div>
      ${meds.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Medicamento</th><th>Lote</th><th>Caducidad</th><th class="num">Cantidad</th></tr></thead><tbody>
        ${meds.map((m) => `<tr><td>${esc(m.medicamento)}</td><td class="mono">${esc(m.lote)}</td><td>${fmtDate(m.caducidad)}</td><td class="num">${esc(m.tipo === 'uso' ? m.motivo : cantUnidad(-m.cantidad, m.unidad))}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="hint">No se entregaron medicamentos.</p>'}` : ''}
    ${acts.length ? `<div class="section-title">Acciones</div><div class="page-actions">
      ${acts.map(([a, ic, t, cls]) => `<button type="button" class="btn ${cls === 'fill-ok' ? 'btn-confirmar' : cls === 'fill-red' ? 'btn-noasistio' : a === 'atender' ? 'primary' : 'secondary'}" data-detail-act="${a}">${icon(ic)} ${esc(t)}</button>`).join('')}
    </div>` : ''}`;

  const choice = await openModal({
    title: `Cita ${c.folio_txt}`, subtitle: `${c.colaborador} · ${fmtDate(c.fecha)} · ${horaTxt(c)}`, size: 'lg', body,
    onOpen: ({ wrap, close }) => {
      wrap.addEventListener('click', (e) => { const b = e.target.closest('[data-detail-act]'); if (b) close(b.dataset.detailAct); });
    },
  });
  if (typeof choice === 'string') return runAction(choice, c);
  return false;
}

// ---------- Atención con dispensación de medicamentos ----------
export async function openAtender(c) {
  let meds, padecimientos;
  try {
    if (!c.colaborador) c = must(await sb.from('v_citas_med').select('*').eq('id', c.id).single()).data;
    // Medicamentos e insumos con existencia (el equipo no se entrega en consulta)
    meds = must(await sb.from('v_stock_med').select('id, clave, nombre, unidad, existencia_vigente, empaque, contenido_empaque, categoria, control, nivel_abierto')
      .eq('activo', true).neq('categoria', 'equipo').gt('existencia_vigente', 0).order('categoria').order('nombre')).data;
    padecimientos = must(await sb.from('padecimientos_med').select('id, nombre').eq('activo', true).order('nombre')).data;
  } catch (err) { toast(errMsg(err), 'error'); return false; }
  const hoy = todayISO();
  let rowSeq = 0;
  const lotesCache = new Map();

  const body = `
    <div class="notice">${icon('shield-check')}<span>Registra solo la información mínima necesaria (síntomas y nota breve). No captures diagnósticos detallados, antecedentes ni datos de terceros. Solo los administradores pueden consultar esta información.</span></div>
    <div class="detail-grid">
      <div class="info-box"><small>Colaborador</small><b>${esc(c.colaborador)}</b></div>
      <div class="info-box"><small>Cita</small><b>${esc(c.folio_txt)} · ${fmtDate(c.fecha)} ${esc(horaTxt(c))} · ${esc(MOTIVOS[c.motivo] || '')}</b></div>
    </div>
    <div class="field"><label for="at-pad">Padecimiento atendido <span class="req">*</span></label>
      <select id="at-pad" name="padecimiento" required><option value="">Selecciona…</option>
        ${padecimientos.map((p) => `<option value="${esc(p.id)}">${esc(p.nombre)}</option>`).join('')}
        <option value="__otro">Otro (escribir)…</option></select>
      <div class="hidden" id="at-pad-otro" style="margin-top:8px"><input name="padecimiento_otro" maxlength="80" autocomplete="off" placeholder="Escribe el padecimiento">
        <small class="hint">Se agregará a la lista para las siguientes consultas.</small></div>
      <small class="hint">Se usa para las estadísticas por padecimiento y departamento. El catálogo se edita en Usuarios → Configuración.</small></div>
    <div class="field"><label for="at-sint">Sintomatología referida</label>
      <textarea id="at-sint" name="sintomatologia" maxlength="500" data-counter placeholder="Ej. cefalea leve desde la mañana"></textarea></div>
    <div class="field"><label for="at-nota">Nota de atención</label>
      <textarea id="at-nota" name="nota" maxlength="1000" data-counter placeholder="Indicaciones generales brindadas"></textarea></div>
    <fieldset><legend>Medicamentos e insumos utilizados</legend>
      <div class="med-rows" id="at-rows"></div>
      ${meds.length
        ? `<button type="button" class="btn teal" id="at-add" style="margin-top:10px">${icon('plus')} Agregar medicamento o insumo</button>
           <small class="hint">Se propone el lote con caducidad más próxima (primero en caducar, primero en salir). Los lotes caducados no se pueden entregar. En geles, cremas, frascos y rollos marca cuánto queda del envase; si se terminó, se descuenta.</small>`
        : '<p class="hint" style="margin:4px 0">No hay medicamentos ni insumos con existencia vigente. Puedes registrar la atención sin entrega.</p>'}
    </fieldset>`;

  const addRow = (form) => {
    const i = rowSeq++;
    const div = document.createElement('div');
    div.className = 'med-row'; div.dataset.row = i;
    div.innerHTML = `
      <div class="field f-med"><label for="m-${i}">Medicamento o insumo <span class="req">*</span></label>
        <select id="m-${i}" name="med_${i}" required><option value="">Selecciona…</option>
        ${meds.map((m) => `<option value="${esc(m.id)}">${esc(m.nombre)} (${esc(cantUnidad(m.existencia_vigente, m.unidad))}${m.categoria === 'insumo' ? ' · insumo' : ''})</option>`).join('')}</select></div>
      <div class="field"><label for="l-${i}">Lote <span class="req">*</span></label>
        <select id="l-${i}" name="lote_${i}" required disabled><option value="">—</option></select></div>
      <div class="field" data-qty><label for="q-${i}">Cantidad <span class="req">*</span></label>
        <input id="q-${i}" name="cant_${i}" type="number" inputmode="numeric" min="1" step="1" required value="1">
        <small class="hint" id="qu-${i}"></small></div>
      <div class="field full hidden" data-nivel><label>¿Cuánto queda del envase? <span class="req">*</span></label>${nivelesHTML(`niv_${i}`)}</div>
      <button type="button" class="icon-btn bad" data-remove aria-label="Quitar renglón" style="margin-bottom:4px">${icon('trash-2')}</button>`;
    form.querySelector('#at-rows').appendChild(div);
    div.querySelectorAll('[data-nivel] input').forEach((r) => { r.disabled = true; });
    refreshIcons();
    const medSel = div.querySelector(`#m-${i}`), loteSel = div.querySelector(`#l-${i}`), qty = div.querySelector(`#q-${i}`);
    medSel.addEventListener('change', async () => {
      loteSel.disabled = true; loteSel.innerHTML = '<option value="">Cargando…</option>';
      if (!medSel.value) { loteSel.innerHTML = '<option value="">—</option>'; return; }
      try {
        if (!lotesCache.has(medSel.value)) {
          const { data } = must(await sb.from('v_lotes_med').select('id, lote, caducidad, existencia, nivel')
            .eq('medicamento_id', medSel.value).gt('existencia', 0).or(`caducidad.is.null,caducidad.gte.${hoy}`)
            .order('caducidad', { nullsFirst: false }));
          lotesCache.set(medSel.value, data);
        }
        const lotes = lotesCache.get(medSel.value);
        const med = meds.find((x) => x.id === medSel.value);
        // Por envase: en lugar de cantidad se indica cuánto queda del envase
        const env = med?.control === 'envase';
        div.querySelector('[data-qty]').classList.toggle('hidden', env);
        qty.disabled = env;
        div.querySelector('[data-nivel]').classList.toggle('hidden', !env);
        div.querySelectorAll(`input[name="niv_${i}"]`).forEach((r) => { r.disabled = !env; });
        div.querySelector(`#qu-${i}`).textContent = med ? `En ${plural(med.unidad, 2)} (pieza por pieza)` : '';
        loteSel.innerHTML = lotes.map((l) => `<option value="${esc(l.id)}" data-max="${l.existencia}">${esc(l.lote)} · ${l.caducidad ? `cad. ${fmtDate(l.caducidad)}` : 'sin caducidad'} · ${esc(cantUnidad(l.existencia, med?.unidad || 'unidad'))} disp.${env && l.nivel ? ` (abierto, queda ${({ 100: "lleno", 75: "¾", 50: "½", 25: "¼" })[l.nivel]})` : ''}</option>`).join('')
          || '<option value="">Sin lotes vigentes</option>';
        loteSel.disabled = !lotes.length;
        loteSel.dispatchEvent(new Event('change'));
      } catch (err) { loteSel.innerHTML = '<option value="">Error al cargar</option>'; toast(errMsg(err), 'error'); }
    });
    loteSel.addEventListener('change', () => { const max = loteSel.selectedOptions[0]?.dataset.max; if (max) qty.max = max; });
    div.querySelector('[data-remove]').addEventListener('click', () => div.remove());
  };

  return openModal({
    title: 'Registrar atención', subtitle: 'Al guardar, la cita quedará como atendida y se descontarán los medicamentos.',
    size: 'lg', submitText: 'Registrar atención', body,
    onOpen: ({ form }) => {
      bindCounters(form);
      form.querySelector('#at-add')?.addEventListener('click', () => addRow(form));
      // Padecimiento fuera de la lista: "Otro" permite escribirlo
      form.elements.padecimiento.addEventListener('change', () => {
        const otro = form.elements.padecimiento.value === '__otro';
        form.querySelector('#at-pad-otro').classList.toggle('hidden', !otro);
        form.elements.padecimiento_otro.required = otro;
        if (otro) form.elements.padecimiento_otro.focus();
      });
    },
    onSubmit: async ({ form, setError }) => {
      if (!checkForm(form)) return false;
      const items = [];
      const seen = new Set();
      for (const row of form.querySelectorAll('[data-row]')) {
        const i = row.dataset.row;
        const lote = form.elements[`lote_${i}`].value;
        const cant = Number(form.elements[`cant_${i}`].value);
        if (seen.has(lote)) { fieldError(form.elements[`lote_${i}`], 'Lote repetido; ajusta la cantidad en un solo renglón.'); setError('Revisa los medicamentos.'); return false; }
        seen.add(lote);
        const niv = row.querySelector(`input[name="niv_${i}"]:checked:not(:disabled)`);
        if (!row.querySelector('[data-nivel]').classList.contains('hidden')) {
          if (!niv) { setError('Indica cuánto queda de cada envase utilizado.'); return false; }
          items.push({ lote_id: lote, nivel: Number(niv.value) });
        } else items.push({ lote_id: lote, cantidad: cant });
      }
      const v = formValues(form);
      const ok = await confirmDialog({
        title: 'Confirmar atención', confirmText: 'Confirmar',
        message: `La cita ${c.folio_txt} quedará como atendida${items.length ? ` y se descontarán ${items.length} renglón(es) de medicamentos` : ''}. Esta acción no se puede deshacer.`,
      });
      if (!ok) return false;
      // "Otro": se usa el existente con el mismo nombre o se agrega al catálogo
      let padecimiento = v.padecimiento;
      if (padecimiento === '__otro') {
        const nombre = v.padecimiento_otro.replace(/\s+/g, ' ').trim();
        if (nombre.length < 2) { setError('Escribe el padecimiento.'); return false; }
        const { data: ya } = await sb.from('padecimientos_med').select('id, activo').ilike('nombre', nombre.replace(/[%_\\]/g, '\\$&')).maybeSingle();
        if (ya) {
          padecimiento = ya.id;
          if (!ya.activo) await sb.from('padecimientos_med').update({ activo: true }).eq('id', ya.id);
        } else {
          padecimiento = must(await sb.from('padecimientos_med').insert({ nombre }).select('id').single()).data.id;
        }
      }
      must(await sb.rpc('med_atender_cita', { p_cita: c.id, p_sintomatologia: nullIfEmpty(v.sintomatologia), p_nota: nullIfEmpty(v.nota), p_items: items, p_padecimiento: padecimiento }));
      toast(`Atención registrada para ${c.colaborador}.`, 'success');
    },
  });
}
