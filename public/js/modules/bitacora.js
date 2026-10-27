// =====================================================================
// Bitácora de auditoría (solo administradores). Los registros se generan
// en la base de datos mediante triggers; no se pueden editar ni borrar.
// El contenido clínico de las atenciones no se replica en la bitácora.
// v_bitacora_med agrega la foto y el nombre de quien hizo la acción y el
// nombre del registro afectado para mostrar una descripción breve.
// =====================================================================
import {
  sb, esc, icon, openModal, DataTable, paged, sanitizeSearch, debounce, pill, must, fmtDateTime, fmtDate, fmtTime,
  dayStartTs, dayEndTs, avatarHTML, MOTIVOS,
} from '../core.js';
import { RESULTADOS } from './examenes.js';

const TABLAS = {
  citas_med: 'Citas', atenciones_med: 'Atenciones', colaboradores_med: 'Colaboradores', medicamentos_med: 'Medicamentos',
  lotes_med: 'Lotes', examenes_med: 'Exámenes', padecimientos_med: 'Padecimientos', dias_sin_servicio_med: 'Horarios sin servicio',
  usuarios_med: 'Usuarios', areas_med: 'Áreas', config_med: 'Configuración',
};
const ACC = { INSERT: ['Alta', 'ok'], UPDATE: ['Cambio', 'info'], DELETE: ['Baja', 'bad'] };
const CAMPOS = {
  estado: 'estado', fecha: 'fecha', hora: 'hora', motivo: 'motivo', descripcion: 'descripción', puesto: 'puesto', area_id: 'área',
  nombre: 'nombre', edad: 'edad', activo: 'estado activo', num_empleado: 'número de empleado', stock_minimo: 'stock mínimo',
  presentacion: 'presentación', unidad: 'unidad', clave: 'clave', categoria: 'categoría', control: 'control', empaque: 'empaque',
  contenido_empaque: 'contenido del empaque', existencia: 'existencia', caducidad: 'caducidad', lote: 'lote', nivel: 'nivel',
  rol: 'rol', foto_url: 'foto', recibe_avisos: 'avisos', es_medico: 'médico', email: 'correo', colaborador_id: 'colaborador',
  dias_alerta_caducidad: 'días de alerta de caducidad', dias_cobertura: 'días de cobertura', aviso_privacidad_url: 'aviso de privacidad',
  comida_inicio: 'hora de comida', comida_fin: 'hora de comida', motivo_cancelacion: 'motivo de cancelación', tipo: 'tipo',
  usuario_id: 'usuario vinculado', candidato: 'candidato', resultado: 'resultado', medicamento_id: 'medicamento',
  hora_inicio: 'hora de inicio', hora_fin: 'hora de fin',
};
const OCULTOS = new Set(['id', 'created_at', 'updated_at', 'created_by', 'cancelado_por', 'solicitado_por', 'atendido_por', 'realizado_at', 'folio']);
let root, table;

