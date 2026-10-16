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
} from '../core.js';
import { openColaboradorForm } from './colaboradores.js';

let root, table, agendaDate, agendaToken = 0;

export default {
  async render(el, params = {}) {
    root = el;
    const admin = state.isAdmin;
    const vista = params.vista === 'agenda' ? 'agenda' : 'lista';
    el.innerHTML = `
      <section class="page-intro">
        <div><span class="eyebrow">Citas médicas</span>
          <h1>${admin ? 'Citas' : 'Mis citas'}</h1>
          <p>${admin ? 'Solicitudes, confirmaciones y atención del servicio médico.' : 'Citas que has solicitado para ti o para colaboradores.'}</p></div>
        <div class="page-actions">
          <button class="btn primary" data-c="nueva">${icon('calendar-plus')} ${admin ? 'Nueva cita' : 'Solicitar cita'}</button>
        </div>
      </section>
      <div class="tabs" role="tablist">
        <button role="tab" data-tab="lista" class="${vista === 'lista' ? 'active' : ''}">${icon('list')} Lista</button>
        <button role="tab" data-tab="agenda" class="${vista === 'agenda' ? 'active' : ''}">${icon('calendar-range')} Agenda del día</button>
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
      <div id="tab-agenda" class="${vista === 'agenda' ? '' : 'hidden'}"><div class="card" id="agenda-card"></div></div>`;

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
    if (vista === 'agenda') await renderAgenda(); else await apply();
  },
  destroy() { agendaToken++; root = null; table = null; },
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
  const hoy = todayISO(), now = nowHHMM();
  const abierta = c.estado === 'pendiente' || c.estado === 'confirmada';
  const pasada = c.hora && (c.fecha < hoy || (c.fecha === hoy && fmtTime(c.hora) <= now));
  const own = c.solicitado_por === state.profile.id;
  const urg = c.tipo === 'urgente';
  const acts = [];
  if (state.isAdmin) {
    if (c.estado === 'pendiente') acts.push(urg ? ['asignar', 'clock-plus', 'Asignar horario especial y confirmar', 'ok'] : ['confirmar', 'check', 'Confirmar', 'ok']);
    if (abierta && c.fecha <= hoy) acts.push(['atender', 'stethoscope', 'Registrar atención', 'ok']);
    if (abierta) acts.push(urg ? ['asignar', 'calendar-clock', 'Cambiar horario', ''] : ['reprogramar', 'calendar-clock', 'Reprogramar', '']);
    if (abierta && pasada) acts.push(['no_asistio', 'user-x', 'Marcar inasistencia', 'warn']);
    if (abierta) acts.push(['cancelar', 'x-circle', c.estado === 'pendiente' ? 'Rechazar' : 'Cancelar', 'bad']);
  } else if (own) {
    if (c.estado === 'pendiente' && !urg) acts.push(['reprogramar', 'calendar-clock', 'Modificar', '']);
    if (abierta) acts.push(['cancelar', 'x-circle', 'Cancelar', 'bad']);
  }
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
    else if (c.dataset.c === 'limpiar') {
      root.querySelectorAll('#tab-lista .toolbar input, #tab-lista .toolbar select').forEach((i) => { i.value = ''; });
      table.setFilters({ q: '', estado: '', area: '', motivo: '', desde: '', hasta: '' });
    } else if (c.dataset.c === 'agenda-prev') { agendaDate = stepWeekday(agendaDate, -1); renderAgenda(); }
    else if (c.dataset.c === 'agenda-next') { agendaDate = stepWeekday(agendaDate, 1); renderAgenda(); }
    else if (c.dataset.c === 'agenda-hoy') { agendaDate = todayISO(); renderAgenda(); }
    else if (c.dataset.c === 'agenda-retry') renderAgenda();
    else if (c.dataset.c === 'agendar') { if (await openCitaForm({ fecha: agendaDate, hora: c.dataset.hora })) reload(); }
    return;
  }
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === tab));
    const ag = tab.dataset.tab === 'agenda';
    root.querySelector('#tab-lista').classList.toggle('hidden', ag);
    root.querySelector('#tab-agenda').classList.toggle('hidden', !ag);
    history.replaceState(null, '', ag ? '#/citas?vista=agenda' : '#/citas');
    if (ag) renderAgenda(); else table.load();
    return;
  }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const cita = table?.row(a.dataset.id) || agendaRows.find((r) => r.id === a.dataset.id) || { id: a.dataset.id };
  if (await runAction(a.dataset.act, cita)) reload();
}

