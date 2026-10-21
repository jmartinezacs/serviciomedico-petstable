// =====================================================================
// Núcleo compartido: cliente Supabase, estado de sesión y utilidades UI.
// =====================================================================
const cfg = window.MED_CONFIG || {};
export const TZ = 'America/Mexico_City';
export const APP_VERSION = cfg.APP_VERSION || '1.0.0';

// ---------- Almacenamiento de sesión ("Mantener sesión") ----------
function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }
export const prefs = {
  get: (k) => safe(() => localStorage.getItem(k), null),
  set: (k, v) => safe(() => localStorage.setItem(k, v)),
  del: (k) => safe(() => localStorage.removeItem(k)),
};
const memory = new Map();
function activeStore() {
  const remember = prefs.get('med.remember') !== '0';
  return safe(() => (remember ? window.localStorage : window.sessionStorage), null);
}
const authStorage = {
  getItem: (k) => safe(() => activeStore()?.getItem(k), null) ?? memory.get(k) ?? null,
  setItem: (k, v) => { if (safe(() => (activeStore()?.setItem(k, v), true), false) !== true) memory.set(k, v); },
  removeItem: (k) => { memory.delete(k); safe(() => localStorage.removeItem(k)); safe(() => sessionStorage.removeItem(k)); },
};

if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
  throw new Error('Configuración de Supabase no disponible.');
}
export const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: authStorage, storageKey: 'med-auth' },
});

export const state = { session: null, profile: null, isAdmin: false, isMedico: false };
// Funciones que un módulo publica para otro sin importarlo (evita dependencias circulares)
export const ganchos = {};

// ---------- Formato y fechas ----------
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function nowHHMM() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
}
export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
export function isoDow(iso) { const d = new Date(iso + 'T12:00:00Z').getUTCDay(); return d === 0 ? 7 : d; }
export function isWeekday(iso) { const d = isoDow(iso); return d >= 1 && d <= 5; }
export const fmtDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');
export const fmtTime = (t) => (t ? String(t).slice(0, 5) : '—');
export function fmtDateTime(ts) {
  if (!ts) return '—';
  return new Intl.DateTimeFormat('es-MX', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts));
}
export function fmtLongDate(iso) {
  return new Intl.DateTimeFormat('es-MX', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso + 'T12:00:00Z'));
}
export function monthShort(iso) {
  return new Intl.DateTimeFormat('es-MX', { timeZone: 'UTC', month: 'short' }).format(new Date(iso + 'T12:00:00Z')).replace('.', '');
}
export const fmtNum = (n) => new Intl.NumberFormat('es-MX').format(Number(n || 0));

// ---------- Inventario en doble unidad ----------
// La existencia se guarda en unidad mínima (tableta, ml…); "contenido_empaque" = unidades por caja/frasco.
export function plural(w, n) {
  w = String(w || '');
  if (Math.abs(Number(n)) === 1 || /^(ml|mg|g|l|kg|mcg|ui)$/i.test(w)) return w;
  if (/[aeiouáéíóú]$/i.test(w)) return `${w}s`;
  if (/z$/i.test(w)) return `${w.slice(0, -1)}ces`;
  return `${w}es`;
}
export const cantUnidad = (n, unidad) => `${fmtNum(n)} ${plural(unidad, n)}`;
// "3 cajas" · "2 cajas + 15 tabletas" · "menos de 1 caja"
export function equivEmpaque(n, m) {
  const c = Number(m?.contenido_empaque) || 1;
  n = Math.abs(Number(n) || 0);
  if (c <= 1 || !n) return '';
  const e = Math.floor(n / c), r = n % c;
  if (!e) return `menos de 1 ${m.empaque}`;
  return r ? `${fmtNum(e)} ${plural(m.empaque, e)} + ${cantUnidad(r, m.unidad)}` : `${fmtNum(e)} ${plural(m.empaque, e)}`;
}
// Celda estándar: el inventario se lleva siempre en una sola unidad (tableta, pieza, tubo…)
export function existenciaHTML(n, m, cls = '') {
  return `<b class="${cls}">${esc(cantUnidad(n, m.unidad))}</b>`;
}
export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}
// Inicio del día (MX, UTC-6 sin horario de verano desde 2022) en ISO para filtrar timestamps
export const dayStartTs = (iso) => `${iso}T00:00:00-06:00`;
export const dayEndTs = (iso) => `${addDays(iso, 1)}T00:00:00-06:00`;

// ---------- Catálogos de negocio ----------
export const SLOTS = (() => {
  const out = [];
  for (let m = 9 * 60; m <= 17 * 60 + 10; m += 20) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  return out;
})();
// Bloque de la agenda al que pertenece una hora libre del médico (10:05 → 10:00).
// Fuera de 09:00–17:19 devuelve la misma hora (no corresponde a ningún bloque).
export function slotDe(hhmm) {
  if (!hhmm) return hhmm;
  const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number);
  const t = h * 60 + m;
  if (t < 9 * 60 || t >= 17 * 60 + 20) return String(hhmm).slice(0, 5);
  const s = 9 * 60 + Math.floor((t - 9 * 60) / 20) * 20;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