export default {
  async render(el) {
    root = el;
    el.innerHTML = `
      <section class="page-intro">
        <div><span class="eyebrow">Auditoría</span><h1>Bitácora</h1>
          <p>Registro automático de altas, cambios y bajas. Las existencias se rastrean en Inventario → Movimientos.</p></div>
      </section>
      <div class="card">
        <div class="toolbar">
          <div class="search">${icon('search')}<input type="search" id="b-q" placeholder="Buscar por usuario o persona" aria-label="Buscar"></div>
          <select id="b-tabla" aria-label="Módulo"><option value="">Todos los módulos</option>${Object.entries(TABLAS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <select id="b-acc" aria-label="Acción"><option value="">Todas las acciones</option>${Object.entries(ACC).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}</select>
          <span class="date-range"><input type="date" id="b-desde" aria-label="Desde"> a <input type="date" id="b-hasta" aria-label="Hasta"></span>
        </div>
        <div id="b-table"></div>
      </div>`;
    table = new DataTable(el.querySelector('#b-table'), {
      sort: { key: 'created_at', asc: false },
      columns: [
        { label: 'Fecha', sort: 'created_at', render: (b) => `<span class="mono">${fmtDateTime(b.created_at)}</span>` },
        { label: 'Usuario', sort: 'actor_nombre', cls: 'col-user', render: (b) => actorHTML(b) },
        { label: 'Módulo', sort: 'tabla', render: (b) => esc(TABLAS[b.tabla] || b.tabla) },
        { label: 'Acción', sort: 'accion', render: (b) => pill(...(ACC[b.accion] || [b.accion, 'gray'])) },
        { label: 'Descripción', cls: 'col-desc', render: (b) => `<span class="bit-desc">${describir(b)}</span>` },
        { label: '', cls: 'actions', render: (b) => `<button class="icon-btn" data-ba="${b.id}" title="Ver detalle" aria-label="Ver detalle">${icon('eye')}</button>` },
      ],
      onRowClick: (b) => detalle(b),
      empty: { ico: 'history', title: 'Sin registros', text: 'Los cambios en el sistema se registrarán aquí automáticamente.' },
      fetch: async ({ from, to, sort, filters: f }) => {
        let q = sb.from('v_bitacora_med').select('id, tabla, registro_id, accion, cambios, usuario_email, created_at, actor_nombre, actor_foto, actor_medico, objeto, referencia, subtipo', { count: 'exact' });
        const s = sanitizeSearch(f.q);
        if (s) q = q.or(`usuario_email.ilike.*${s}*,actor_nombre.ilike.*${s}*,objeto.ilike.*${s}*`);
        if (f.tabla) q = q.eq('tabla', f.tabla);
        if (f.acc) q = q.eq('accion', f.acc);
        if (f.desde) q = q.gte('created_at', dayStartTs(f.desde));
        if (f.hasta) q = q.lt('created_at', dayEndTs(f.hasta));
        const { data, count } = must(await paged(q, { from, to, sort }, sort?.key === 'created_at' ? [] : [['created_at', false]]));
        return { rows: data, count };
      },
    });
    const apply = () => table.setFilters({
      q: el.querySelector('#b-q').value, tabla: el.querySelector('#b-tabla').value, acc: el.querySelector('#b-acc').value,
      desde: el.querySelector('#b-desde').value, hasta: el.querySelector('#b-hasta').value,
    });
    el.querySelector('#b-q').addEventListener('input', debounce(apply, 350));
    ['#b-tabla', '#b-acc', '#b-desde', '#b-hasta'].forEach((s) => el.querySelector(s).addEventListener('change', apply));
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ba]');
      if (b) detalle(table.row(b.dataset.ba));
    });
    await apply();
  },
  destroy() { root = null; table = null; },
};

// ---------- Quién hizo la acción ----------
const actorNombre = (b) => (b.actor_nombre ? `${b.actor_medico ? 'Dr. ' : ''}${b.actor_nombre}` : b.usuario_email || 'El sistema');
function actorHTML(b) {
  if (!b.usuario_email) {
    return `<div class="user-cell"><span class="user-photo bit-sistema">${icon('cpu')}</span><div class="user-txt"><div class="cell-main">Sistema</div><div class="cell-sub">Proceso automático</div></div></div>`;
  }
  return `<div class="user-cell"><span class="user-photo">${avatarHTML(b.actor_nombre || b.usuario_email, b.actor_foto, 'sm')}</span>
    <div class="user-txt"><div class="cell-main">${esc(actorNombre(b))}</div><div class="cell-sub">${esc(b.usuario_email)}</div></div></div>`;
}

// ---------- Descripción breve ----------
const listaCampos = (b) => {
  const l = [...new Set(Object.keys(b.cambios || {}).filter((k) => !OCULTOS.has(k)).map((k) => CAMPOS[k] || k.replace(/_/g, ' ')))];
  return l.length > 1 ? `${l.slice(0, -1).join(', ')} y ${l[l.length - 1]}` : l[0] || 'datos';
};
const nuevo = (b, k) => (Array.isArray(b.cambios?.[k]) ? b.cambios[k][1] : undefined);
const cuandoTxt = (f, h) => [f ? `el ${fmtDate(f)}` : '', h ? `a las ${fmtTime(h)} h` : ''].filter(Boolean).join(' ');

