// =====================================================================
// Exámenes médicos de ingreso y egreso. Solo los ven el médico y las áreas
// Servicio Médico, Procesos y Mejora continua y Recursos Humanos
// (med_puede_examenes en la base de datos).
// - Ingreso: se solicita para un candidato (nombre, área, puesto, fecha y hora).
//   Si el médico lo dictamina APTO, queda registrado como colaborador.
// - Egreso: se solicita para cualquier colaborador activo; al registrar el
//   examen, el colaborador queda dado de baja (desactivado).
// Las reglas se validan en la base de datos (med_validar_examen y
// med_registrar_examen); la interfaz solo anticipa los mismos criterios.
// =====================================================================
import {
  sb, state, esc, icon, refreshIcons, toast, errMsg, openModal, confirmDialog, checkForm, formValues,
  nullIfEmpty, bindCounters, todayISO, fmtDate, fmtTime, fmtDateTime, fmtLongDate, pill, DataTable, paged,
  sanitizeSearch, debounce, getAreas, must, avisarExamen,
} from '../core.js';
import { colaboradorPicker } from './citas.js';

export const RESULTADOS = {
  apto: { titulo: 'Médicamente APTO', texto: 'para realizar las actividades propias del puesto mencionado.', tono: 'ok', ico: 'badge-check' },
  no_apto: { titulo: 'Médicamente NO APTO', texto: 'para realizar las actividades propias del puesto.', tono: 'bad', ico: 'circle-x' },
  apto_restricciones: { titulo: 'APTO con restricciones', texto: 'para el puesto.', tono: 'warn', ico: 'shield-alert' },
  apto_restricciones_sin_interferencia: { titulo: 'APTO con restricciones', texto: 'que no interfieren en sus actividades propias del puesto.', tono: 'info', ico: 'shield-check' },
  sin_hallazgos: { titulo: 'Sin hallazgos relevantes', texto: 'en la valoración médica de egreso.', tono: 'ok', ico: 'badge-check' },
  con_hallazgos: { titulo: 'Con hallazgos', texto: 'que se describen en las observaciones de la valoración de egreso.', tono: 'warn', ico: 'file-warning' },
};
const OPCIONES = {
  ingreso: ['apto', 'no_apto', 'apto_restricciones', 'apto_restricciones_sin_interferencia'],
  egreso: ['sin_hallazgos', 'con_hallazgos'],
};
const CON_TEXTO = ['apto_restricciones', 'apto_restricciones_sin_interferencia', 'con_hallazgos'];
const ESTADOS = { pendiente: ['Pendiente', 'warn'], confirmado: ['Confirmado', 'info'], realizado: ['Realizado', 'ok'], cancelado: ['Cancelado', 'gray'] };
const TIPO = { ingreso: 'Examen de ingreso', egreso: 'Examen de egreso' };
const estadoPill = (e) => pill(ESTADOS[e]?.[0] || e, ESTADOS[e]?.[1] || 'gray');
const resultadoPill = (r) => (r ? pill(RESULTADOS[r].titulo, RESULTADOS[r].tono) : '<span class="muted">—</span>');
const cuando = (x) => `${fmtDate(x.fecha)} · ${fmtTime(x.hora)} h`;

let root, table, tipoActual = 'ingreso';

