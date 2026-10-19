// =====================================================================
// Administración de usuarios (solo administradores) y configuración.
// Alta completa desde el sitio: nombre, correo, puesto, área, rol y foto.
// Si el correo no tiene cuenta de acceso, se crea con una contraseña
// temporal mediante la Edge Function "gestionar_usuarios_med" (la llave
// secreta vive solo en Supabase). Las cuentas existentes NO se modifican.
// =====================================================================
import {
  sb, state, esc, icon, toast, errMsg, openModal, confirmDialog, checkForm, formValues, DataTable, paged,
  sanitizeSearch, debounce, getAreas, pill, must, fmtDateTime, avatarHTML, prepararFoto, subirFoto,
  borrarFotoPropia, refreshIcons, fieldError, permitirNuevaArea,
} from '../core.js';

let root, table, cuentas = new Map();
const EMAIL_RE = /^[a-z0-9._%+-]+@petstable\.mx$/i;

export default {
  async render(el) {
    root = el;
    el.innerHTML = `
      <section class="page-intro">
        <div><span class="eyebrow">Administración</span><h1>Usuarios</h1>
          <p>Personas autorizadas para usar Servicio Médico: rol, puesto, foto y cuenta de acceso.</p></div>
        <div class="page-actions"><button class="btn primary" data-u="nuevo">${icon('user-plus')} Nuevo usuario</button></div>
      </section>
      <div class="tabs" role="tablist">
        <button role="tab" class="active" data-tab="usuarios">${icon('users')} Usuarios</button>
        <button role="tab" data-tab="config">${icon('settings')} Configuración</button>
      </div>
      <div data-pane="usuarios">
        <div class="card">
          <div class="toolbar">
            <div class="search">${icon('search')}<input type="search" id="u-q" placeholder="Buscar por nombre, correo o puesto" aria-label="Buscar"></div>
            <select id="u-rol" aria-label="Rol"><option value="">Todos los roles</option><option value="admin">Administrador</option><option value="usuario">Usuario</option></select>
            <select id="u-activo" aria-label="Estado"><option value="">Todos</option><option value="true">Activos</option><option value="false">Inactivos</option></select>
          </div>
          <div id="u-table"></div>
        </div>
      </div>
      <div data-pane="config" class="hidden"><div class="card" id="cfg-card"></div></div>`;

    table = new DataTable(el.querySelector('#u-table'), {
      sort: { key: 'nombre', asc: true },
      columns: [
        { label: 'Usuario', sort: 'nombre', cls: 'col-user', render: (u) => `<div class="user-cell">
            <span class="user-photo">${avatarHTML(u.nombre, u.foto_url, 'sm')}${u.recibe_avisos ? `<span class="bell-badge" title="Recibe avisos de nuevas citas" aria-label="Recibe avisos">${BELL_SVG}</span>` : ''}</span>
            <div class="user-txt"><div class="cell-main">${esc(u.nombre)}${u.id === state.profile.id ? ' <span class="cell-sub">(tú)</span>' : ''}</div>
            <div class="cell-sub">${esc(u.email)}</div></div></div>` },
        { label: 'Puesto', sort: 'puesto', render: (u) => `<div class="puesto-txt">${esc(u.puesto || '—')}</div><div class="cell-sub">${esc(u.area?.nombre || '')}</div>` },
        { label: 'Rol', sort: 'rol', render: (u) => (u.rol === 'admin' ? pill('Administrador', 'orange') : pill('Usuario', 'info')) },
        { label: 'Último acceso', render: (u) => cuentaHTML(u.email) },
        { label: 'Estado', sort: 'activo', render: (u) => (u.activo ? pill('Activo', 'ok') : pill('Inactivo', 'gray')) },
        { label: 'Acciones', cls: 'actions', render: (u) => {
          const sinCuenta = cuentas.get(u.email.toLowerCase())?.tiene_cuenta === false;
          return `<div class="row-actions">
            ${sinCuenta && u.activo ? `<button class="icon-btn ok" data-ua="cuenta" data-id="${esc(u.id)}" title="Crear cuenta de acceso" aria-label="Crear cuenta de acceso">${icon('key-round')}</button>` : ''}
            <button class="icon-btn" data-ua="editar" data-id="${esc(u.id)}" title="Editar" aria-label="Editar">${icon('pencil')}</button>
            ${u.id === state.profile.id ? '' : `<button class="icon-btn ${u.activo ? 'warn' : 'ok'}" data-ua="toggle" data-id="${esc(u.id)}" title="${u.activo ? 'Desactivar' : 'Activar'}" aria-label="${u.activo ? 'Desactivar' : 'Activar'}">${icon(u.activo ? 'user-x' : 'user-check')}</button>`}
          </div>`;
        } },
      ],
      empty: { ico: 'user-cog', title: 'Sin usuarios', text: 'Registra a las personas autorizadas.' },
      fetch: async ({ from, to, sort, filters: f }) => {
        let q = sb.from('usuarios_med').select('id, email, nombre, puesto, foto_url, rol, activo, recibe_avisos, area_id, area:areas_med(nombre)', { count: 'exact' });
        const s = sanitizeSearch(f.q);
        if (s) q = q.or(`nombre.ilike.*${s}*,email.ilike.*${s}*,puesto.ilike.*${s}*`);
        if (f.rol) q = q.eq('rol', f.rol);
        if (f.activo) q = q.eq('activo', f.activo === 'true');
        const [res, cu] = await Promise.all([paged(q, { from, to, sort }, [['nombre', true]]), sb.rpc('med_estado_cuentas')]);
        must(res);
        if (!cu.error) cuentas = new Map((cu.data || []).map((c) => [c.email.toLowerCase(), c]));
        return { rows: res.data, count: res.count };
      },
    });
    const apply = () => table.setFilters({ q: el.querySelector('#u-q').value, rol: el.querySelector('#u-rol').value, activo: el.querySelector('#u-activo').value });
    el.querySelector('#u-q').addEventListener('input', debounce(apply, 350));
    el.querySelector('#u-rol').addEventListener('change', apply);
    el.querySelector('#u-activo').addEventListener('change', apply);
    el.addEventListener('click', onClick);
    await apply();
  },
  destroy() { root = null; table = null; },
};

