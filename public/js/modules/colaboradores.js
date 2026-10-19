// =====================================================================
// Colaboradores (pacientes del servicio) y catálogo de áreas.
// Todos los usuarios consultan y registran colaboradores; solo los
// administradores editan, desactivan o eliminan, y gestionan las áreas.
// =====================================================================
import {
  sb, state, esc, icon, toast, errMsg, openModal, confirmDialog, checkForm, formValues, nullIfEmpty,
  DataTable, paged, sanitizeSearch, debounce, getAreas, invalidateAreas, pill, must, fmtNum,
  fmtDate, fmtTime, estadoPill, MOTIVOS, cantUnidad, refreshIcons, ganchos, permitirNuevaArea,
} from '../core.js';

let root, table, areasTable;

export default {
  async render(el) {
    root = el;
    const admin = state.isAdmin;
    el.innerHTML = `
      <section class="page-intro">
        <div><span class="eyebrow">Catálogo</span><h1>Colaboradores</h1>
          <p>Personas que pueden recibir atención del servicio médico.</p></div>
        <div class="page-actions">
          <button class="btn primary" data-k="nuevo">${icon('user-plus')} Nuevo colaborador</button>
          ${admin ? `<button class="btn secondary hidden" data-k="nueva-area">${icon('plus')} Nueva área</button>` : ''}
        </div>
      </section>
      ${admin ? `<div class="tabs" role="tablist">
        <button role="tab" class="active" data-tab="col">${icon('users')} Colaboradores</button>
        <button role="tab" data-tab="areas">${icon('building-2')} Áreas</button></div>` : ''}
      <div id="tab-col" class="card">
        <div class="toolbar">
          <div class="search">${icon('search')}<input type="search" id="k-q" placeholder="Buscar por nombre" aria-label="Buscar"></div>
          <select id="k-area" aria-label="Área"><option value="">Todas las áreas</option></select>
          <select id="k-activo" aria-label="Estado"><option value="true">Activos</option><option value="false">Inactivos</option><option value="">Todos</option></select>
        </div>
        <div id="col-table"></div>
      </div>
      ${admin ? '<div id="tab-areas" class="card hidden"><div id="areas-table"></div></div>' : ''}`;

    table = new DataTable(el.querySelector('#col-table'), {
      sort: { key: 'nombre', asc: true },
      columns: [
        { label: 'Nombre', sort: 'nombre', render: (c) => `<span class="cell-main">${esc(c.nombre)}</span>` },
        { label: 'Área', render: (c) => esc(c.area?.nombre || '—') },
        { label: 'Puesto', render: (c) => esc(c.puesto || '—') },
        { label: 'Estado', render: (c) => (c.activo ? pill('Activo', 'ok') : pill('Inactivo', 'gray')) },
        ...(admin ? [{ label: 'Acciones', cls: 'actions', render: (c) => `<div class="row-actions">
          ${state.isMedico ? `<button class="icon-btn ok" data-ka="historial" data-id="${esc(c.id)}" title="Historial de atención" aria-label="Historial de atención">${icon('clipboard-list')}</button>` : ''}
          <button class="icon-btn" data-ka="editar" data-id="${esc(c.id)}" title="Editar" aria-label="Editar">${icon('pencil')}</button>
          <button class="icon-btn ${c.activo ? 'warn' : 'ok'}" data-ka="toggle" data-id="${esc(c.id)}" title="${c.activo ? 'Desactivar' : 'Activar'}" aria-label="${c.activo ? 'Desactivar' : 'Activar'}">${icon(c.activo ? 'user-minus' : 'user-check')}</button>
          <button class="icon-btn bad" data-ka="eliminar" data-id="${esc(c.id)}" title="Eliminar" aria-label="Eliminar">${icon('trash-2')}</button></div>` }] : []),
      ],
      empty: { ico: 'users', title: 'Sin colaboradores registrados', text: 'Registra a los colaboradores para poder agendarles citas.',
        action: `<button class="btn primary" data-k="nuevo">${icon('user-plus')} Nuevo colaborador</button>` },
      fetch: async ({ from, to, sort, filters: f }) => {
        let q = sb.from('colaboradores_med').select('id, num_empleado, nombre, puesto, activo, area_id, area:areas_med(nombre)', { count: 'exact' });
        const s = sanitizeSearch(f.q);
        if (s) q = q.or(`nombre.ilike.*${s}*,num_empleado.ilike.*${s}*`);
        if (f.area) q = q.eq('area_id', f.area);
        if (f.activo !== '' && f.activo !== undefined) q = q.eq('activo', f.activo === 'true');
        const { data, count } = must(await paged(q, { from, to, sort }, [['nombre', true]]));
        return { rows: data, count };
      },
    });

    const apply = () => table.setFilters({ q: el.querySelector('#k-q').value, area: el.querySelector('#k-area').value, activo: el.querySelector('#k-activo').value });
    el.querySelector('#k-q').addEventListener('input', debounce(apply, 350));
    el.querySelector('#k-area').addEventListener('change', apply);
    el.querySelector('#k-activo').addEventListener('change', apply);
    fillAreaFilter();
    el.addEventListener('click', onClick);
    await apply();
  },
  destroy() { root = null; table = null; areasTable = null; },
};