function describir(b) {
  if (b.tabla === 'atenciones_med' && !b.objeto) return esc('Registró la atención de una cita (contenido clínico no auditado).');
  const A = `<b>${esc(actorNombre(b))}</b>`;
  const O = `<b>${esc(b.objeto || 'un registro')}</b>`;
  const ref = b.referencia ? ` <span class="mono cell-sub">${esc(b.referencia)}</span>` : '';
  const c = b.cambios || {};
  const ins = b.accion === 'INSERT', del = b.accion === 'DELETE';
  switch (b.tabla) {
    case 'citas_med': {
      const cita = b.subtipo === 'urgente' ? 'cita de urgencia' : 'cita';
      if (ins) return `${A} ${b.actor_medico ? 'agendó' : 'solicitó'} una ${cita} para ${O}${c.fecha ? ` ${esc(cuandoTxt(c.fecha, c.hora))}` : ''}${c.motivo ? ` · ${esc(MOTIVOS[c.motivo] || c.motivo)}` : ''}${ref}`;
      if (del) return `${A} eliminó la ${cita} de ${O}${ref}`;
      const est = nuevo(b, 'estado');
      if (est === 'confirmada') return `${A} confirmó la ${cita} de ${O}${ref}`;
      if (est === 'atendida') return `${A} atendió la ${cita} de ${O}${ref}`;
      if (est === 'cancelada') return `${A} canceló la ${cita} de ${O}${ref}`;
      if (est === 'no_asistio') return `${A} registró que ${O} no asistió a su ${cita}${ref}`;
      if (c.fecha || c.hora) return `${A} reprogramó la ${cita} de ${O}${nuevo(b, 'fecha') || nuevo(b, 'hora') ? ` ${esc(cuandoTxt(nuevo(b, 'fecha'), nuevo(b, 'hora')))}` : ''}${ref}`;
      if (c.colaborador_id) return `${A} asignó la ${cita} a ${O}${ref}`;
      return `${A} modificó ${esc(listaCampos(b))} de la ${cita} de ${O}${ref}`;
    }
    case 'atenciones_med': return `${A} registró la atención médica de ${O}`;
    case 'colaboradores_med':
      if (ins) return `${A} registró al colaborador ${O}`;
      if (del) return `${A} eliminó al colaborador ${O}`;
      if ('activo' in c) return `${A} ${nuevo(b, 'activo') ? 'reactivó' : 'dio de baja'} al colaborador ${O}`;
      if (Object.keys(c).length === 1 && c.edad) return `${A} registró la edad de ${O}: ${esc(nuevo(b, 'edad'))} años`;
      return `${A} actualizó ${esc(listaCampos(b))} de ${O}`;
    case 'medicamentos_med':
      if (ins) return `${A} dio de alta el medicamento ${O}`;
      if (del) return `${A} eliminó el medicamento ${O}`;
      if ('activo' in c) return `${A} ${nuevo(b, 'activo') ? 'reactivó' : 'desactivó'} el medicamento ${O}`;
      return `${A} modificó ${esc(listaCampos(b))} del medicamento ${O}`;
    case 'lotes_med':
      if (ins) return `${A} registró un lote de ${O}${ref}`;
      if (del) return `${A} eliminó un lote de ${O}${ref}`;
      return `${A} modificó ${esc(listaCampos(b))} de un lote de ${O}${ref}`;
    case 'usuarios_med':
      if (ins) return `${A} dio de alta al usuario ${O}`;
      if (del) return `${A} eliminó al usuario ${O}`;
      if ('activo' in c) return `${A} ${nuevo(b, 'activo') ? 'activó' : 'desactivó'} al usuario ${O}`;
      if (b.objeto && b.objeto === b.actor_nombre) return `${A} actualizó su ${esc(listaCampos(b))}`;
      return `${A} modificó ${esc(listaCampos(b))} de ${O}`;
    case 'areas_med':
      if (ins) return `${A} creó el área ${O}`;
      if (del) return `${A} eliminó el área ${O}`;
      if ('activo' in c) return `${A} ${nuevo(b, 'activo') ? 'reactivó' : 'desactivó'} el área ${O}`;
      return `${A} modificó el área ${O}`;
    case 'padecimientos_med':
      if (ins) return `${A} agregó el padecimiento ${O} al catálogo`;
      if (del) return `${A} eliminó el padecimiento ${O}`;
      return `${A} modificó el padecimiento ${O}`;
    case 'config_med': return `${A} cambió la configuración: ${esc(listaCampos(b))}`;
    case 'dias_sin_servicio_med': {
      const rango = c.hora_inicio && c.hora_fin ? ` de ${fmtTime(c.hora_inicio)} a ${fmtTime(c.hora_fin)} h` : ' (día completo)';
      if (ins) return `${A} marcó sin servicio el ${esc(c.fecha ? fmtDate(c.fecha) : '—')}${esc(rango)}`;
      if (del) return `${A} quitó el horario sin servicio del ${esc(c.fecha ? fmtDate(c.fecha) : '—')}${esc(rango)}`;
      return `${A} modificó un horario sin servicio`;
    }
    case 'examenes_med': {
      const ex = `examen de ${b.subtipo === 'egreso' ? 'egreso' : 'ingreso'}`;
      if (ins) return `${A} ${b.actor_medico ? 'programó' : 'solicitó'} un ${ex} para ${O}${c.fecha ? ` ${esc(cuandoTxt(c.fecha, c.hora))}` : ''}${ref}`;
      if (del) return `${A} eliminó el ${ex} de ${O}${ref}`;
      const est = nuevo(b, 'estado');
      if (est === 'confirmado') return `${A} confirmó el ${ex} de ${O}${c.fecha || c.hora ? ` con nuevo horario ${esc(cuandoTxt(nuevo(b, 'fecha'), nuevo(b, 'hora')))}` : ''}${ref}`;
      if (est === 'realizado') return `${A} registró el resultado del ${ex} de ${O}: <b>${esc(RESULTADOS[nuevo(b, 'resultado')]?.titulo || 'registrado')}</b>${ref}`;
      if (est === 'cancelado') return `${A} canceló el ${ex} de ${O}${ref}`;
      if (c.fecha || c.hora) return `${A} reprogramó el ${ex} de ${O} ${esc(cuandoTxt(nuevo(b, 'fecha'), nuevo(b, 'hora')))}${ref}`;
      return `${A} modificó ${esc(listaCampos(b))} del ${ex} de ${O}${ref}`;
    }
    default:
      return `${A} · ${esc(ACC[b.accion]?.[0] || b.accion)} en ${esc(TABLAS[b.tabla] || b.tabla)}`;
  }
}