export const MOTIVOS = {
  consulta_general: 'Consulta general', malestar: 'Malestar', curacion: 'Curación',
  seguimiento: 'Seguimiento', toma_signos: 'Toma de signos vitales', otro: 'Otro',
};
export const ESTADOS = {
  pendiente: { label: 'Pendiente', cls: 'warn', icon: 'clock' },
  confirmada: { label: 'Confirmada', cls: 'info', icon: 'calendar-check' },
  atendida: { label: 'Atendida', cls: 'ok', icon: 'check-circle-2' },
  cancelada: { label: 'Cancelada', cls: 'gray', icon: 'x-circle' },
  no_asistio: { label: 'No asistió', cls: 'bad', icon: 'user-x' },
};
export const pill = (text, cls = 'gray') => `<span class="pill ${cls}">${esc(text)}</span>`;
export const estadoPill = (e) => pill(ESTADOS[e]?.label || e, ESTADOS[e]?.cls || 'gray');
export const icon = (name, cls = '') => `<i data-lucide="${name}"${cls ? ` class="${cls}"` : ''}></i>`;
export function refreshIcons() { try { window.lucide?.createIcons(); } catch { /* sin íconos */ } }

export function sanitizeSearch(q) { return String(q || '').replace(/[%,()*\\"'`;:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60); }
export function debounce(fn, ms = 300) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------- Errores ----------
const CONSTRAINT_MSG = {
  citas_med_bloque_uk: 'Ese horario ya está ocupado. Elija otro.',
  citas_med_dia_habil_ck: 'Las citas solo pueden agendarse de lunes a viernes.',
  citas_med_horario_ck: 'El horario debe estar entre 09:00 y 17:00 en bloques de 20 minutos (último bloque 17:00 a 17:20).',
  colaboradores_med_num_uk: 'Ya existe un colaborador con ese número de empleado.',
  medicamentos_med_clave_uk: 'Ya existe un medicamento con esa clave.',
  areas_med_nombre_uk: 'Ya existe un área con ese nombre.',
  usuarios_med_email_uk: 'Ese correo ya está registrado.',
  usuarios_med_email_check: 'El correo debe ser del dominio @petstable.mx.',
  dias_sin_servicio_med_dia_uk: 'Ese día ya está marcado como sin servicio.',
  dias_sin_servicio_med_horas_ck: 'La hora final debe ser posterior a la inicial.',
  config_med_aviso_url_check: 'La dirección del aviso de privacidad debe empezar con https://',
  config_med_dias_cobertura_check: 'La cobertura objetivo debe estar entre 7 y 365 días.',
};
export function errMsg(err) {
  if (!err) return 'Ocurrió un error inesperado.';
  const msg = err.message || String(err);
  for (const [k, v] of Object.entries(CONSTRAINT_MSG)) if (msg.includes(k) || err.details?.includes?.(k)) return v;
  if (err.code === '23505') return 'El registro ya existe (dato duplicado).';
  if (err.code === '23503') return 'No se puede eliminar porque tiene registros relacionados. Puede desactivarlo en su lugar.';
  if (err.code === '23514') return 'Algún dato no cumple las reglas de validación.';
  if (err.code === '42501') return msg.includes('permission denied') || msg.includes('row-level security') ? 'No tiene permiso para realizar esta acción.' : msg;
  if (err.code === 'P0001') return msg;
  if (/row-level security|permission denied|Unauthorized/i.test(msg)) return 'No tiene permiso para realizar esta acción.';
  if (/exceeded the maximum allowed size|Payload too large/i.test(msg)) return 'El archivo es demasiado grande.';
  if (err.code === 'PGRST301' || /JWT expired|invalid JWT/i.test(msg)) return 'Su sesión expiró. Vuelva a iniciar sesión.';
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) return 'No hay conexión con el servidor. Verifique su red e intente de nuevo.';
  return msg;
}
// Lanza el error de una respuesta de Supabase
export function must(res) { if (res.error) throw res.error; return res; }

// ---------- Toasts ----------
export function toast(message, type = 'info', ms = 4200) {
  const root = document.getElementById('toasts');
  const el = document.createElement('div');
  const ic = { success: 'check-circle-2', error: 'alert-octagon', warning: 'alert-triangle', info: 'info' }[type] || 'info';
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(ic)}<div class="t-body">${esc(message)}</div><button type="button" aria-label="Cerrar">${icon('x')}</button>`;
  el.querySelector('button').addEventListener('click', () => el.remove());
  root.appendChild(el); refreshIcons();
  setTimeout(() => el.remove(), type === 'error' ? Math.max(ms, 7000) : ms);
}

// ---------- Modales ----------
let modalDepth = 0;
export function openModal({ title, subtitle = '', body = '', submitText = 'Guardar', onSubmit = null, size = '', danger = false, onOpen = null, confirmDiscard = true }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <form class="modal-box ${size}" role="dialog" aria-modal="true" aria-labelledby="mt-${modalDepth}" novalidate>
        <header class="modal-head">
          <div><h3 id="mt-${modalDepth}">${esc(title)}</h3>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
          <button type="button" class="icon-btn" data-close aria-label="Cerrar">${icon('x')}</button>
        </header>
        <div class="modal-body">${body}</div>
        <footer class="modal-foot">
          ${onSubmit
            ? `<div class="form-error" role="alert"></div>
               <button type="button" class="btn secondary" data-close>Cancelar</button>
               <button type="submit" class="btn ${danger ? 'danger' : 'primary'}" data-submit>${esc(submitText)}</button>`
            : `<button type="button" class="btn secondary" data-close>Cerrar</button>`}
        </footer>
      </form>`;
    modalDepth++;
    root.appendChild(wrap);
    document.body.classList.add('modal-open');
    const form = wrap.querySelector('form');
    const errBox = wrap.querySelector('.form-error');
    let dirty = false, busy = false, result;
    form.addEventListener('input', () => { dirty = true; });

    const finish = () => {
      wrap.remove(); modalDepth--;
      document.removeEventListener('keydown', onKey);
      if (!root.children.length) document.body.classList.remove('modal-open');
      resolve(result);
    };
    const close = async (force = false) => {
      if (busy) return;
      if (!force && dirty && onSubmit && confirmDiscard) {
        const ok = await confirmDialog({ title: '¿Descartar cambios?', message: 'Hay información capturada que no se ha guardado.', confirmText: 'Descartar', danger: true });
        if (!ok) return;
      }
      finish();
    };
    const onKey = (e) => { if (e.key === 'Escape' && root.lastElementChild === wrap) { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });

    const ctx = {
      form, wrap,
      setError: (m) => { if (errBox) errBox.textContent = m || ''; },
      close: (value) => { result = value; finish(); },
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!onSubmit || busy) return;
      ctx.setError('');
      const btn = form.querySelector('[data-submit]');
      busy = true; btn.disabled = true;
      const label = btn.innerHTML; btn.innerHTML = `<span class="spinner sm"></span> Guardando…`;
      try {
        const r = await onSubmit(ctx);
        if (r !== false) { result = r === undefined ? true : r; busy = false; finish(); return; }
      } catch (err) {
        console.error(err);
        ctx.setError(errMsg(err));
      }
      busy = false; btn.disabled = false; btn.innerHTML = label; refreshIcons();
    });
    refreshIcons();
    onOpen?.(ctx);
    setTimeout(() => form.querySelector('input:not([type=hidden]):not([disabled]), select, textarea')?.focus({ preventScroll: true }), 30);
  });
}