async function fillAreaFilter() {
  try {
    const areas = await getAreas();
    const sel = root?.querySelector('#k-area');
    if (!sel) return;
    sel.innerHTML = '<option value="">Todas las áreas</option>' + areas.map((a) => `<option value="${esc(a.id)}">${esc(a.nombre)}${a.activo ? '' : ' (inactiva)'}</option>`).join('');
  } catch { /* el filtro queda solo con "Todas" */ }
}

async function onClick(e) {
  const k = e.target.closest('[data-k]');
  if (k) {
    if (k.dataset.k === 'nuevo') { if (await openColaboradorForm()) table.load(); }
    if (k.dataset.k === 'nueva-area') { if (await openAreaForm()) { areasTable.load(); fillAreaFilter(); } }
    return;
  }
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === tab));
    const areas = tab.dataset.tab === 'areas';
    root.querySelector('#tab-col').classList.toggle('hidden', areas);
    root.querySelector('#tab-areas').classList.toggle('hidden', !areas);
    root.querySelector('[data-k="nueva-area"]').classList.toggle('hidden', !areas);
    root.querySelector('[data-k="nuevo"]').classList.toggle('hidden', areas);
    if (areas) initAreas(); else table.load();
    return;
  }
  const a = e.target.closest('[data-ka]');
  if (a) {
    const c = table.row(a.dataset.id);
    if (!c) return;
    try {
      if (a.dataset.ka === 'historial') await openHistorial(c);
      if (a.dataset.ka === 'editar') { if (await openColaboradorForm({ colaborador: c })) table.load(); }
      if (a.dataset.ka === 'toggle') {
        const ok = await confirmDialog({
          title: c.activo ? 'Desactivar colaborador' : 'Activar colaborador', danger: c.activo,
          message: c.activo ? `${c.nombre} ya no aparecerá al agendar nuevas citas. Su historial se conserva.` : `${c.nombre} volverá a estar disponible para agendar citas.`,
          confirmText: c.activo ? 'Desactivar' : 'Activar',
        });
        if (!ok) return;
        must(await sb.from('colaboradores_med').update({ activo: !c.activo }).eq('id', c.id).select('id').single());
        toast(c.activo ? 'Colaborador desactivado.' : 'Colaborador activado.', 'success'); table.load();
      }
      if (a.dataset.ka === 'eliminar') {
        const ok = await confirmDialog({ title: 'Eliminar colaborador', danger: true, confirmText: 'Eliminar',
          message: `¿Eliminar definitivamente a ${c.nombre}? Solo es posible si no tiene citas registradas; de lo contrario, desactívalo.` });
        if (!ok) return;
        const { error, count } = await sb.from('colaboradores_med').delete({ count: 'exact' }).eq('id', c.id);
        if (error) throw error;
        if (!count) throw new Error('No se pudo eliminar el registro.');
        toast('Colaborador eliminado.', 'success'); table.load();
      }
    } catch (err) { toast(errMsg(err), 'error'); }
    return;
  }
  const ar = e.target.closest('[data-aa]');
  if (ar) {
    const area = areasTable.row(ar.dataset.id);
    if (!area) return;
    try {
      if (ar.dataset.aa === 'editar') { if (await openAreaForm(area)) { areasTable.load(); fillAreaFilter(); } }
      if (ar.dataset.aa === 'toggle') {
        const ok = await confirmDialog({ title: area.activo ? 'Desactivar área' : 'Activar área', danger: area.activo,
          message: area.activo ? `El área "${area.nombre}" no se podrá asignar a nuevos colaboradores.` : `El área "${area.nombre}" volverá a estar disponible.`,
          confirmText: area.activo ? 'Desactivar' : 'Activar' });
        if (!ok) return;
        must(await sb.from('areas_med').update({ activo: !area.activo }).eq('id', area.id).select('id').single());
        invalidateAreas(); toast('Área actualizada.', 'success'); areasTable.load(); fillAreaFilter();
      }
      if (ar.dataset.aa === 'eliminar') {
        const ok = await confirmDialog({ title: 'Eliminar área', danger: true, confirmText: 'Eliminar',
          message: `¿Eliminar el área "${area.nombre}"? Solo es posible si no tiene colaboradores ni usuarios asignados.` });
        if (!ok) return;
        const { error, count } = await sb.from('areas_med').delete({ count: 'exact' }).eq('id', area.id);
        if (error) throw error;
        if (!count) throw new Error('No se pudo eliminar el registro.');
        invalidateAreas(); toast('Área eliminada.', 'success'); areasTable.load(); fillAreaFilter();
      }
    } catch (err) { toast(errMsg(err), 'error'); }
  }
}