export default {
  async render(el, params = {}) {
    root = el;
    tipoActual = params.tipo === 'egreso' ? 'egreso' : 'ingreso';
    el.innerHTML = `
      <section class="page-intro">
        <div><span class="eyebrow">Salud ocupacional</span><h1>Exámenes médicos</h1>
          <p>Exámenes de ingreso de candidatos y de egreso de colaboradores. Solo los ven Servicio Médico, Procesos y Mejora continua y Recursos Humanos.</p></div>
        <div class="page-actions ex-acts">
          <button class="btn ex-btn ex-ingreso" data-ex="nuevo" data-tipo="ingreso">${icon('user-round-plus')} Examen de ingreso</button>
          <button class="btn ex-btn ex-egreso" data-ex="nuevo" data-tipo="egreso">${icon('user-round-minus')} Examen de egreso</button>
        </div>
      </section>
      <div class="tabs" role="tablist">
        <button role="tab" data-tab="ingreso" class="${tipoActual === 'ingreso' ? 'active' : ''}">${icon('user-round-plus')} Ingreso</button>
        <button role="tab" data-tab="egreso" class="${tipoActual === 'egreso' ? 'active' : ''}">${icon('user-round-minus')} Egreso</button>
      </div>
      <div class="card">
        <div class="toolbar">
          <div class="search">${icon('search')}<input type="search" id="ex-q" placeholder="Buscar folio, candidato o colaborador" aria-label="Buscar"></div>
          <select id="ex-estado" aria-label="Estado"><option value="">Todos los estados</option>
            ${Object.entries(ESTADOS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select>
          <span class="date-range"><input type="date" id="ex-desde" aria-label="Desde"> a <input type="date" id="ex-hasta" aria-label="Hasta"></span>
        </div>
        <div id="ex-table"></div>
      </div>`;
    table = new DataTable(el.querySelector('#ex-table'), {
      sort: { key: 'fecha', asc: false },
      columns: [
        { label: 'Folio', sort: 'folio', render: (x) => `<span class="cell-main mono">${esc(x.folio_txt)}</span>` },
        { label: 'Fecha', sort: 'fecha', render: (x) => `<div class="cell-main">${fmtDate(x.fecha)}</div><div class="cell-sub mono">${fmtTime(x.hora)} h</div>` },
        { label: 'Candidato / colaborador', sort: 'persona', render: (x) => `<div class="cell-main">${esc(x.persona)}</div><div class="cell-sub">${esc([x.area, x.puesto].filter(Boolean).join(' · '))}</div>` },
        { label: 'Estado', sort: 'estado', render: (x) => estadoPill(x.estado) },
        { label: 'Resultado', render: (x) => resultadoPill(x.resultado) },
        { label: 'Solicitó', render: (x) => `<span class="cell-sub">${esc(x.solicitante)}</span>` },
        { label: 'Acciones', cls: 'actions', render: (x) => accionesHTML(x) },
      ],
      empty: { ico: 'clipboard-check', title: 'Aún no hay exámenes', text: 'Solicita un examen de ingreso para un candidato o de egreso para un colaborador.' },
      fetch: async ({ from, to, sort, filters: f }) => {
        let q = sb.from('v_examenes_med').select('*', { count: 'exact' }).eq('tipo', tipoActual);
        const s = sanitizeSearch(f.q);
        if (s) q = q.or(`persona.ilike.*${s}*,folio_txt.ilike.*${s}*`);
        if (f.estado) q = q.eq('estado', f.estado);
        if (f.desde) q = q.gte('fecha', f.desde);
        if (f.hasta) q = q.lte('fecha', f.hasta);
        const { data, count } = must(await paged(q, { from, to, sort }, sort?.key === 'fecha' ? [['hora', sort.asc]] : [['fecha', false]]));
        return { rows: data, count };
      },
    });
    const $ = (s) => el.querySelector(s);
    const apply = () => table.setFilters({ q: $('#ex-q').value, estado: $('#ex-estado').value, desde: $('#ex-desde').value, hasta: $('#ex-hasta').value });
    $('#ex-q').addEventListener('input', debounce(apply, 350));
    ['#ex-estado', '#ex-desde', '#ex-hasta'].forEach((s) => $(s).addEventListener('change', apply));
    el.addEventListener('click', onClick);
    await apply();
    // Desde un aviso: abre directamente el examen
    if (/^[0-9a-f-]{36}$/i.test(params.examen || '')) {
      history.replaceState(null, '', '#/examenes');
      if (await openExamen(params.examen) && root) table?.load();
    }
  },
  destroy() { root = null; table = null; },
};

async function onClick(e) {
  const tab = e.target.closest('[data-tab]');
  if (tab && root) {
    tipoActual = tab.dataset.tab;
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === tab));
    table.page = 1; table.load();
    return;
  }
  const b = e.target.closest('[data-ex]');
  if (!b) return;
  const act = b.dataset.ex;
  if (act === 'nuevo') {
    if (await openExamenForm({ tipo: b.dataset.tipo })) {
      if (b.dataset.tipo !== tipoActual) root?.querySelector(`[data-tab="${b.dataset.tipo}"]`)?.click(); else table?.load();
    }
    return;
  }
  const x = table?.row(b.dataset.id);
  if (x && await accion(act, x)) table?.load();
}