// Confirmación (opcionalmente con texto obligatorio, p. ej. motivo de cancelación)
export function confirmDialog({ title, message = '', confirmText = 'Confirmar', danger = false, input = null }) {
  const body = `<p style="margin:0 0 6px">${esc(message)}</p>
    ${input ? `<div class="field"><label for="cd-input">${esc(input.label)} ${input.required ? '<span class="req">*</span>' : ''}</label>
      <textarea id="cd-input" name="value" maxlength="${input.maxlength || 300}" ${input.required ? 'required' : ''} placeholder="${esc(input.placeholder || '')}"></textarea></div>` : ''}`;
  return openModal({
    title, body, submitText: confirmText, danger, size: 'sm', confirmDiscard: false,
    onSubmit: ({ form }) => {
      if (input) {
        if (!checkForm(form)) return false;
        return { value: form.elements.value.value.trim() };
      }
      return true;
    },
  }).then((r) => r || false);
}

// ---------- Validación de formularios ----------
function validityMessage(el) {
  const v = el.validity;
  if (v.valueMissing) return 'Campo obligatorio.';
  if (v.typeMismatch) return el.type === 'email' ? 'Correo electrónico inválido.' : 'Formato inválido.';
  if (v.patternMismatch) return el.dataset.patternMsg || 'Formato inválido.';
  if (v.tooShort) return `Mínimo ${el.minLength} caracteres.`;
  if (v.tooLong) return `Máximo ${el.maxLength} caracteres.`;
  if (v.rangeUnderflow) return `El valor mínimo es ${el.min}.`;
  if (v.rangeOverflow) return `El valor máximo es ${el.max}.`;
  if (v.stepMismatch) return 'Use un número entero.';
  if (v.badInput) return 'Valor inválido.';
  return 'Valor inválido.';
}
export function fieldError(el, msg) {
  const field = el.closest('.field') || el.parentElement;
  field.classList.add('invalid');
  const s = document.createElement('small'); s.className = 'field-error'; s.textContent = msg;
  field.appendChild(s);
}
export function clearErrors(form) {
  form.querySelectorAll('.field-error').forEach((e) => e.remove());
  form.querySelectorAll('.invalid').forEach((e) => e.classList.remove('invalid'));
}
export function checkForm(form, custom = {}) {
  clearErrors(form);
  let first = null;
  for (const el of form.elements) {
    if (!el.name || el.disabled || el.type === 'button' || el.type === 'submit') continue;
    let msg = '';
    if (el.required && typeof el.value === 'string' && el.type !== 'radio' && !el.value.trim()) msg = 'Campo obligatorio.';
    else if (el.willValidate && !el.checkValidity()) msg = validityMessage(el);
    if (!msg && custom[el.name]) msg = custom[el.name](el.value, form) || '';
    if (msg && !el.closest('.field')?.classList.contains('invalid')) { fieldError(el, msg); first ??= el; }
  }
  if (first) (first._cs?.btn || first).focus();
  return !first;
}
export function formValues(form) {
  const o = {};
  for (const [k, v] of new FormData(form).entries()) o[k] = typeof v === 'string' ? v.trim() : v;
  return o;
}
export const nullIfEmpty = (v) => (v === '' || v === undefined ? null : v);

// Contadores de caracteres en textareas con data-counter
export function bindCounters(root) {
  root.querySelectorAll('textarea[maxlength][data-counter]').forEach((ta) => {
    const lab = root.querySelector(`label[for="${ta.id}"]`);
    if (!lab) return;
    const c = document.createElement('span'); c.className = 'counter'; lab.appendChild(c);
    const upd = () => { c.textContent = `${ta.value.length}/${ta.maxLength}`; };
    ta.addEventListener('input', upd); upd();
  });
}