// ---------- Historial de atención (solo administradores) ----------
async function openHistorial(c) {
  let citas, atenciones, meds;
  try {
    citas = must(await sb.from('v_citas_med').select('id, folio_txt, fecha, hora, motivo, descripcion, estado, tipo')
      .eq('colaborador_id', c.id).order('fecha', { ascending: false }).order('hora', { ascending: false }).limit(200)).data;
    const ids = citas.filter((x) => x.estado === 'atendida').map((x) => x.id);
    [atenciones, meds] = ids.length ? await Promise.all([
      sb.from('atenciones_med').select('cita_id, sintomatologia, nota, atendido_at, padecimiento:padecimientos_med(nombre)').in('cita_id', ids).then((r) => must(r).data),
      sb.from('v_movimientos_med').select('cita_id, medicamento, unidad, cantidad, tipo, motivo').in('cita_id', ids).then((r) => must(r).data),
    ]) : [[], []];
  } catch (err) { toast(errMsg(err), 'error'); return; }
  const at = new Map(atenciones.map((x) => [x.cita_id, x]));
  const atendidas = citas.filter((x) => x.estado === 'atendida');
  const inasist = citas.filter((x) => x.estado === 'no_asistio').length;
  const pads = {};
  atenciones.forEach((x) => { const n = x.padecimiento?.nombre || 'Sin clasificar'; pads[n] = (pads[n] || 0) + 1; });
  const topPads = Object.entries(pads).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const items = citas.map((x) => {
    const a = at.get(x.id);
    const m = meds.filter((y) => y.cita_id === x.id);
    return `<li class="hist-item st-${esc(x.estado)}">
      <div class="hist-head"><button type="button" class="link-btn mono" data-hist="${esc(x.id)}">${esc(x.folio_txt)}</button>
        <span>${esc(fmtDate(x.fecha))} · ${esc(x.hora ? `${fmtTime(x.hora)} h` : 'Sin horario')}</span>${estadoPill(x.estado)}${x.tipo === 'urgente' ? pill('Urgente', 'bad') : ''}</div>
      <div class="hist-body"><b>${esc(MOTIVOS[x.motivo] || x.motivo)}</b>${a?.padecimiento?.nombre ? ` · ${esc(a.padecimiento.nombre)}` : ''}
        ${a?.sintomatologia ? `<p><small>Sintomatología:</small> ${esc(a.sintomatologia)}</p>` : ''}
        ${a?.nota ? `<p><small>Nota:</small> ${esc(a.nota)}</p>` : ''}
        ${m.length ? `<p><small>Medicamentos:</small> ${m.map((y) => `${esc(y.medicamento)} (${esc(y.tipo === 'uso' ? y.motivo : cantUnidad(-y.cantidad, y.unidad))})`).join(', ')}</p>` : ''}</div></li>`;
  }).join('');
  await openModal({
    title: `Historial · ${c.nombre}`, size: 'lg',
    subtitle: [c.num_empleado, c.area?.nombre, c.puesto].filter(Boolean).join(' · '),
    body: `
      <div class="notice">${icon('shield-check')}<span>Información confidencial: solo la ven los administradores. No la compartas fuera de Servicio Médico.</span></div>
      <div class="detail-grid">
        <div class="info-box"><small>Consultas atendidas</small><b>${fmtNum(atendidas.length)}</b></div>
        <div class="info-box"><small>Inasistencias</small><b>${fmtNum(inasist)}</b></div>
        <div class="info-box"><small>Última atención</small><b>${atendidas[0] ? esc(fmtDate(atendidas[0].fecha)) : '—'}</b></div>
        <div class="info-box"><small>Padecimientos más frecuentes</small><b>${topPads.length ? topPads.map(([n, k]) => `${esc(n)} (${k})`).join(', ') : '—'}</b></div>
      </div>
      ${citas.length ? `<ul class="hist-list">${items}</ul>` : '<p class="hint">Este colaborador aún no tiene citas registradas.</p>'}`,
    onOpen: ({ wrap, close }) => {
      refreshIcons();
      wrap.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-hist]'); if (!b) return;
        close(); await ganchos.openDetalle?.(b.dataset.hist);
      });
    },
  });
}