function acciones(x) {
  const abierto = ['pendiente', 'confirmado'].includes(x.estado);
  const mio = x.solicitado_por === state.profile.id;
  const a = [['ver', 'eye', 'Ver detalle', '']];
  if (state.isMedico && x.estado === 'pendiente') a.push(['confirmar', 'check', 'Confirmar', 'fill-ok']);
  if (state.isMedico && abierto && x.fecha <= todayISO()) a.push(['registrar', 'stethoscope', 'Registrar resultado', 'ok']);
  if (abierto && (state.isMedico || (mio && x.estado === 'pendiente'))) a.push(['editar', 'calendar-clock', state.isMedico ? 'Reprogramar' : 'Editar', '']);
  if (x.estado === 'realizado') a.push(['constancia', 'printer', 'Constancia (PDF)', 'ok']);
  if (abierto && (state.isMedico || mio)) a.push(['cancelar', 'x', 'Cancelar', 'bad']);
  return a;
}
function accionesHTML(x) {
  return `<div class="row-actions">${acciones(x).map(([k, ico, t, cls]) =>
    `<button class="icon-btn ${cls}" data-ex="${k}" data-id="${esc(x.id)}" title="${t}" aria-label="${t}">${icon(ico)}</button>`).join('')}</div>`;
}

async function accion(act, x) {
  try {
    switch (act) {
      case 'ver': return await openExamen(x.id);
      case 'editar': return await openExamenForm({ examen: x });
      case 'registrar': return await openRegistrar(x);
      case 'constancia': await imprimirExamen(x.id); return false;
      case 'confirmar': {
        const ok = await confirmDialog({ title: 'Confirmar examen', confirmText: 'Confirmar',
          message: `Se confirmará el ${TIPO[x.tipo].toLowerCase()} ${x.folio_txt} de ${x.persona} para el ${fmtLongDate(x.fecha)} a las ${fmtTime(x.hora)} h. Se avisará a quien lo solicitó.` });
        if (!ok) return false;
        must(await sb.from('examenes_med').update({ estado: 'confirmado' }).eq('id', x.id).select('id').single());
        avisarExamen('examen_confirmado', x.id);
        toast('Examen confirmado.', 'success'); return true;
      }
      case 'cancelar': {
        const r = await confirmDialog({ title: 'Cancelar examen', danger: true, confirmText: 'Cancelar examen',
          message: `Se cancelará el ${TIPO[x.tipo].toLowerCase()} ${x.folio_txt} de ${x.persona}.`,
          input: { label: 'Motivo de la cancelación', required: true, maxlength: 300, placeholder: 'Ej. el candidato no se presentó' } });
        if (!r) return false;
        must(await sb.from('examenes_med').update({ estado: 'cancelado', motivo_cancelacion: r.value }).eq('id', x.id).select('id').single());
        avisarExamen('examen_cancelado', x.id);
        toast('Examen cancelado.', 'success'); return true;
      }
      default: return false;
    }
  } catch (err) { console.error(err); toast(errMsg(err), 'error'); return false; }
}