// ---------- Detalle ----------
const show = (v) => (v === null || v === undefined ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const campo = (k) => `<b>${esc(CAMPOS[k] ? CAMPOS[k][0].toUpperCase() + CAMPOS[k].slice(1) : k)}</b><div class="cell-sub mono">${esc(k)}</div>`;

function detalle(b) {
  if (!b) return;
  let rows = '';
  if (b.cambios && b.accion === 'UPDATE') {
    rows = Object.entries(b.cambios).map(([k, [o, n]]) => `<tr><td>${campo(k)}</td><td class="old">${esc(show(o))}</td><td class="new">${esc(show(n))}</td></tr>`).join('');
    rows = `<table class="diff"><thead><tr><th>Campo</th><th>Antes</th><th>Después</th></tr></thead><tbody>${rows}</tbody></table>`;
  } else if (b.cambios) {
    rows = `<table class="diff"><thead><tr><th>Campo</th><th>Valor</th></tr></thead><tbody>${Object.entries(b.cambios)
      .map(([k, v]) => `<tr><td>${campo(k)}</td><td>${esc(show(v))}</td></tr>`).join('')}</tbody></table>`;
  } else rows = '<p class="hint">El contenido clínico de las atenciones no se replica en la bitácora por privacidad.</p>';
  openModal({
    title: `${TABLAS[b.tabla] || b.tabla} · ${ACC[b.accion]?.[0] || b.accion}`,
    subtitle: `${fmtDateTime(b.created_at)} · Registro ${b.registro_id}`,
    size: 'lg', body: `<div class="bit-head">${actorHTML(b)}<p class="bit-desc">${describir(b)}</p></div>${rows}`,
  });
}