function initAreas() {
  if (!areasTable) {
    areasTable = new DataTable(root.querySelector('#areas-table'), {
      sort: { key: 'nombre', asc: true },
      columns: [
        { label: 'Área', sort: 'nombre', render: (a) => `<span class="cell-main">${esc(a.nombre)}</span>` },
        { label: 'Colaboradores', cls: 'num', render: (a) => fmtNum(a.colaboradores_med?.[0]?.count ?? 0) },
        { label: 'Estado', render: (a) => (a.activo ? pill('Activa', 'ok') : pill('Inactiva', 'gray')) },
        { label: 'Acciones', cls: 'actions', render: (a) => `<div class="row-actions">
          <button class="icon-btn" data-aa="editar" data-id="${esc(a.id)}" title="Editar" aria-label="Editar">${icon('pencil')}</button>
          <button class="icon-btn ${a.activo ? 'warn' : 'ok'}" data-aa="toggle" data-id="${esc(a.id)}" title="${a.activo ? 'Desactivar' : 'Activar'}" aria-label="${a.activo ? 'Desactivar' : 'Activar'}">${icon(a.activo ? 'eye-off' : 'eye')}</button>
          <button class="icon-btn bad" data-aa="eliminar" data-id="${esc(a.id)}" title="Eliminar" aria-label="Eliminar">${icon('trash-2')}</button></div>` },
      ],
      empty: { ico: 'building-2', title: 'Sin áreas', text: 'Registra las áreas de la empresa.' },
      fetch: async ({ from, to, sort }) => {
        const { data, count } = must(await paged(sb.from('areas_med').select('id, nombre, activo, colaboradores_med(count)', { count: 'exact' }), { from, to, sort }));
        return { rows: data, count };
      },
    });
  }
  areasTable.load();
}