// ---------- Estados vacíos ----------
export function emptyState({ ico = 'inbox', title, text = '', action = '' }) {
  return `<div class="empty"><div class="empty-ico">${icon(ico)}</div><b>${esc(title)}</b>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
}
export function errorState(err, retryAction = 'retry') {
  return `<div class="empty error"><div class="empty-ico">${icon('wifi-off')}</div><b>No se pudo cargar la información</b><p>${esc(errMsg(err))}</p>
    <button class="btn secondary" data-action="${retryAction}">${icon('refresh-cw')} Reintentar</button></div>`;
}

// ---------- Tabla con paginación y orden en servidor ----------
export class DataTable {
  /**
   * @param {HTMLElement} el contenedor
   * @param {{columns: Array, fetch: Function, pageSize?: number, sort?: {key:string, asc:boolean}, empty?: object, rowKey?: string}} opts
   * columns: [{ key, label, sort?: 'columna', cls?, render(row) }]
   * fetch({ from, to, sort, filters }) => Promise<{ rows, count }>
   */
  constructor(el, opts) {
    this.el = el; this.o = opts;
    this.page = 1; this.size = opts.pageSize || prefsNum('med.pagesize', 10);
    this.sort = opts.sort || null; this.filters = {};
    this.rows = []; this.count = 0; this.token = 0;
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('change', (e) => {
      if (e.target.matches('[data-pagesize]')) { this.size = Number(e.target.value); prefs.set('med.pagesize', String(this.size)); this.page = 1; this.load(); }
    });
  }
  setFilters(f) { this.filters = { ...this.filters, ...f }; this.page = 1; return this.load(); }
  row(id) { return this.rows.find((r) => String(r[this.o.rowKey || 'id']) === String(id)); }
  onClick(e) {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      this.sort = this.sort?.key === key ? { key, asc: !this.sort.asc } : { key, asc: true };
      this.page = 1; this.load(); return;
    }
    const pg = e.target.closest('[data-page]');
    if (pg && !pg.disabled) { this.page = Number(pg.dataset.page); this.load(); return; }
    if (e.target.closest('[data-action="retry"]')) this.load();
  }
  async load() {
    const t = ++this.token;
    const from = (this.page - 1) * this.size, to = from + this.size - 1;
    if (!this.rendered) this.el.innerHTML = this.skeleton();
    else this.el.querySelector('.table-wrap')?.classList.add('table-loading');
    try {
      const { rows, count } = await this.o.fetch({ from, to, sort: this.sort, filters: this.filters });
      if (t !== this.token) return;
      this.rows = rows || []; this.count = count ?? this.rows.length;
      const pages = Math.max(1, Math.ceil(this.count / this.size));
      if (this.page > pages && this.count > 0) { this.page = pages; return this.load(); }
      this.render();
    } catch (err) {
      if (t !== this.token) return;
      console.error(err);
      this.rendered = false;
      this.el.innerHTML = errorState(err);
      refreshIcons();
    }
  }
  skeleton() {
    return `<div class="table-wrap"><table class="table"><tbody>${Array.from({ length: 5 }, () => `<tr>${this.o.columns.map(() => '<td><div class="skeleton"></div></td>').join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  render() {
    const { columns, empty } = this.o;
    if (!this.rows.length) {
      const filtered = Object.values(this.filters).some((v) => v !== '' && v != null && v !== false);
      this.el.innerHTML = emptyState(filtered
        ? { ico: 'search-x', title: 'Sin resultados', text: 'No hay registros que coincidan con los filtros aplicados.' }
        : (empty || { title: 'Sin registros' }));
      this.rendered = false; refreshIcons(); return;
    }
    const head = columns.map((c) => {
      const sorted = c.sort && this.sort?.key === c.sort;
      const ind = c.sort ? `<span class="sort-ind">${sorted ? (this.sort.asc ? '▲' : '▼') : '↕'}</span>` : '';
      return `<th class="${c.cls || ''} ${c.sort ? 'sortable' : ''} ${sorted ? 'sorted' : ''}" ${c.sort ? `data-sort="${c.sort}" aria-sort="${sorted ? (this.sort.asc ? 'ascending' : 'descending') : 'none'}"` : ''}>${esc(c.label)}${ind}</th>`;
    }).join('');
    const body = this.rows.map((r) => `<tr data-id="${esc(r[this.o.rowKey || 'id'])}">${columns.map((c) =>
      `<td class="${c.cls || ''}" data-label="${esc(c.label)}"><div class="td-in">${c.render ? c.render(r) : esc(r[c.key])}</div></td>`).join('')}</tr>`).join('');
    const pages = Math.max(1, Math.ceil(this.count / this.size));
    const from = (this.page - 1) * this.size + 1, to = Math.min(this.count, this.page * this.size);
    this.el.innerHTML = `
      <div class="table-wrap responsive"><table class="table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <div class="pager">
        <span>Mostrando <b>${fmtNum(from)}–${fmtNum(to)}</b> de <b>${fmtNum(this.count)}</b></span>
        <div class="pager-ctrl">
          <label class="sr-only" for="ps-${this.token}">Registros por página</label>
          <select id="ps-${this.token}" data-pagesize>${[10, 25, 50].map((n) => `<option value="${n}" ${n === this.size ? 'selected' : ''}>${n} por página</option>`).join('')}</select>
          <button class="icon-btn" data-page="1" ${this.page <= 1 ? 'disabled' : ''} aria-label="Primera página">${icon('chevrons-left')}</button>
          <button class="icon-btn" data-page="${this.page - 1}" ${this.page <= 1 ? 'disabled' : ''} aria-label="Página anterior">${icon('chevron-left')}</button>
          <span>Pág. ${this.page} / ${pages}</span>
          <button class="icon-btn" data-page="${this.page + 1}" ${this.page >= pages ? 'disabled' : ''} aria-label="Página siguiente">${icon('chevron-right')}</button>
          <button class="icon-btn" data-page="${pages}" ${this.page >= pages ? 'disabled' : ''} aria-label="Última página">${icon('chevrons-right')}</button>
        </div>
      </div>`;
    this.rendered = true;
    refreshIcons();
  }
}
function prefsNum(k, d) { const n = Number(prefs.get(k)); return [10, 25, 50].includes(n) ? n : d; }

// Aplica orden y rango a una consulta de Supabase
export function paged(q, { from, to, sort }, extraOrder = []) {
  if (sort) q = q.order(sort.key, { ascending: sort.asc, nullsFirst: false });
  for (const [k, asc] of extraOrder) q = q.order(k, { ascending: asc });
  return q.range(from, to);
}

// ---------- Gráficas ----------
const charts = new Set();
export function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
export const PALETTE = ['#F58020', '#1BC7C7', '#0B2235', '#1BB56F', '#7A5BE6', '#E0464E', '#FFB020', '#5B8DEF'];
// Etiqueta de datos: el valor centrado dentro de cada barra o segmento de pastel
// (se dibuja en el canvas, así que también aparece al copiar la gráfica)
const etiquetasDatos = {
  id: 'medEtiquetas',
  afterDatasetsDraw(chart) {
    const tipo = chart.config.type;
    if (!['bar', 'doughnut', 'pie'].includes(tipo)) return;
    const { ctx } = chart;
    const horiz = chart.options.indexAxis === 'y';
    ctx.save();
    ctx.font = '800 11px Inter, Segoe UI, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden || meta.type === 'line') return;
      meta.data.forEach((el, i) => {
        const v = Number(ds.data[i]);
        if (!v || el.hidden) return;
        const label = new Intl.NumberFormat('es-MX').format(v);
        let x, y, dentro = true;
        if (tipo === 'bar') {
          const p = el.getProps(['x', 'y', 'base'], true);
          const largo = horiz ? Math.abs(p.x - p.base) : Math.abs(p.base - p.y);
          const ancho = ctx.measureText(label).width + 6;
          dentro = largo >= (horiz ? ancho : 16);
          if (dentro) { x = horiz ? (p.x + p.base) / 2 : p.x; y = horiz ? p.y : (p.y + p.base) / 2; }
          else { x = horiz ? p.x + ancho / 2 + 2 : p.x; y = horiz ? p.y : p.y - 9; }
        } else {
          if (el.circumference < 0.12) return;
          ({ x, y } = el.tooltipPosition(true));
        }
        if (dentro) {
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(9, 13, 18, .45)'; ctx.lineJoin = 'round';
          ctx.strokeText(label, x, y);
          ctx.fillStyle = '#FFFFFF';
        } else ctx.fillStyle = cssVar('--text') || '#172431';
        ctx.fillText(label, x, y);
      });
    });
    ctx.restore();
  },
};
export function makeChart(canvas, config) {
  if (!window.Chart || !canvas) return null;
  const muted = cssVar('--muted') || '#687B8C', line = cssVar('--line') || '#E3EAEF', text = cssVar('--text') || '#172431';
  window.Chart.defaults.font.family = 'Inter, Segoe UI, system-ui, sans-serif';
  window.Chart.defaults.color = muted;
  const c = new window.Chart(canvas, {
    ...config,
    plugins: [...(config.plugins || []), etiquetasDatos],
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
      plugins: {
        legend: { labels: { color: text, boxWidth: 12, boxHeight: 12, usePointStyle: true }, ...(config.options?.plugins?.legend || {}) },
        tooltip: { backgroundColor: '#102536', padding: 10, cornerRadius: 10 },
      },
      scales: config.type === 'doughnut' ? {} : {
        x: { grid: { color: line, drawTicks: false }, ticks: { color: muted, precision: 0 }, border: { display: false }, ...(config.options?.scales?.x || {}) },
        y: { grid: { color: line, drawTicks: false }, ticks: { color: muted, precision: 0 }, border: { display: false }, beginAtZero: true, ...(config.options?.scales?.y || {}) },
      },
      ...(config.options?.indexAxis ? { indexAxis: config.options.indexAxis } : {}),
      ...(config.type === 'doughnut' ? { cutout: '64%' } : {}),
    },
  });
  charts.add(c);
  return c;
}
// Cambio de tema inmediato: re-colorea las gráficas sin volver a consultar datos
export function restyleCharts() {
  const muted = cssVar('--muted'), line = cssVar('--line'), text = cssVar('--text');
  charts.forEach((c) => {
    try {
      const o = c.options;
      if (o.plugins?.legend?.labels) o.plugins.legend.labels.color = text;
      for (const s of Object.values(o.scales || {})) {
        if (s.ticks) s.ticks.color = muted;
        if (s.grid) s.grid.color = line;
      }
      c.update('none');
    } catch { /* gráfica ya destruida */ }
  });
}
export function destroyCharts() { charts.forEach((c) => { try { c.destroy(); } catch { /* ya destruida */ } }); charts.clear(); }

// ---------- Catálogos en caché ligera ----------
let areasCache = null;
export async function getAreas({ force = false, soloActivas = false } = {}) {
  if (!areasCache || force) {
    const { data, error } = await sb.from('areas_med').select('id, nombre, activo').order('nombre');
    if (error) throw error;
    areasCache = data;
  }
  return soloActivas ? areasCache.filter((a) => a.activo) : areasCache;
}
export function invalidateAreas() { areasCache = null; }
// Agrega a un <select> de áreas la opción "+ Registrar nueva área…" (solo administradores
// pueden crear áreas); la nueva área queda seleccionada sin salir del formulario.
export function permitirNuevaArea(select) {
  if (!state.isAdmin || !select) return;
  select.insertAdjacentHTML('beforeend', '<option value="__nueva">+ Registrar nueva área…</option>');
  let prev = select.value;
  select.addEventListener('change', async () => {
    if (select.value !== '__nueva') { prev = select.value; return; }
    const nueva = await openModal({
      title: 'Nueva área', size: 'sm', submitText: 'Registrar área', confirmDiscard: false,
      body: `<div class="field"><label for="na-nombre">Nombre del área <span class="req">*</span></label>
        <input id="na-nombre" name="nombre" required minlength="2" maxlength="80" autocomplete="off"></div>`,
      onSubmit: async ({ form }) => {
        if (!checkForm(form)) return false;
        const nombre = form.elements.nombre.value.trim().replace(/\s+/g, ' ');
        const { data } = must(await sb.from('areas_med').insert({ nombre }).select('id, nombre').single());
        invalidateAreas();
        toast(`Área "${data.nombre}" registrada.`, 'success');
        return data;
      },
    });
    if (nueva?.id) {
      select.insertBefore(new Option(nueva.nombre, nueva.id), select.querySelector('option[value="__nueva"]'));
      prev = nueva.id;
    }
    select.value = prev;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

// ---------- Días u horarios sin servicio (festivos, ausencias del médico) ----------
export async function getBloqueos(desde, hasta = desde) {
  const { data, error } = await sb.from('dias_sin_servicio_med').select('id, fecha, hora_inicio, hora_fin, tipo, motivo')
    .gte('fecha', desde).lte('fecha', hasta).order('fecha').order('hora_inicio', { nullsFirst: true });
  if (error) throw error;
  return data;
}
// Bloqueo que afecta a un horario (o al día completo si hora es null)
export function bloqueoDe(bloqueos, fecha, hora = null) {
  return bloqueos.find((b) => b.fecha === fecha && (!b.hora_inicio
    || (hora && hora >= fmtTime(b.hora_inicio) && hora < fmtTime(b.hora_fin)))) || null;
}
export const bloqueoTxt = (b) => (b.hora_inicio ? `${fmtTime(b.hora_inicio)} a ${fmtTime(b.hora_fin)} h` : 'Todo el día');

// ---------- Exportación de archivos ----------
// Lee todas las filas de una consulta en páginas de 1,000 (límite del servidor)
export async function fetchAll(build, max = 50000) {
  const out = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
// CSV compatible con Excel (UTF-8 con BOM, separado por comas)
export function toCSV(rows, cols) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v);
    // Evita que Excel interprete texto como fórmula
    const s = /^[=+\-@\t\r]/.test(String(v)) ? `'${v}` : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.map((c) => cell(c.label)).join(','), ...rows.map((r) => cols.map((c) => cell(c.get(r))).join(','))].join('\r\n');
}
export function descargar(nombre, contenido, tipo = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- Fotos de usuario ----------
// Avatar con foto (si existe) y respaldo de iniciales cuando la imagen no carga
export function avatarHTML(nombre, fotoUrl, cls = '') {
  const ini = esc(initials(nombre));
  if (fotoUrl && /^https:\/\//.test(fotoUrl)) {
    return `<span class="avatar has-img ${cls}" data-ini="${ini}"><img src="${esc(fotoUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
  }
  return `<span class="avatar ${cls}">${ini}</span>`;
}
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img?.tagName === 'IMG' && img.parentElement?.classList.contains('avatar')) {
    const span = img.parentElement; span.classList.remove('has-img'); span.textContent = span.dataset.ini || '?';
  }
}, true);

export const FOTO_MAX_MB = 5;
// Recorta al centro, reduce a 320×320 y convierte a JPEG antes de subir (fotos ligeras)
export async function prepararFoto(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('La foto debe ser JPG, PNG o WEBP.');
  if (file.size > FOTO_MAX_MB * 1024 * 1024) throw new Error(`La foto no debe superar ${FOTO_MAX_MB} MB.`);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('No se pudo leer la imagen.')); i.src = url; });
    const s = Math.min(img.naturalWidth, img.naturalHeight), size = 320;
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('No se pudo procesar la imagen.'))), 'image/jpeg', 0.86));
  } finally { URL.revokeObjectURL(url); }
}
export async function subirFoto(blob) {
  const path = `${crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)}.jpg`;
  const { error } = await sb.storage.from('avatares_med').upload(path, blob, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' });
  if (error) throw error;
  return sb.storage.from('avatares_med').getPublicUrl(path).data.publicUrl;
}
// Borra una foto anterior solo si pertenece al bucket propio (nunca toca "avatares")
export async function borrarFotoPropia(url) {
  const m = /\/storage\/v1\/object\/public\/avatares_med\/(.+)$/.exec(url || '');
  if (m) await sb.storage.from('avatares_med').remove([decodeURIComponent(m[1])]).catch(() => {});
}

// ---------- Menús desplegables con el estilo del sistema ----------
// Reemplaza visualmente <select> y <input list> por un menú propio. El control
// original se conserva (oculto) para validación, FormData y eventos "change".
const CHEVRON = '<svg class="cs-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
let csAbierto = null;
function csCerrar(enfocar = false) {
  if (!csAbierto) return;
  const { panel, anchor } = csAbierto;
  panel.remove(); anchor.setAttribute('aria-expanded', 'false');
  csAbierto = null;
  if (enfocar) anchor.focus();
}
function csUbicar(panel, anchor) {
  const r = anchor.getBoundingClientRect();
  const alto = Math.min(panel.scrollHeight, 300);
  const abajo = innerHeight - r.bottom;
  panel.style.width = `${Math.max(r.width, 200)}px`;
  panel.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 8 - Math.max(r.width, 200)))}px`;
  if (abajo < alto + 12 && r.top > abajo) { panel.style.top = ''; panel.style.bottom = `${innerHeight - r.top + 6}px`; }
  else { panel.style.bottom = ''; panel.style.top = `${r.bottom + 6}px`; }
}
// items: [{ value, label, disabled, selected }]; onPick(value)
function csAbrir(anchor, items, onPick) {
  csCerrar();
  if (!items.length) return;
  const panel = document.createElement('div');
  panel.className = 'cs-panel'; panel.setAttribute('role', 'listbox');
  panel.innerHTML = items.map((it, i) => `<div class="cs-opt ${it.selected ? 'sel' : ''} ${it.disabled ? 'dis' : ''} ${it.ph ? 'ph' : ''}" role="option" data-i="${i}" aria-selected="${it.selected ? 'true' : 'false'}" ${it.disabled ? 'aria-disabled="true"' : ''}>
      <span>${esc(it.label)}</span>${it.selected ? CHECK : ''}</div>`).join('');
  document.body.appendChild(panel);
  csUbicar(panel, anchor);
  anchor.setAttribute('aria-expanded', 'true');
  let hl = Math.max(0, items.findIndex((x) => x.selected));
  const pintar = () => {
    panel.querySelectorAll('.cs-opt').forEach((o, i) => o.classList.toggle('hl', i === hl));
    panel.querySelector('.cs-opt.hl')?.scrollIntoView({ block: 'nearest' });
  };
  pintar();
  const elegir = (i) => { const it = items[i]; if (!it || it.disabled) return; csCerrar(true); onPick(it.value); };
  panel.addEventListener('mousedown', (e) => e.preventDefault());
  panel.addEventListener('click', (e) => { const o = e.target.closest('.cs-opt'); if (o) elegir(Number(o.dataset.i)); });
  csAbierto = {
    panel, anchor,
    key: (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); do { hl = Math.min(items.length - 1, hl + 1); } while (items[hl]?.disabled && hl < items.length - 1); pintar(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); do { hl = Math.max(0, hl - 1); } while (items[hl]?.disabled && hl > 0); pintar(); }
      else if (e.key === 'Enter') { e.preventDefault(); elegir(hl); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); csCerrar(true); }
      else if (e.key === 'Tab') csCerrar();
      else if (e.key.length === 1 && /\S/.test(e.key) && anchor.tagName !== 'INPUT') {
        const k = e.key.toLowerCase();
        const j = items.findIndex((it, i) => i > hl && !it.disabled && it.label.toLowerCase().startsWith(k));
        const j2 = j >= 0 ? j : items.findIndex((it) => !it.disabled && it.label.toLowerCase().startsWith(k));
        if (j2 >= 0) { hl = j2; pintar(); }
      }
    },
  };
}
document.addEventListener('mousedown', (e) => {
  if (csAbierto && !csAbierto.panel.contains(e.target) && !csAbierto.anchor.contains(e.target)) csCerrar();
}, true);
document.addEventListener('scroll', (e) => { if (csAbierto && !csAbierto.panel.contains(e.target)) csCerrar(); }, true);
window.addEventListener('resize', () => csCerrar());
document.addEventListener('keydown', (e) => { if (csAbierto && (e.target === csAbierto.anchor)) csAbierto.key(e); }, true);