// Campana a color para quienes reciben avisos de nuevas citas
const BELL_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><defs><linearGradient id="bellG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFD54A"/><stop offset="1" stop-color="#F59E0B"/></linearGradient></defs>
  <path d="M12 2.5a1.6 1.6 0 0 1 1.6 1.6v.6a6.4 6.4 0 0 1 4.8 6.2v3.6l1.7 2.4a.9.9 0 0 1-.7 1.4H4.6a.9.9 0 0 1-.7-1.4l1.7-2.4v-3.6a6.4 6.4 0 0 1 4.8-6.2v-.6A1.6 1.6 0 0 1 12 2.5Z" fill="url(#bellG)" stroke="#C2410C" stroke-width=".8"/>
  <path d="M9.6 19.6a2.4 2.4 0 0 0 4.8 0Z" fill="#C2410C"/></svg>`;

// Columna "Último acceso" (sin etiquetas de cuenta)
function cuentaHTML(email) {
  const c = cuentas.get(String(email).toLowerCase());
  if (!c) return '<span class="cell-sub">—</span>';
  if (!c.tiene_cuenta) return '<span class="cell-sub" style="color:var(--bad)">Sin cuenta de acceso</span>';
  if (!c.ultimo_acceso) return '<span class="cell-sub">Aún no ha entrado</span>';
  return `<span class="mono">${fmtDateTime(c.ultimo_acceso)}</span>`;
}

async function onClick(e) {
  const t = e.target.closest('[data-tab]');
  if (t) {
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === t));
    root.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== t.dataset.tab));
    root.querySelector('[data-u="nuevo"]').classList.toggle('hidden', t.dataset.tab !== 'usuarios');
    if (t.dataset.tab === 'config') renderConfig(); else table.load();
    return;
  }
  if (e.target.closest('[data-u="nuevo"]')) { if (await openUsuarioForm()) table.load(); return; }
  if (e.target.closest('[data-cfg="retry"]')) { renderConfig(); return; }
  const a = e.target.closest('[data-ua]');
  if (!a) return;
  const u = table.row(a.dataset.id);
  if (!u) return;
  try {
    if (a.dataset.ua === 'editar' && await openUsuarioForm(u)) table.load();
    if (a.dataset.ua === 'cuenta' && await openCrearCuenta(u)) table.load();
    if (a.dataset.ua === 'toggle') {
      const ok = await confirmDialog({
        title: u.activo ? 'Desactivar usuario' : 'Activar usuario', danger: u.activo, confirmText: u.activo ? 'Desactivar' : 'Activar',
        message: u.activo ? `${u.nombre} ya no podrá entrar a Servicio Médico. Su cuenta en otras aplicaciones no se modifica.` : `${u.nombre} podrá volver a entrar a Servicio Médico.`,
      });
      if (!ok) return;
      must(await sb.from('usuarios_med').update({ activo: !u.activo }).eq('id', u.id).select('id').single());
      toast(u.activo ? 'Usuario desactivado.' : 'Usuario activado.', 'success'); table.load();
    }
  } catch (err) { toast(errMsg(err), 'error'); }
}

// ---------- Contraseña temporal ----------
function generarPassword() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz', num = '23456789', sym = '#$%*+-?';
  const pick = (s) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  const chars = [pick(abc.slice(0, 24)), pick(abc.slice(24)), pick(num), pick(sym)];
  while (chars.length < 12) chars.push(pick(abc + num));
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}
const pwRule = (v) => (v.length < 8 ? 'Mínimo 8 caracteres.' : !/[A-Za-z]/.test(v) || !/\d/.test(v) ? 'Incluye letras y números.' : '');
function passwordFieldHTML(id) {
  return `<div class="field"><label for="${id}">Contraseña temporal <span class="req">*</span></label>
      <div class="pw-wrap"><input id="${id}" name="password" type="text" autocomplete="new-password" minlength="8" maxlength="72" spellcheck="false" required>
      <button type="button" class="pw-toggle" data-genpw title="Generar contraseña" aria-label="Generar contraseña">${icon('wand-2')}</button></div>
      <small class="hint">Compártela de forma privada; la persona podrá cambiarla en <b>Mi perfil</b>.</small></div>`;
}
function bindPwGenerator(form) {
  form.querySelector('[data-genpw]')?.addEventListener('click', () => {
    form.elements.password.value = generarPassword();
    form.elements.password.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function crearCuenta(email, password) {
  const { data, error } = await sb.functions.invoke('gestionar_usuarios_med', { body: { accion: 'crear_cuenta', email, password } });
  if (error) {
    let msg = error.message;
    try { const b = await error.context?.json(); if (b?.error) msg = b.error; } catch { /* sin cuerpo */ }
    const e = new Error(msg); e.status = error.context?.status; throw e;
  }
  return data;
}

async function openCrearCuenta(u) {
  return openModal({
    title: 'Crear cuenta de acceso', subtitle: `${u.nombre} · ${u.email}`, size: 'sm', submitText: 'Crear cuenta',
    body: `<div class="notice">${icon('info')}<span>Este correo aún no tiene cuenta Pet's Table. Se creará ya confirmada con la contraseña temporal que definas.</span></div>
      ${passwordFieldHTML('cc-pw')}`,
    onOpen: ({ form }) => bindPwGenerator(form),
    onSubmit: async ({ form }) => {
      if (!checkForm(form, { password: pwRule })) return false;
      await crearCuenta(u.email, form.elements.password.value);
      toast(`Cuenta creada para ${u.nombre}. Comparte su contraseña temporal de forma privada.`, 'success', 7000);
    },
  });
}

// ---------- Alta / edición ----------
async function openUsuarioForm(u = null) {
  let areas;
  try { areas = await getAreas({ soloActivas: true }); } catch (err) { toast(errMsg(err), 'error'); return false; }
  const self = u && u.id === state.profile.id;
  let fotoBlob = null, fotoExistente = null, quitarFoto = false, cuentaEstado = u ? 'n/a' : 'pendiente', checkTok = 0, buscaTok = 0;

  return openModal({
    title: u ? 'Editar usuario' : 'Nuevo usuario', submitText: u ? 'Guardar cambios' : 'Registrar usuario', size: 'lg',
    body: `
      ${self ? `<div class="notice warn">${icon('lock')}<span>No puedes cambiar tu propio correo, rol ni estado. Pide a otro administrador que lo haga.</span></div>` : ''}
      ${u ? '' : `<div class="acc-box">
        <div class="section-title" style="margin:4px 0 6px">${icon('search')} Buscar en cuentas existentes (Supabase Authentication)</div>
        <div class="toolbar" style="margin:0"><div class="search">${icon('search')}<input type="search" id="us-busca" placeholder="Escribe nombre o correo (mín. 2 letras)" autocomplete="off" aria-label="Buscar cuentas existentes"></div></div>
        <div class="acc-results" id="us-busca-res"><span class="hint">Si la persona ya usa otra app de Pet's Table, selecciónala aquí: se llenan sus datos y su foto. Si no aparece, captura los datos abajo.</span></div>
      </div>`}
      <div class="photo-pick">
        <span id="us-prev">${avatarHTML(u?.nombre || '?', u?.foto_url)}</span>
        <div><div class="btns">
            <label class="btn secondary" for="us-foto" style="cursor:pointer">${icon('camera')} ${u?.foto_url ? 'Cambiar foto' : 'Subir foto'}</label>
            <button type="button" class="btn secondary" id="us-galeria">${icon('images')} Fotos existentes</button>
            <button type="button" class="btn ghost ${u?.foto_url ? '' : 'hidden'}" id="us-quitar">${icon('trash-2')} Quitar</button>
          </div>
          <input id="us-foto" type="file" accept="image/jpeg,image/png,image/webp" class="sr-only">
          <small class="hint">JPG, PNG o WEBP de hasta 5 MB. Se recorta en cuadrado y se optimiza automáticamente.</small></div>
      </div>
      <div class="form-grid" style="margin-top:8px">
        <div class="field full"><label for="us-nombre">Nombre completo <span class="req">*</span></label>
          <input id="us-nombre" name="nombre" required minlength="2" maxlength="120" value="${esc(u?.nombre || '')}" autocomplete="off"></div>
        <div class="field full"><label for="us-email">Correo corporativo <span class="req">*</span></label>
          <input id="us-email" name="email" type="email" required maxlength="120" autocomplete="off" value="${esc(u?.email || '')}" placeholder="nombre@petstable.mx" ${u ? 'disabled' : ''}>
          ${u ? '<small class="hint">El correo vincula la cuenta de acceso; para cambiarlo, desactiva este usuario y registra uno nuevo.</small>' : ''}</div>
        <div class="field"><label for="us-puesto">Puesto</label>
          <input id="us-puesto" name="puesto" maxlength="100" value="${esc(u?.puesto || '')}" placeholder="Ej. Médico de empresa"></div>
        <div class="field"><label for="us-area">Área</label>
          <select id="us-area" name="area_id"><option value="">Sin área</option>
            ${areas.map((a) => `<option value="${esc(a.id)}" ${u?.area_id === a.id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}</select></div>
        <div class="field full"><label for="us-rol">Rol <span class="req">*</span></label>
          <select id="us-rol" name="rol" required ${self ? 'disabled' : ''}>
            <option value="usuario" ${u?.rol === 'usuario' ? 'selected' : ''}>Usuario — solicita y consulta sus citas</option>
            <option value="admin" ${u?.rol === 'admin' ? 'selected' : ''}>Administrador — gestión completa</option></select></div>
        <div class="field full ${u?.rol === 'admin' ? '' : 'hidden'}" id="us-avisos-wrap">
          <label class="switch-row" for="us-avisos"><span><b>Recibe avisos de nuevas citas</b><br><small class="hint" style="margin:0">Notificación en su dispositivo (y correo, si está configurado) cuando alguien solicite o cancele una cita. Ideal para el médico.</small></span>
          <input type="checkbox" id="us-avisos" name="recibe_avisos" ${u?.recibe_avisos ? 'checked' : ''}></label></div>
      </div>
      ${u ? '' : `<div class="acc-box"><div class="section-title" style="margin:4px 0 6px">${icon('key-round')} Cuenta de acceso</div>
        <div id="us-acc"><span class="hint">Escribe el correo para verificar si ya tiene cuenta Pet's Table.</span></div></div>`}`,
    onOpen: ({ form }) => {
      permitirNuevaArea(form.elements.area_id);
      const prev = form.querySelector('#us-prev');
      const nombreVal = () => form.elements.nombre.value || '?';
      form.querySelector('#us-foto').addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        try {
          fotoBlob = await prepararFoto(file); quitarFoto = false;
          const url = URL.createObjectURL(fotoBlob);
          prev.innerHTML = `<span class="avatar"><img src="${url}" alt=""></span>`;
          form.querySelector('#us-quitar').classList.remove('hidden');
        } catch (err) { toast(errMsg(err), 'error'); }
        ev.target.value = '';
      });
      form.querySelector('#us-quitar').addEventListener('click', () => {
        fotoBlob = null; fotoExistente = null; quitarFoto = true;
        prev.innerHTML = avatarHTML(nombreVal(), null);
        form.querySelector('#us-quitar').classList.add('hidden');
        form.dispatchEvent(new Event('input'));
      });
      const ponerFotoExistente = (url) => {
        fotoBlob = null; quitarFoto = false; fotoExistente = url;
        prev.innerHTML = avatarHTML(nombreVal(), url);
        form.querySelector('#us-quitar').classList.remove('hidden');
        form.dispatchEvent(new Event('input'));
      };
      form.querySelector('#us-galeria').addEventListener('click', async () => {
        const url = await elegirFotoExistente();
        if (url) ponerFotoExistente(url);
      });
      form.elements.rol.addEventListener('change', () => {
        form.querySelector('#us-avisos-wrap').classList.toggle('hidden', form.elements.rol.value !== 'admin');
      });
      if (u) return;
      // Búsqueda de cuentas existentes en Supabase Auth
      const res = form.querySelector('#us-busca-res');
      let resultados = [];
      form.querySelector('#us-busca').addEventListener('input', debounce(async (ev) => {
        const q = ev.target.value.trim();
        const t = ++buscaTok;
        if (q.length < 2) { res.innerHTML = '<span class="hint">Escribe al menos 2 letras.</span>'; return; }
        res.innerHTML = '<span class="hint">Buscando…</span>';
        const { data, error } = await sb.rpc('med_buscar_cuentas', { p_q: q });
        if (t !== buscaTok) return;
        if (error) { res.innerHTML = `<span class="hint" style="color:var(--bad)">${esc(errMsg(error))}</span>`; return; }
        resultados = data || [];
        res.innerHTML = resultados.length ? resultados.map((r, i) => `<button type="button" data-cuenta="${i}" ${r.ya_registrado ? 'disabled' : ''}>
            ${avatarHTML(r.nombre, r.foto_sugerida, 'sm')}<span class="acc-main"><b>${esc(r.nombre)}</b><small>${esc(r.email)}${r.ultimo_acceso ? ` · último acceso ${fmtDateTime(r.ultimo_acceso)}` : ''}</small></span>
            ${r.ya_registrado ? pill('Ya tiene acceso', 'gray') : pill('Agregar', 'ok')}</button>`).join('')
          : '<span class="hint">No hay cuentas con ese texto. Captura los datos abajo para crear una nueva.</span>';
        refreshIcons();
      }, 350));
      res.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-cuenta]');
        if (!b || b.disabled) return;
        const r = resultados[Number(b.dataset.cuenta)];
        form.elements.nombre.value = r.nombre;
        form.elements.email.value = r.email;
        form.elements.email.dispatchEvent(new Event('input', { bubbles: true }));
        if (r.foto_sugerida && !fotoBlob) ponerFotoExistente(r.foto_sugerida);
        res.querySelectorAll('[data-cuenta]').forEach((x) => x.classList.toggle('sel', x === b));
        form.elements.puesto.focus();
        toast(`${r.nombre} seleccionado. Completa puesto, área y rol.`, 'info');
      });
      // Verificación de cuenta existente al escribir el correo
      const acc = form.querySelector('#us-acc');
      const check = debounce(async () => {
        const t = ++checkTok;
        const email = form.elements.email.value.trim().toLowerCase();
        if (!EMAIL_RE.test(email)) { cuentaEstado = 'pendiente'; acc.innerHTML = '<span class="hint">Escribe un correo @petstable.mx válido.</span>'; return; }
        acc.innerHTML = '<span class="hint">Verificando…</span>';
        const { data, error } = await sb.rpc('med_correo_tiene_cuenta', { p_email: email });
        if (t !== checkTok) return;
        if (error) { cuentaEstado = 'pendiente'; acc.innerHTML = `<span class="hint" style="color:var(--bad)">${esc(errMsg(error))}</span>`; return; }
        if (data) {
          cuentaEstado = 'existe';
          acc.innerHTML = `<div class="notice" style="margin:0">${icon('check-circle-2')}<span>Este correo ya tiene cuenta Pet's Table. Entrará con la <b>misma contraseña</b> que usa en las otras aplicaciones.</span></div>`;
        } else {
          cuentaEstado = 'nueva';
          acc.innerHTML = `<div class="notice warn" style="margin:0 0 6px">${icon('user-plus')}<span>Este correo no tiene cuenta. Se creará al registrar al usuario.</span></div>${passwordFieldHTML('us-pw')}`;
          bindPwGenerator(form);
        }
        refreshIcons();
      }, 450);
      form.elements.email.addEventListener('input', check);
    },
    onSubmit: async ({ form, setError }) => {
      if (!checkForm(form, {
        email: (v) => (u || EMAIL_RE.test(v) ? '' : 'Debe ser un correo @petstable.mx.'),
        password: pwRule,
      })) return false;
      if (!u && cuentaEstado === 'pendiente') { setError('Espera a que se verifique la cuenta del correo.'); return false; }
      const v = formValues(form);
      const payload = { nombre: v.nombre.replace(/\s+/g, ' '), puesto: v.puesto || null, area_id: v.area_id || null };
      if (!self) payload.rol = v.rol;
      const rolFinal = self ? u.rol : v.rol;
      payload.recibe_avisos = rolFinal === 'admin' && form.elements.recibe_avisos.checked;

      let nuevaFoto = null;
      if (fotoBlob) nuevaFoto = await subirFoto(fotoBlob);
      if (nuevaFoto) payload.foto_url = nuevaFoto;
      else if (fotoExistente) payload.foto_url = fotoExistente;
      else if (quitarFoto) payload.foto_url = null;

      try {
        if (u) {
          must(await sb.from('usuarios_med').update(payload).eq('id', u.id).select('id').single());
          if ((nuevaFoto || fotoExistente || quitarFoto) && u.foto_url && u.foto_url !== payload.foto_url) borrarFotoPropia(u.foto_url);
        } else {
          payload.email = v.email.toLowerCase();
          must(await sb.from('usuarios_med').insert(payload).select('id').single());
        }
      } catch (err) {
        if (nuevaFoto) borrarFotoPropia(nuevaFoto);
        if (err.code === '23505') { fieldError(form.elements.email, 'Ese correo ya está registrado en Servicio Médico.'); return false; }
        throw err;
      }

      if (!u && cuentaEstado === 'nueva') {
        try {
          await crearCuenta(payload.email, v.password);
          toast(`${payload.nombre} registrado y con cuenta creada. Comparte su contraseña temporal de forma privada.`, 'success', 8000);
        } catch (err) {
          toast(`${payload.nombre} quedó registrado, pero no se pudo crear su cuenta: ${String(err.message).replace(/\.$/, '')}. Usa el botón de llave en la tabla para reintentar.`, 'warning', 10000);
        }
      } else {
        toast(u ? 'Usuario actualizado.' : `${payload.nombre} registrado. Ya puede entrar con su cuenta Pet's Table.`, 'success', 6000);
      }
      // Si el admin se editó a sí mismo, refrescar encabezado
      if (self) {
        Object.assign(state.profile, { nombre: payload.nombre, puesto: payload.puesto, foto_url: 'foto_url' in payload ? payload.foto_url : state.profile.foto_url });
        const top = document.getElementById('top-avatar');
        if (top) top.outerHTML = avatarHTML(state.profile.nombre, state.profile.foto_url).replace('class="avatar ', 'id="top-avatar" class="avatar ');
        document.getElementById('top-name').textContent = state.profile.nombre;
        document.getElementById('top-role').textContent = 'Administrador';
      }
    },
  });
}