// ---------- Formularios ----------
export async function openColaboradorForm({ colaborador = null, nombre = '', areaId = '' } = {}) {
  let areas;
  try { areas = await getAreas({ soloActivas: true }); } catch (err) { toast(errMsg(err), 'error'); return false; }
  if (!areas.length && !state.isAdmin) { toast('Primero un administrador debe registrar al menos un área activa.', 'warning'); return false; }
  const c = colaborador || (areaId ? { area_id: areaId } : null);
  const editando = !!colaborador;
  return openModal({
    title: editando ? 'Editar colaborador' : 'Nuevo colaborador',
    subtitle: editando ? '' : 'Registra a la persona que recibirá atención.',
    submitText: editando ? 'Guardar cambios' : 'Registrar',
    body: `
      <div class="form-grid">
        <div class="field full"><label for="k-nombre">Nombre completo <span class="req">*</span></label>
          <input id="k-nombre" name="nombre" required minlength="3" maxlength="120" autocomplete="off" value="${esc(c?.nombre || nombre)}"></div>
        <div class="field full"><label for="k-area-sel">Área <span class="req">*</span></label>
          <select id="k-area-sel" name="area_id" required><option value="">Selecciona…</option>
            ${areas.map((a) => `<option value="${esc(a.id)}" ${c?.area_id === a.id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}
            ${editando && !areas.some((a) => a.id === c.area_id) ? `<option value="${esc(c.area_id)}" selected>${esc(c.area?.nombre || 'Área inactiva')}</option>` : ''}
          </select>
          ${state.isAdmin ? '<small class="hint">¿No aparece? Elige “+ Registrar nueva área…”.</small>' : ''}</div>
        <div class="field full"><label for="k-puesto">Puesto</label>
          <input id="k-puesto" name="puesto" maxlength="100" autocomplete="off" value="${esc(c?.puesto || (editando ? '' : 'Auxiliar'))}"></div>
      </div>`,
    onOpen: ({ form }) => permitirNuevaArea(form.elements.area_id),
    onSubmit: async ({ form }) => {
      if (!checkForm(form, {
        nombre: (v) => (/[<>{}]/.test(v) ? 'El nombre contiene caracteres no permitidos.' : ''),
      })) return false;
      const v = formValues(form);
      const payload = { nombre: v.nombre.replace(/\s+/g, ' '), area_id: v.area_id, puesto: nullIfEmpty(v.puesto) };
      const sel = 'id, nombre, num_empleado, area_id, area:areas_med(nombre)';
      const { data } = editando
        ? must(await sb.from('colaboradores_med').update(payload).eq('id', c.id).select(sel).single())
        : must(await sb.from('colaboradores_med').insert(payload).select(sel).single());
      toast(editando ? 'Colaborador actualizado.' : `${data.nombre} registrado.`, 'success');
      return data;
    },
  });
}

async function openAreaForm(area = null) {
  return openModal({
    title: area ? 'Editar área' : 'Nueva área', size: 'sm', submitText: area ? 'Guardar' : 'Registrar',
    body: `<div class="field"><label for="ar-nombre">Nombre del área <span class="req">*</span></label>
      <input id="ar-nombre" name="nombre" required minlength="2" maxlength="80" value="${esc(area?.nombre || '')}" autocomplete="off"></div>`,
    onSubmit: async ({ form }) => {
      if (!checkForm(form)) return false;
      const nombre = formValues(form).nombre.replace(/\s+/g, ' ');
      if (area) must(await sb.from('areas_med').update({ nombre }).eq('id', area.id).select('id').single());
      else must(await sb.from('areas_med').insert({ nombre }).select('id').single());
      invalidateAreas();
      toast(area ? 'Área actualizada.' : 'Área registrada.', 'success');
    },
  });
}