function reload() {
  if (!root) return;
  if (!root.querySelector('#tab-agenda').classList.contains('hidden')) renderAgenda();
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
      case 'cancelar': {
        const rechazo = state.isAdmin && c.estado === 'pendiente';
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
    const [citasRes, ocupRes] = await Promise.all([
      sb.from('v_citas_med').select('id, folio_txt, fecha, hora, colaborador, num_empleado, area, motivo, descripcion, estado, solicitante, solicitado_por, tipo')
        .eq('fecha', agendaDate).neq('estado', 'cancelada').order('hora'),
      sb.rpc('med_horarios_ocupados', { p_fecha: agendaDate }),
    ]);
    must(citasRes); must(ocupRes);
    if (t !== agendaToken) return;
    agendaRows = citasRes.data;
    const ocupados = new Set((ocupRes.data || []).map((h) => fmtTime(h)));
    const now = nowHHMM();
    const rows = SLOTS.map((slot) => {
      const here = agendaRows.filter((c) => c.tipo !== 'urgente' && fmtTime(c.hora) === slot);
      const pasada = agendaDate < hoy || (agendaDate === hoy && slot <= now);
      const libre = !ocupados.has(slot);
      const puedeAgendar = libre && (state.isAdmin ? agendaDate >= hoy : !pasada);
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
    body.innerHTML = `${urgHTML}<p class="hint" style="margin:0 0 10px">${fmtNum(ocupados.size)} de ${SLOTS.length} horarios ocupados${state.isAdmin ? '' : ` · ${fmtNum(total)} cita(s) tuyas este día`}.</p>
      <div class="agenda">${rows.join('')}</div>`;
    refreshIcons();
  } catch (err) {
    if (t !== agendaToken) return;
    console.error(err);
    body.innerHTML = errorState(err).replace('data-action="retry"', 'data-c="agenda-retry"');
    refreshIcons();
  }
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
    ${state.isAdmin && !editing ? `<div class="field hidden" id="cf-hora-esp"><label for="cf-hora-urg">Horario especial (opcional)</label>
      <input type="time" id="cf-hora-urg" name="hora_urg" step="60"><small class="hint">Si lo dejas vacío, podrás asignarlo después.</small></div>` : ''}
    <div class="notice warn hidden" id="cf-urg-nota">${icon('siren')}<span>La solicitud llegará como <b>urgente</b> a Servicio Médico, que te avisará el horario asignado o si la rechaza.</span></div>
    <div class="field">
      <label for="cf-desc"><span id="cf-desc-lbl">Descripción breve (opcional)</span></label>
      <textarea id="cf-desc" name="descripcion" maxlength="300" data-counter placeholder="Ej. revisión de presión arterial">${editing ? esc(cita.descripcion || '') : ''}</textarea>
      <small class="hint">No incluyas diagnósticos ni información clínica sensible. Servicio Médico registrará lo necesario durante la atención.</small>
    </div>`;

  let slotToken = 0;
  return openModal({
    title: editing ? `Reprogramar cita ${cita.folio_txt || ''}` : (state.isAdmin ? 'Nueva cita' : 'Solicitar cita'),
    subtitle: editing ? 'Cambia la fecha, el horario o el motivo.' : 'La cita quedará pendiente hasta que Servicio Médico la confirme.',
    submitText: editing ? 'Guardar cambios' : 'Agendar cita',
    body,
    onOpen: ({ form }) => {
      bindCounters(form);
      if (!editing) colaboradorPicker(form.querySelector('#cf-col'), form.elements.colaborador_id);
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
        const { data, error } = await sb.rpc('med_horarios_ocupados', { p_fecha: fecha });
        if (t !== slotToken) return;
        if (error) { cont.innerHTML = `<span class="hint" style="color:var(--bad)">${esc(errMsg(error))}</span>`; return; }
        const ocup = new Set((data || []).map(fmtTime));
        const now = nowHHMM();
        const own = editing && fecha === cita.fecha ? fmtTime(cita.hora) : null;
        cont.innerHTML = SLOTS.map((s) => {
          const past = fecha === hoy && s <= now && !state.isAdmin;
          const dis = (ocup.has(s) && s !== own) || past;
          return `<label class="slot"><input type="radio" name="hora" value="${s}" required ${dis ? 'disabled' : ''} ${!dis && s === prev ? 'checked' : ''}><span>${s}</span></label>`;
        }).join('');
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
        form.elements.descripcion.required = urg;
        form.querySelector('#cf-desc-lbl').innerHTML = urg ? 'Motivo de la urgencia <span class="req">*</span>' : 'Descripción breve (opcional)';
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
          tipo: 'urgente', hora: state.isAdmin && v.hora_urg ? v.hora_urg : null,
        }).select('id, folio').single());
        avisar('nueva_cita', data.id);
        toast(`Solicitud urgente CM-${String(data.folio).padStart(5, '0')} enviada a Servicio Médico.`, 'success', 6000);
        return true;
      }
      if (!v.hora) { setError('Selecciona un horario disponible o marca Cita de urgencia.'); return false; }
      const payload = { fecha: v.fecha, hora: v.hora, motivo: v.motivo, descripcion: nullIfEmpty(v.descripcion) };
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
        <b>${esc(c.nombre)}</b><br><span class="muted">${esc([c.num_empleado, c.area?.nombre].filter(Boolean).join(' · '))}</span></button>`).join('')
      + (results.length ? '' : `<div class="muted" style="padding:9px 10px">${q ? 'Sin coincidencias.' : 'Escribe para buscar.'}</div>`)
      + `<button type="button" class="combo-new" data-new>${icon('user-plus')} Registrar nuevo colaborador${q ? `: “${esc(q)}”` : ''}</button>`;
    list.classList.remove('hidden'); input.setAttribute('aria-expanded', 'true');
    refreshIcons();
  };
  const search = debounce(async () => {
    const t = ++tok; const q = sanitizeSearch(input.value);
    let qb = sb.from('colaboradores_med').select('id, nombre, num_empleado, area:areas_med(nombre)').eq('activo', true).order('nombre').limit(8);
    if (q) qb = qb.or(`nombre.ilike.*${q}*,num_empleado.ilike.*${q}*`);
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
      const nuevo = await openColaboradorForm({ nombre: input.value.trim() });
      if (nuevo && nuevo.id) select(nuevo);
    }
  });
  input.addEventListener('blur', () => setTimeout(() => { list.classList.add('hidden'); input.setAttribute('aria-expanded', 'false'); }, 150));
}