// Galería de la carpeta "avatares" (fotos ya cargadas en Supabase Storage)
async function elegirFotoExistente() {
  const { data, error } = await sb.storage.from('avatares').list('', { limit: 500, sortBy: { column: 'name', order: 'asc' } });
  if (error) { toast(errMsg(error), 'error'); return null; }
  const fotos = (data || []).filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
  if (!fotos.length) { toast('No hay fotos en la carpeta "avatares".', 'warning'); return null; }
  const url = (n) => sb.storage.from('avatares').getPublicUrl(n).data.publicUrl;
  const r = await openModal({
    title: 'Fotos existentes', subtitle: 'Carpeta “avatares” de Supabase Storage. Toca una foto para usarla.', size: 'lg', confirmDiscard: false,
    body: `<div class="toolbar"><div class="search">${icon('search')}<input type="search" id="gal-q" placeholder="Filtrar por nombre" aria-label="Filtrar fotos"></div></div>
      <div class="photo-gallery" id="gal">${fotos.map((f) => `<button type="button" data-url="${esc(url(f.name))}" data-n="${esc(f.name.toLowerCase())}">
        <img src="${esc(url(f.name))}" alt="" loading="lazy"><span>${esc(f.name.replace(/\.[^.]+$/, ''))}</span></button>`).join('')}</div>`,
    onOpen: ({ wrap, close }) => {
      wrap.querySelector('#gal').addEventListener('click', (e) => { const b = e.target.closest('[data-url]'); if (b) close(b.dataset.url); });
      wrap.querySelector('#gal-q').addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        wrap.querySelectorAll('#gal [data-n]').forEach((b) => b.classList.toggle('hidden', !b.dataset.n.includes(q)));
      });
    },
  });
  return typeof r === 'string' ? r : null;
}