const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const indexDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
function mejorarSelect(sel) {
  if (sel._cs || sel.multiple || sel.size > 1 || 'native' in sel.dataset) return;
  const wrap = document.createElement('div');
  wrap.className = 'cs';
  if (sel.style.cssText) { wrap.style.cssText = sel.style.cssText; sel.style.cssText = ''; }
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  sel.classList.add('cs-native'); sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'cs-btn';
  btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
  const lab = sel.id ? document.querySelector(`label[for="${CSS.escape(sel.id)}"]`) : null;
  btn.setAttribute('aria-label', sel.getAttribute('aria-label') || lab?.textContent.replace('*', '').trim() || 'Seleccionar');
  wrap.appendChild(btn);
  const sync = () => {
    const o = sel.options[sel.selectedIndex];
    btn.innerHTML = `<span class="cs-val ${!sel.value ? 'ph' : ''}">${esc(o ? o.textContent : '—')}</span>${CHEVRON}`;
    btn.disabled = sel.disabled;
  };
  // Reflejar cambios hechos por código (value / selectedIndex / opciones / disabled)
  Object.defineProperty(sel, 'value', { configurable: true, get() { return valueDesc.get.call(this); }, set(v) { valueDesc.set.call(this, v); sync(); } });
  Object.defineProperty(sel, 'selectedIndex', { configurable: true, get() { return indexDesc.get.call(this); }, set(v) { indexDesc.set.call(this, v); sync(); } });
  new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
  sel.addEventListener('change', sync);
  btn.addEventListener('click', () => {
    if (csAbierto?.anchor === btn) { csCerrar(); return; }
    const items = [...sel.options].filter((o) => !o.hidden).map((o) => ({
      value: o.value, label: o.textContent, disabled: o.disabled, selected: o.index === sel.selectedIndex, ph: o.value === '',
    }));
    csAbrir(btn, items, (v) => {
      valueDesc.set.call(sel, v); sync();
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  btn.addEventListener('keydown', (e) => {
    if (!csAbierto && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); btn.click(); }
  });
  sel._cs = { btn, sync };
  sync();
}
function mejorarDatalist(inp) {
  if (inp._cs) return;
  const dl = document.getElementById(inp.getAttribute('list'));
  if (!dl) return;
  inp.removeAttribute('list');
  inp.setAttribute('autocomplete', 'off');
  inp.setAttribute('aria-autocomplete', 'list'); inp.setAttribute('aria-expanded', 'false');
  inp.parentElement.classList.add('cs-dl');
  const mostrar = () => {
    const q = inp.value.trim().toLowerCase();
    const items = [...dl.options].map((o) => ({ value: o.value, label: o.label && o.label !== o.value ? `${o.value} · ${o.label}` : o.value }))
      .filter((it) => !q || it.label.toLowerCase().includes(q));
    if (!items.length || (items.length === 1 && items[0].value.toLowerCase() === q)) { if (csAbierto?.anchor === inp) csCerrar(); return; }
    csAbrir(inp, items.slice(0, 50), (v) => {
      inp.value = v;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      setTimeout(() => csCerrar(), 0);
    });
  };
  inp.addEventListener('focus', mostrar);
  inp.addEventListener('input', (e) => { if (e.isTrusted) mostrar(); });
  inp.addEventListener('keydown', (e) => { if (!csAbierto && e.key === 'ArrowDown') { e.preventDefault(); mostrar(); } });
  inp._cs = { mostrar };
}
export function mejorarControles(root = document) {
  root.querySelectorAll?.('select').forEach(mejorarSelect);
  root.querySelectorAll?.('input[list]').forEach(mejorarDatalist);
}
new MutationObserver((muts) => {
  for (const m of muts) for (const n of m.addedNodes) {
    if (n.nodeType !== 1) continue;
    if (n.tagName === 'SELECT') mejorarSelect(n);
    else if (n.tagName === 'INPUT' && n.hasAttribute('list')) mejorarDatalist(n);
    else mejorarControles(n);
  }
}).observe(document.documentElement, { childList: true, subtree: true });
// Un clic en la etiqueta de un select mejorado enfoca su botón
document.addEventListener('click', (e) => {
  const lab = e.target.closest('label[for]');
  const c = lab && document.getElementById(lab.htmlFor);
  if (c?._cs?.btn) { e.preventDefault(); c._cs.btn.focus(); }
});

// ---------- Avisos (notificaciones push y correo) ----------
// Se envían en segundo plano; si fallan no afectan la operación de la cita.
export function avisar(evento, citaId) {
  try { sb.functions.invoke('notificar_med', { body: { accion: 'aviso', evento, cita_id: citaId } }).catch(() => {}); } catch { /* sin conexión */ }
}
function b64uToUint8(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
export const push = {
  soportado: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext,
  esIOS: () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  // App instalada: ventana propia o pantalla completa
  instalada: () => window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || window.navigator.standalone === true,
  async suscripcion() {
    if (!push.soportado()) return null;
    const reg = await navigator.serviceWorker.getRegistration('/');
    return reg ? reg.pushManager.getSubscription() : null;
  },
  // 'no-soportado' | 'instalar' (iOS sin instalar) | 'bloqueado' | 'activo' | 'inactivo'
  async estado() {
    if (push.esIOS() && !push.instalada()) return 'instalar';
    if (!push.soportado()) return 'no-soportado';
    if (Notification.permission === 'denied') return 'bloqueado';
    await push._sync; // espera la reactivación automática al iniciar sesión
    return (await push.suscripcion()) && Notification.permission === 'granted' ? 'activo' : 'inactivo';
  },
  // Vincula la suscripción del dispositivo a la cuenta con sesión (si era de otra cuenta, pasa a ésta)
  async guardar(sub) {
    const j = sub.toJSON();
    must(await sb.rpc('med_vincular_push', {
      p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_dispositivo: navigator.userAgent.slice(0, 200),
    }));
  },
  async activar() {
    if (!push.soportado()) throw new Error('Este navegador no admite notificaciones.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('No se concedió el permiso de notificaciones.');
    prefs.del('med.push.off');
    await push.suscribir();
  },
  // Suscribe el dispositivo (sin volver a pedir permiso si ya se concedió)
  async suscribir() {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    let { data: pub } = await sb.rpc('med_vapid_publica');
    if (!pub) {
      const r = await sb.functions.invoke('notificar_med', { body: { accion: 'init' } });
      pub = r.data?.publica;
    }
    if (!pub) throw new Error('No se pudo obtener la clave de notificaciones. Intenta más tarde.');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToUint8(pub) });
    await push.guardar(sub);
  },
  // Solo desde "Desactivar en este dispositivo" (Mi perfil); cerrar sesión ya no desactiva
  async desactivar() {
    prefs.set('med.push.off', '1');
    const sub = await push.suscripcion();
    if (sub) {
      await sb.from('push_subs_med').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe().catch(() => {});
    }
  },
  // Al iniciar sesión: las notificaciones son del dispositivo, no de la cuenta. Si ya
  // se concedió el permiso, la suscripción se vincula (o se recrea) para quien entra,
  // sin volver a preguntar. No aplica si se desactivaron a propósito en este dispositivo.
  sincronizar() {
    push._sync = (async () => {
      try {
        if (!push.soportado() || Notification.permission !== 'granted' || prefs.get('med.push.off') === '1') return;
        if (push.esIOS() && !push.instalada()) return;
        const sub = await push.suscripcion();
        if (sub) await push.guardar(sub); else await push.suscribir();
      } catch { /* silencioso */ }
    })();
    return push._sync;
  },
};

export function navigate(hash) { if (location.hash !== hash) location.hash = hash; else window.dispatchEvent(new HashChangeEvent('hashchange')); }