// ---------- Detalle ----------
export async function openDetalle(id) {
  let c, at = null, meds = [];
  try {
    const reqs = [sb.from('v_citas_med').select('*').eq('id', id).single()];
    if (state.isAdmin) {
      reqs.push(
        sb.from('atenciones_med').select('sintomatologia, nota, atendido_at, atendido:usuarios_med!atenciones_med_atendido_por_fkey(nombre), padecimiento:padecimientos_med(nombre)').eq('cita_id', id).maybeSingle(),
        sb.from('v_movimientos_med').select('medicamento, unidad, lote, caducidad, cantidad').eq('cita_id', id).order('created_at'),
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
    ${state.isAdmin && c.estado === 'atendida' ? `
      <div class="section-title">${icon('stethoscope')} Atención</div>
      <div class="detail-grid">
        ${box('Padecimiento', esc(at?.padecimiento?.nombre || 'Sin clasificar'), true)}
        ${box('Sintomatología', esc(at?.sintomatologia || 'Sin registro'), true)}
        ${box('Nota de atención', esc(at?.nota || 'Sin registro'), true)}
        ${box('Atendió', `${esc(at?.atendido?.nombre || '—')}<div class="cell-sub">${fmtDateTime(at?.atendido_at)}</div>`, true)}
      </div>
      <div class="section-title">${icon('pill')} Medicamentos entregados</div>
      ${meds.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Medicamento</th><th>Lote</th><th>Caducidad</th><th class="num">Cantidad</th></tr></thead><tbody>
        ${meds.map((m) => `<tr><td>${esc(m.medicamento)}</td><td class="mono">${esc(m.lote)}</td><td>${fmtDate(m.caducidad)}</td><td class="num">${esc(cantUnidad(-m.cantidad, m.unidad))}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="hint">No se entregaron medicamentos.</p>'}` : ''}
    ${acts.length ? `<div class="section-title">Acciones</div><div class="page-actions">
      ${acts.map(([a, ic, t, cls]) => `<button type="button" class="btn ${a === 'cancelar' || a === 'no_asistio' ? 'secondary' : a === 'atender' || a === 'confirmar' ? 'primary' : 'secondary'}" data-detail-act="${a}">${icon(ic)} ${esc(t)}</button>`).join('')}
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
    meds = must(await sb.from('v_stock_med').select('id, clave, nombre, unidad, existencia_vigente, empaque, contenido_empaque')
      .eq('activo', true).gt('existencia_vigente', 0).order('nombre')).data;
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
        ${padecimientos.map((p) => `<option value="${esc(p.id)}">${esc(p.nombre)}</option>`).join('')}</select>
      <small class="hint">Se usa para las estadísticas por padecimiento y departamento. El catálogo se edita en Usuarios → Configuración.</small></div>
    <div class="field"><label for="at-sint">Sintomatología referida</label>
      <textarea id="at-sint" name="sintomatologia" maxlength="500" data-counter placeholder="Ej. cefalea leve desde la mañana"></textarea></div>
    <div class="field"><label for="at-nota">Nota de atención</label>
      <textarea id="at-nota" name="nota" maxlength="1000" data-counter placeholder="Indicaciones generales brindadas"></textarea></div>
    <fieldset><legend>Medicamentos entregados</legend>
      <div class="med-rows" id="at-rows"></div>
      ${meds.length
        ? `<button type="button" class="btn teal" id="at-add" style="margin-top:10px">${icon('plus')} Agregar medicamento</button>
           <small class="hint">Se propone el lote con caducidad más próxima (primero en caducar, primero en salir). Los lotes caducados no se pueden entregar.</small>`
        : '<p class="hint" style="margin:4px 0">No hay medicamentos con existencia vigente. Puedes registrar la atención sin entrega.</p>'}
    </fieldset>`;

  const addRow = (form) => {
    const i = rowSeq++;
    const div = document.createElement('div');
    div.className = 'med-row'; div.dataset.row = i;
    div.innerHTML = `
      <div class="field f-med"><label for="m-${i}">Medicamento <span class="req">*</span></label>
        <select id="m-${i}" name="med_${i}" required><option value="">Selecciona…</option>
        ${meds.map((m) => `<option value="${esc(m.id)}">${esc(m.nombre)} (${esc(cantUnidad(m.existencia_vigente, m.unidad))})</option>`).join('')}</select></div>
      <div class="field"><label for="l-${i}">Lote <span class="req">*</span></label>
        <select id="l-${i}" name="lote_${i}" required disabled><option value="">—</option></select></div>
      <div class="field"><label for="q-${i}">Cantidad <span class="req">*</span></label>
        <input id="q-${i}" name="cant_${i}" type="number" inputmode="numeric" min="1" step="1" required value="1">
        <small class="hint" id="qu-${i}"></small></div>
      <button type="button" class="icon-btn bad" data-remove aria-label="Quitar renglón" style="margin-bottom:4px">${icon('trash-2')}</button>`;
    form.querySelector('#at-rows').appendChild(div);
    refreshIcons();
    const medSel = div.querySelector(`#m-${i}`), loteSel = div.querySelector(`#l-${i}`), qty = div.querySelector(`#q-${i}`);
    medSel.addEventListener('change', async () => {
      loteSel.disabled = true; loteSel.innerHTML = '<option value="">Cargando…</option>';
      if (!medSel.value) { loteSel.innerHTML = '<option value="">—</option>'; return; }
      try {
        if (!lotesCache.has(medSel.value)) {
          const { data } = must(await sb.from('v_lotes_med').select('id, lote, caducidad, existencia')
            .eq('medicamento_id', medSel.value).gt('existencia', 0).gte('caducidad', hoy).order('caducidad'));
          lotesCache.set(medSel.value, data);
        }
        const lotes = lotesCache.get(medSel.value);
        const med = meds.find((x) => x.id === medSel.value);
        div.querySelector(`#qu-${i}`).textContent = med ? `En ${plural(med.unidad, 2)} (pieza por pieza)` : '';
        loteSel.innerHTML = lotes.map((l) => `<option value="${esc(l.id)}" data-max="${l.existencia}">${esc(l.lote)} · cad. ${fmtDate(l.caducidad)} · ${esc(cantUnidad(l.existencia, med?.unidad || 'unidad'))} disp.</option>`).join('')
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
        items.push({ lote_id: lote, cantidad: cant });
      }
      const v = formValues(form);
      const ok = await confirmDialog({
        title: 'Confirmar atención', confirmText: 'Confirmar',
        message: `La cita ${c.folio_txt} quedará como atendida${items.length ? ` y se descontarán ${items.length} renglón(es) de medicamentos` : ''}. Esta acción no se puede deshacer.`,
      });
      if (!ok) return false;
      must(await sb.rpc('med_atender_cita', { p_cita: c.id, p_sintomatologia: nullIfEmpty(v.sintomatologia), p_nota: nullIfEmpty(v.nota), p_items: items, p_padecimiento: v.padecimiento }));
      toast(`Atención registrada para ${c.colaborador}.`, 'success');
    },
  });
}