// Catálogo de padecimientos (para la atención y las estadísticas)
async function renderPadecimientos(box) {
  const { data, error } = await sb.from('padecimientos_med').select('id, nombre, activo').order('nombre');
  if (error) { box.innerHTML = `<p class="hint" style="color:var(--bad)">${esc(errMsg(error))}</p>`; return; }
  box.innerHTML = `
    <form id="pad-form" class="toolbar" novalidate style="max-width:560px">
      <div class="search" style="flex:1">${icon('plus')}<input name="nombre" maxlength="80" placeholder="Nuevo padecimiento (ej. Otitis)" aria-label="Nuevo padecimiento"></div>
      <button class="btn primary" type="submit">${icon('plus')} Agregar</button>
    </form>
    <div class="login-chips" style="justify-content:flex-start;margin-top:4px">
      ${data.map((p) => `<span style="${p.activo ? '' : 'opacity:.5;text-decoration:line-through'}">${esc(p.nombre)}
        <button type="button" class="link-btn" data-pad="${esc(p.id)}" data-act="${p.activo ? 'off' : 'on'}" title="${p.activo ? 'Desactivar' : 'Activar'}" style="padding:0 2px">${icon(p.activo ? 'x' : 'rotate-ccw')}</button></span>`).join('')}
    </div>
    <p class="hint">Los padecimientos desactivados ya no aparecen al registrar una atención, pero se conservan en las estadísticas.</p>`;
  refreshIcons();
  box.querySelector('#pad-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nombre = e.target.nombre.value.trim().replace(/\s+/g, ' ');
    if (nombre.length < 2) { toast('Escribe el nombre del padecimiento.', 'warning'); return; }
    const { error: err } = await sb.from('padecimientos_med').insert({ nombre });
    if (err) { toast(err.code === '23505' ? 'Ese padecimiento ya existe.' : errMsg(err), 'error'); return; }
    toast('Padecimiento agregado.', 'success'); renderPadecimientos(box);
  });
  box.querySelectorAll('[data-pad]').forEach((b) => b.addEventListener('click', async () => {
    const { error: err } = await sb.from('padecimientos_med').update({ activo: b.dataset.act === 'on' }).eq('id', b.dataset.pad);
    if (err) { toast(errMsg(err), 'error'); return; }
    renderPadecimientos(box);
  }));
}