// ---------- Solicitud / edición ----------
export async function openExamenForm({ tipo = 'ingreso', examen = null } = {}) {
  const x = examen;
  if (x) tipo = x.tipo;
  let areas = [];
  if (tipo === 'ingreso') {
    try { areas = await getAreas({ soloActivas: true }); } catch (err) { toast(errMsg(err), 'error'); return false; }
  }
  const hoy = todayISO();
  const ing = tipo === 'ingreso';
  return openModal({
    title: x ? `${state.isMedico ? 'Reprogramar' : 'Editar'} ${TIPO[tipo].toLowerCase()} ${x.folio_txt}` : TIPO[tipo],
    subtitle: x ? 'Cambia la fecha, la hora o los datos del examen.'
      : state.isMedico ? 'Quedará confirmado en tu agenda de exámenes.' : 'Servicio Médico recibirá la solicitud y la confirmará.',
    submitText: x ? 'Guardar cambios' : state.isMedico ? 'Programar examen' : 'Solicitar examen', size: 'lg',
    body: `
      <div class="ex-form-head ${ing ? 'ex-ingreso' : 'ex-egreso'}">${icon(ing ? 'user-round-plus' : 'user-round-minus')}
        <span><b>${TIPO[tipo]}</b><small>${ing ? 'Valoración médica del candidato antes de su contratación.' : 'Valoración médica del colaborador al término de la relación laboral.'}</small></span></div>
      ${ing ? `
        <div class="form-grid">
          <div class="field full"><label for="ex-cand">Nombre completo del candidato <span class="req">*</span></label>
            <input id="ex-cand" name="candidato" required minlength="3" maxlength="120" autocomplete="off" value="${esc(x?.candidato || '')}" placeholder="Nombre(s) y apellidos"></div>
          <div class="field"><label for="ex-area">Área <span class="req">*</span></label>
            <select id="ex-area" name="area_id" required><option value="">Selecciona…</option>
              ${areas.map((a) => `<option value="${esc(a.id)}" ${x?.area_id === a.id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select></div>
          <div class="field"><label for="ex-puesto">Puesto <span class="req">*</span></label>
            <input id="ex-puesto" name="puesto" required minlength="2" maxlength="100" autocomplete="off" value="${esc(x?.puesto || '')}" placeholder="Ej. Operador de producción"></div>
        </div>`
      : `
        <div class="field"><label for="cf-col-search">Colaborador <span class="req">*</span></label>
          ${x ? `<div class="chip-selected"><div><b>${esc(x.persona)}</b><br><span>${esc([x.area, x.puesto].filter(Boolean).join(' · '))}</span></div></div>`
              : '<div id="ex-col"></div><small class="hint">Puedes elegir a cualquier colaborador activo de la empresa.</small>'}
          <input type="hidden" name="colaborador_id" value="${esc(x?.colaborador_id || '')}" ${x ? '' : 'required'}></div>
        <div class="field"><label for="ex-motivo">Motivo de la baja (opcional)</label>
          <input id="ex-motivo" name="motivo" maxlength="300" autocomplete="off" value="${esc(x?.motivo || '')}" placeholder="Ej. renuncia voluntaria, término de contrato"></div>`}
      <div class="form-grid">
        <div class="field"><label for="ex-fecha">Fecha <span class="req">*</span></label>
          <input id="ex-fecha" name="fecha" type="date" required min="${hoy}" value="${esc(x?.fecha || hoy)}"></div>
        <div class="field"><label for="ex-hora">Hora <span class="req">*</span></label>
          <input id="ex-hora" name="hora" type="time" required step="60" value="${esc(x ? fmtTime(x.hora) : '')}"></div>
      </div>
      ${ing && !x ? '<p class="hint">Si el médico dictamina al candidato como APTO, quedará registrado como colaborador del área para sus futuras citas.</p>' : ''}
      ${!ing && !x ? '<p class="hint">Al registrar el examen de egreso, el colaborador quedará dado de baja (desactivado) en el sistema.</p>' : ''}`,
    onOpen: ({ form }) => {
      if (!ing && !x) colaboradorPicker(form.querySelector('#ex-col'), form.elements.colaborador_id, { todos: true, nuevo: false });
    },
    onSubmit: async ({ form }) => {
      if (!checkForm(form, {
        fecha: (v) => (v && v < hoy ? 'La fecha no puede ser pasada.' : ''),
        colaborador_id: (v) => (!v ? 'Selecciona un colaborador de la lista.' : ''),
        candidato: (v) => (/[<>{}]/.test(v) ? 'El nombre contiene caracteres no permitidos.' : ''),
      })) return false;
      const v = formValues(form);
      const datos = { fecha: v.fecha, hora: v.hora };
      if (ing) Object.assign(datos, { candidato: v.candidato.replace(/\s+/g, ' '), area_id: v.area_id, puesto: v.puesto });
      else datos.motivo = nullIfEmpty(v.motivo);
      if (x) {
        must(await sb.from('examenes_med').update(datos).eq('id', x.id).select('id').single());
        if (datos.fecha !== x.fecha || datos.hora !== fmtTime(x.hora)) avisarExamen('examen_reprogramado', x.id);
        toast('Examen actualizado.', 'success');
        return true;
      }
      const { data } = must(await sb.from('examenes_med').insert({ ...datos, tipo, ...(ing ? {} : { colaborador_id: v.colaborador_id }) })
        .select('id, folio, estado').single());
      avisarExamen('examen_nuevo', data.id);
      toast(`${TIPO[tipo]} EX-${String(data.folio).padStart(5, '0')} ${data.estado === 'confirmado' ? 'programado' : 'solicitado a Servicio Médico'}.`, 'success', 6000);
      return true;
    },
  });
}

// ---------- Detalle ----------
function resultadoHTML(x, grande = true) {
  const r = RESULTADOS[x.resultado];
  if (!r) return '';
  return `<div class="ex-res ${r.tono} ${grande ? 'lg' : ''}">${icon(r.ico)}
    <div><small>${x.tipo === 'ingreso' ? 'Dictamen médico' : 'Resultado de la valoración de egreso'}</small><b>${esc(r.titulo)}</b><span>${esc(r.texto)}</span></div></div>`;
}

export async function openExamen(id) {
  let x;
  try { x = must(await sb.from('v_examenes_med').select('*').eq('id', id).single()).data; } catch (err) { toast(errMsg(err), 'error'); return false; }
  const box = (label, value, full = false) => `<div class="info-box ${full ? 'full' : ''}"><small>${esc(label)}</small><b>${value}</b></div>`;
  const acts = acciones(x).filter(([k]) => k !== 'ver');
  const choice = await openModal({
    title: `${TIPO[x.tipo]} ${x.folio_txt}`, subtitle: `${x.persona} · ${cuando(x)}`, size: 'lg',
    body: `
      ${x.estado === 'realizado' ? resultadoHTML(x) : ''}
      ${x.estado === 'realizado' && x.observaciones ? `<div class="ex-obs"><small>${x.tipo === 'ingreso' ? 'Condiciones y restricciones' : 'Observaciones'}</small><p>${esc(x.observaciones)}</p></div>` : ''}
      <div class="detail-grid">
        ${box('Estado', estadoPill(x.estado))}
        ${box('Fecha y hora', esc(`${fmtLongDate(x.fecha)} · ${fmtTime(x.hora)} h`))}
        ${box(x.tipo === 'ingreso' ? 'Candidato' : 'Colaborador', esc(x.persona))}
        ${box('Área', esc(x.area || '—'))}
        ${box('Puesto', esc(x.puesto || '—'))}
        ${x.motivo ? box('Motivo de la baja', esc(x.motivo)) : ''}
        ${box('Solicitó', `${esc(x.solicitante)}<div class="cell-sub">${fmtDateTime(x.created_at)}</div>`)}
        ${x.estado === 'realizado' ? box('Realizó', `${esc(x.atendio || '—')}<div class="cell-sub">${fmtDateTime(x.realizado_at)}</div>`) : ''}
        ${x.estado === 'realizado' && x.tipo === 'ingreso' ? box('Registro como colaborador', x.resultado === 'no_apto' ? 'No se registró (NO APTO)' : 'Registrado y activo', true) : ''}
        ${x.estado === 'realizado' && x.tipo === 'egreso' ? box('Baja en el sistema', 'Colaborador desactivado', true) : ''}
        ${x.estado === 'cancelado' ? box('Cancelación', `${esc(x.motivo_cancelacion || '')}<div class="cell-sub">Por ${esc(x.cancelado_por_nombre || '—')}</div>`, true) : ''}
      </div>
      ${acts.length ? `<div class="section-title">Acciones</div><div class="page-actions">${acts.map(([k, ico, t, cls]) => `<button type="button" class="btn ${cls === 'fill-ok' ? 'btn-confirmar' : cls === 'bad' ? 'danger' : cls ? 'primary' : 'secondary'}" data-detail-act="${k}">${icon(ico)} ${t}</button>`).join('')}</div>` : ''}`,
    onOpen: ({ wrap, close }) => {
      wrap.addEventListener('click', (e) => { const b = e.target.closest('[data-detail-act]'); if (b) close(b.dataset.detailAct); });
    },
  });
  if (typeof choice === 'string') return accion(choice, x);
  return false;
}

// ---------- Registro del resultado (médico) ----------
async function openRegistrar(x) {
  const ing = x.tipo === 'ingreso';
  return openModal({
    title: `Registrar resultado · ${x.folio_txt}`, subtitle: `${TIPO[x.tipo]} de ${x.persona} · ${[x.area, x.puesto].filter(Boolean).join(' · ')}`,
    submitText: 'Registrar resultado', size: 'lg',
    body: `
      <p class="ex-lead">${ing ? 'En función de la historia clínica y el resultado de los estudios realizados, se determinó que el candidato es:'
        : 'Con base en la valoración médica de egreso, se determinó que el colaborador se encuentra:'}</p>
      <div class="ex-opts" role="radiogroup" aria-label="Resultado">
        ${OPCIONES[x.tipo].map((k) => { const r = RESULTADOS[k]; return `<label class="ex-opt ${r.tono}"><input type="radio" name="resultado" value="${k}" required>
          <span class="ex-opt-card">${icon(r.ico)}<span><b>${esc(r.titulo)}</b><small>${esc(r.texto)}</small></span></span></label>`; }).join('')}
      </div>
      <div class="field"><label for="ex-obs">${ing ? 'Condiciones y restricciones' : 'Observaciones'} <span class="req hidden" id="ex-obs-req">*</span></label>
        <textarea id="ex-obs" name="observaciones" maxlength="1500" data-counter rows="4" placeholder="${ing ? 'Ej. No cargar más de 10 kg; uso obligatorio de lentes; revaloración en 6 meses' : 'Hallazgos relevantes al momento del egreso'}"></textarea>
        <small class="hint">Aparecen en la constancia y las ve Recursos Humanos. Escribe solo lo necesario para el puesto, sin diagnósticos detallados.</small></div>
      <div class="notice ${ing ? '' : 'warn'}">${icon(ing ? 'user-round-plus' : 'user-round-minus')}<span>${ing
        ? `Si el resultado es APTO (con o sin restricciones), <b>${esc(x.persona)}</b> quedará registrado como colaborador de <b>${esc(x.area)}</b>.`
        : `Al registrar, <b>${esc(x.persona)}</b> quedará <b>dado de baja</b> (desactivado) y ya no aparecerá para nuevas citas.`}</span></div>`,
    onOpen: ({ form }) => {
      bindCounters(form);
      form.addEventListener('change', (e) => {
        if (e.target.name !== 'resultado') return;
        const req = CON_TEXTO.includes(e.target.value);
        form.elements.observaciones.required = req;
        form.querySelector('#ex-obs-req').classList.toggle('hidden', !req);
        form.querySelectorAll('.ex-opt').forEach((o) => o.classList.toggle('sel', o.querySelector('input').checked));
      });
    },
    onSubmit: async ({ form, setError }) => {
      const res = form.querySelector('input[name="resultado"]:checked')?.value;
      if (!res) { setError('Selecciona el resultado del examen.'); return false; }
      if (!checkForm(form)) return false;
      const v = formValues(form);
      const r = RESULTADOS[res];
      const ok = await confirmDialog({ title: 'Confirmar resultado', confirmText: 'Registrar', danger: !ing || res === 'no_apto',
        message: `${x.persona}: ${r.titulo}. ${ing ? (res === 'no_apto' ? 'No se registrará como colaborador.' : 'Se registrará como colaborador.') : 'El colaborador quedará dado de baja.'} Esta acción no se puede deshacer.` });
      if (!ok) return false;
      must(await sb.rpc('med_registrar_examen', { p_examen: x.id, p_resultado: res, p_observaciones: nullIfEmpty(v.observaciones) }));
      avisarExamen('examen_realizado', x.id);
      toast(`Resultado registrado: ${r.titulo}. Se avisó a Recursos Humanos.`, 'success', 6000);
      if (await confirmDialog({ title: 'Constancia lista', message: '¿Quieres imprimir o guardar la constancia en PDF ahora?', confirmText: 'Imprimir constancia' })) {
        await imprimirExamen(x.id);
      }
      return true;
    },
  });
}

// ---------- Constancia (PDF desde el diálogo de impresión) ----------
export async function imprimirExamen(id) {
  let x;
  try { x = must(await sb.from('v_examenes_med').select('*').eq('id', id).single()).data; } catch (err) { toast(errMsg(err), 'error'); return; }
  if (x.estado !== 'realizado') { toast('La constancia está disponible cuando el examen tiene resultado.', 'warning'); return; }
  const ing = x.tipo === 'ingreso';
  const r = RESULTADOS[x.resultado];
  const persona = ing ? 'Candidato' : 'Colaborador';
  document.getElementById('print-area')?.remove();
  const el = document.createElement('div');
  el.id = 'print-area';
  el.className = 'exd';
  el.innerHTML = `
    <header class="exd-head">
      <div class="brand-logo exd-logo" role="img" aria-label="Pet's Table"></div>
      <div class="exd-titulo"><small>Servicio Médico · Salud ocupacional</small>
        <h1>Constancia de examen médico de ${ing ? 'ingreso' : 'egreso'}</h1>
        <p>Pet's Table S.A. de C.V.</p></div>
      <div class="exd-folio"><small>Folio</small><b>${esc(x.folio_txt)}</b><span>${esc(fmtDate(x.fecha))}</span></div>
    </header>
    <section class="exd-sec"><h2>Datos del ${persona.toLowerCase()}</h2>
      <table class="exd-tabla">
        <tr><th>Nombre completo</th><td colspan="3"><b>${esc(x.persona)}</b></td></tr>
        <tr><th>Área</th><td>${esc(x.area || '—')}</td><th>Puesto</th><td>${esc(x.puesto || '—')}</td></tr>
        <tr><th>Fecha del examen</th><td>${esc(fmtLongDate(x.fecha))}</td><th>Hora</th><td>${esc(fmtTime(x.hora))} h</td></tr>
        ${!ing && x.motivo ? `<tr><th>Motivo de la baja</th><td colspan="3">${esc(x.motivo)}</td></tr>` : ''}
        <tr><th>Solicitado por</th><td colspan="3">${esc(x.solicitante)}</td></tr>
      </table></section>
    <section class="exd-sec"><h2>Dictamen</h2>
      <p class="exd-lead">${ing ? 'En función de la historia clínica y el resultado de los estudios realizados, se determinó que el candidato es:'
        : 'Con base en la valoración médica de egreso realizada, se determinó que el colaborador se encuentra:'}</p>
      <div class="exd-res ${r.tono}"><b>${esc(r.titulo)}</b><span>${esc(r.texto)}</span></div>
      ${x.observaciones || CON_TEXTO.includes(x.resultado) ? `<div class="exd-obs"><h3>${ing ? 'Condiciones y restricciones' : 'Observaciones'}</h3><p>${esc(x.observaciones || 'Ninguna.')}</p></div>` : ''}
    </section>
    <div class="exd-firmas">
      <div><span></span><b>${esc(x.atendio || 'Servicio Médico')}</b><small>Médico responsable · Servicio Médico</small></div>
      <div><span></span><b>&nbsp;</b><small>Jefatura de Recursos Humanos</small></div>
      <div><span></span><b>${esc(x.persona)}</b><small>${persona}</small></div>
    </div>
    <footer class="exd-pie">
      <span>Examen realizado el ${esc(fmtDateTime(x.realizado_at))} h · Emitida el ${esc(fmtDateTime(new Date().toISOString()))} h</span>
      <span>Documento confidencial de uso interno. El expediente clínico se resguarda en Servicio Médico.</span>
    </footer>`;
  document.body.appendChild(el);
  document.body.classList.add('printing');
  const titulo = document.title;
  document.title = `Constancia ${x.folio_txt} - ${x.persona}`;
  const limpiar = () => { document.body.classList.remove('printing'); el.remove(); document.title = titulo; window.removeEventListener('afterprint', limpiar); };
  window.addEventListener('afterprint', limpiar);
  refreshIcons();
  setTimeout(() => window.print(), 80);
}