// ---------- Configuración ----------
async function renderConfig() {
  const card = root.querySelector('#cfg-card');
  card.innerHTML = '<div class="skeleton" style="height:40px"></div>';
  const { data, error } = await sb.from('config_med').select('dias_alerta_caducidad, dias_cobertura, aviso_privacidad_url, updated_at').eq('id', 1).single();
  if (error) {
    card.innerHTML = `<div class="empty error"><b>No se pudo cargar la configuración</b><p>${esc(errMsg(error))}</p>
      <button class="btn secondary" data-cfg="retry">${icon('refresh-cw')} Reintentar</button></div>`;
    refreshIcons(); return;
  }
  card.innerHTML = `
    <div class="card-head"><div><h3>Inventario y privacidad</h3><p>Última modificación: ${fmtDateTime(data.updated_at)}</p></div></div>
    <form id="cfg-form" novalidate style="max-width:520px">
      <div class="field"><label for="cfg-dias">Días de anticipación para alertar caducidad <span class="req">*</span></label>
        <input id="cfg-dias" name="dias" type="number" inputmode="numeric" min="1" max="365" step="1" required value="${data.dias_alerta_caducidad}">
        <small class="hint">Un lote se marca “Por caducar” cuando le quedan este número de días o menos. Valor inicial asumido: 60 días.</small></div>
      <div class="field"><label for="cfg-cob">Cobertura objetivo del pedido sugerido (días) <span class="req">*</span></label>
        <input id="cfg-cob" name="cobertura" type="number" inputmode="numeric" min="7" max="365" step="1" required value="${data.dias_cobertura}">
        <small class="hint">Inventario → Reabasto sugiere pedir lo necesario para cubrir estos días según el consumo de los últimos 90 días (nunca menos que el stock mínimo). Valor inicial asumido: 60 días.</small></div>
      <div class="field"><label for="cfg-aviso">Enlace al aviso de privacidad</label>
        <input id="cfg-aviso" name="aviso" type="url" maxlength="300" placeholder="https://…" pattern="https://.+" data-pattern-msg="Debe empezar con https://" value="${esc(data.aviso_privacidad_url || '')}">
        <small class="hint">Se muestra en la pantalla de inicio de sesión. El texto del aviso lo define el área legal; aquí solo se enlaza. Déjalo vacío para ocultarlo.</small></div>
      <div class="form-error" role="alert"></div>
      <button type="submit" class="btn primary">${icon('save')} Guardar</button>
    </form>
    <div class="section-title" style="margin-top:22px">${icon('clock')} Horario de citas</div>
    <p class="hint" style="margin:0">Lunes a viernes de 09:00 a 17:30, en bloques de 20 minutos (último bloque a las 17:00); las citas de urgencia no usan bloques; un horario solo puede tener una cita activa. Los festivos y ausencias se registran en Citas → Días sin servicio. Las citas confirmadas que no se atendieron se marcan como inasistencia a las 19:05 (se pueden reabrir). Estas reglas se validan en la base de datos.</p>
    <div class="section-title" style="margin-top:22px">${icon('stethoscope')} Catálogo de padecimientos</div>
    <div id="pad-box"><div class="skeleton" style="height:36px"></div></div>`;
  refreshIcons();
  renderPadecimientos(card.querySelector('#pad-box'));
  const form = card.querySelector('#cfg-form');
  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !checkForm(form)) return;
    busy = true;
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      must(await sb.from('config_med').update({
        dias_alerta_caducidad: Number(form.dias.value), dias_cobertura: Number(form.cobertura.value),
        aviso_privacidad_url: form.aviso.value.trim() || null,
      }).eq('id', 1).select('id').single());
      toast('Configuración guardada.', 'success');
    } catch (err) { form.querySelector('.form-error').textContent = errMsg(err); }
    busy = false; btn.disabled = false;
  });
}
