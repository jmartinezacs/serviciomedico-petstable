// =====================================================================
// Arranque, autenticación, estructura (header/menú) y enrutamiento.
// =====================================================================
import {
  sb, state, prefs, esc, icon, refreshIcons, toast, errMsg, openModal, checkForm,
  destroyCharts, APP_VERSION, TZ, navigate, avatarHTML, restyleCharts, push,
} from './core.js';
import dashboard from './modules/dashboard.js';
import citas from './modules/citas.js';
import { openCitaForm } from './modules/citas.js';
import colaboradores from './modules/colaboradores.js';
import inventario from './modules/inventario.js';
import usuarios from './modules/usuarios.js';
import bitacora from './modules/bitacora.js';
import perfil from './modules/perfil.js';
import reportes from './modules/reportes.js';

const ROUTES = {
  panel:          { mod: dashboard,     icon: 'layout-dashboard', label: 'Panel',          roles: ['admin', 'usuario'], mobile: true },
  citas:          { mod: citas,         icon: 'calendar-days',    label: 'Citas',          labelUser: 'Mis citas', roles: ['admin', 'usuario'], mobile: true },
  colaboradores:  { mod: colaboradores, icon: 'users',            label: 'Colaboradores',  roles: ['admin', 'usuario'], mobile: true },
  inventario:     { mod: inventario,    icon: 'pill',             label: 'Inventario',     roles: ['admin'], mobile: true },
  reportes:       { mod: reportes,      icon: 'file-spreadsheet', label: 'Reportes',       roles: ['admin'] },
  usuarios:       { mod: usuarios,      icon: 'user-cog',         label: 'Usuarios',       roles: ['admin'] },
  bitacora:       { mod: bitacora,      icon: 'history',          label: 'Bitácora',       roles: ['admin'] },
  perfil:         { mod: perfil,        icon: 'circle-user',      label: 'Mi perfil',      roles: ['admin', 'usuario'], mobile: true },
};

const $ = (s) => document.querySelector(s);
let current = null;
let booted = false;
let routing = false;

// ---------------- Inicio ----------------
document.getElementById('year').textContent = new Date().getFullYear();
$('#app-version').textContent = `Versión ${APP_VERSION}`;
refreshIcons();
bindGlobalEvents();

sb.auth.onAuthStateChange((event, session) => {
  // Diferir para no ejecutar consultas dentro del callback de Auth
  setTimeout(() => handleAuth(event, session), 0);
});

async function handleAuth(event, session) {
  if (event === 'PASSWORD_RECOVERY') { await recoveryFlow(); return; }
  if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') { state.session = session; return; }
  if (!session) {
    state.session = null; state.profile = null;
    showLogin(event === 'SIGNED_OUT' ? null : undefined);
    return;
  }
  if (state.session?.user?.id === session.user.id && state.profile) { state.session = session; return; }
  state.session = session;
  await loadProfileAndStart();
}

async function loadProfileAndStart() {
  try {
    const { data, error } = await sb.rpc('med_mi_perfil');
    if (error) throw error;
    const p = data?.[0];
    if (!p) {
      await sb.auth.signOut({ scope: 'local' });
      showLogin('Tu cuenta no tiene acceso a Servicio Médico o está inactiva. Solicítalo a un administrador.');
      return;
    }
    state.profile = p;
    state.isAdmin = p.rol === 'admin';
    state.isMedico = state.isAdmin && !!p.es_medico;
    startApp();
  } catch (err) {
    console.error(err);
    showLogin(errMsg(err));
  }
}

function hideSplash() { $('#splash')?.classList.add('hidden'); }

function showLogin(message) {
  hideSplash();
  current?.mod?.destroy?.(); current = null; destroyCharts();
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  document.body.classList.remove('menu-open');
  const msg = $('#login-msg');
  if (message) { msg.textContent = message; msg.className = 'login-msg error'; } else { msg.className = 'login-msg hidden'; }
  const btn = $('#login-submit'); btn.disabled = false;
  btn.innerHTML = `${icon('log-in')} Entrar`;
  $('#login-remember').checked = prefs.get('med.remember') !== '0';
  refreshIcons();
  cargarAvisoPrivacidad();
}

// Enlace al aviso de privacidad (lo configura un administrador; visible sin sesión)
async function cargarAvisoPrivacidad() {
  const a = $('#login-privacy');
  try {
    const { data } = await sb.rpc('med_aviso_privacidad');
    const ok = typeof data === 'string' && /^https:\/\/\S+$/.test(data);
    if (ok) a.href = data;
    a.classList.toggle('hidden', !ok);
  } catch { a.classList.add('hidden'); }
}

// ---------------- Nueva versión publicada ----------------
// version.json se genera junto con index.html; si cambia, se ofrece recargar
let nuevaVersion = false;
async function revisarVersion() {
  if (nuevaVersion || !navigator.onLine || document.hidden) return;
  try {
    const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return;
    const { version } = await r.json();
    if (version && version !== APP_VERSION) {
      nuevaVersion = true;
      $('#update-ver').textContent = version;
      $('#update-bar').classList.remove('hidden');
      refreshIcons();
    }
  } catch { /* sin conexión o archivo no disponible */ }
}

function startApp() {
  hideSplash();
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const p = state.profile;
  $('#top-avatar').outerHTML = avatarHTML(p.nombre, p.foto_url).replace('class="avatar ', 'id="top-avatar" class="avatar ');
  $('#top-name').textContent = p.nombre;
  $('#top-role').textContent = state.isAdmin ? 'Administrador' : 'Usuario';
  buildNav();
  updateThemeButton();
  if (!booted) {
    booted = true;
    startClock();
    window.addEventListener('hashchange', route);
    revisarVersion();
    setInterval(revisarVersion, 10 * 60 * 1000);
    document.addEventListener('visibilitychange', revisarVersion);
  }
  closeMenu();
  route();
  push.sincronizar();
}

// ---------------- Navegación ----------------
function allowed(name) { const r = ROUTES[name]; return r && r.roles.includes(state.isAdmin ? 'admin' : 'usuario'); }
function label(r) { return !state.isAdmin && r.labelUser ? r.labelUser : r.label; }

function buildNav() {
  const items = Object.entries(ROUTES).filter(([k]) => allowed(k));
  $('#nav').innerHTML = items.map(([k, r]) => `<a href="#/${k}" data-route="${k}">${icon(r.icon)}<span>${esc(label(r))}</span></a>`).join('');
  $('#mobile-nav').innerHTML = items.filter(([, r]) => r.mobile).slice(0, 5)
    .map(([k, r]) => `<a href="#/${k}" data-route="${k}">${icon(r.icon)}<span>${esc(label(r))}</span></a>`).join('');
  refreshIcons();
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  return { name: path || 'panel', params: Object.fromEntries(new URLSearchParams(qs || '')) };
}

let pendingRoute = false;
async function route() {
  if (!state.profile) return;
  if (routing) { pendingRoute = true; return; }
  routing = true;
  try {
    let { name, params } = parseHash();
    if (!allowed(name)) {
      if (ROUTES[name]) toast('No tiene permiso para acceder a esa sección.', 'warning');
      name = 'panel'; params = {};
      history.replaceState(null, '', '#/panel');
    }
    current?.mod?.destroy?.();
    destroyCharts();
    const r = ROUTES[name];
    current = r;
    document.querySelectorAll('[data-route]').forEach((a) => {
      const on = a.dataset.route === name;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = 'Servicio Médico';
    closeMenu();
    const view = $('#view');
    view.innerHTML = '';
    window.scrollTo(0, 0);
    await r.mod.render(view, params);
    refreshIcons();
  } catch (err) {
    console.error(err);
    $('#view').innerHTML = `<div class="card">${esc(errMsg(err))}</div>`;
  } finally {
    routing = false;
    if (pendingRoute) { pendingRoute = false; route(); }
  }
}

// ---------------- Eventos globales ----------------
function bindGlobalEvents() {
  document.addEventListener('click', async (e) => {
    // Al elegir una vista del menú (aunque sea la actual) el menú se oculta
    if (e.target.closest('#nav a, #mobile-nav a')) closeMenu();
    const a = e.target.closest('[data-action]');
    if (!a) return;
    switch (a.dataset.action) {
      case 'toggle-menu': toggleMenu(); break;
      case 'close-menu': closeMenu(); break;
      case 'toggle-theme': cycleTheme(); break;
      case 'go-profile': navigate('#/perfil'); break;
      case 'go-home': navigate('#/panel'); break;
      case 'fab-cita': {
        // Tras registrar una cita, refrescar la vista si muestra citas
        if (await openCitaForm() && ['panel', 'citas'].includes(parseHash().name)) route();
        break;
      }
      case 'logout': await logout(); break;
      case 'reload-app': location.reload(); break;
      case 'update-later': $('#update-bar').classList.add('hidden'); break;
      case 'toggle-pw': togglePw(a); break;
      case 'forgot': await forgotPassword(); break;
      default: break;
    }
  });
  $('#login-form').addEventListener('submit', login);
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  updateNet();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('menu-open') && !document.querySelector('.modal')) closeMenu();
  });
}

// Menú lateral: siempre oculto; se despliega con el botón y se cierra al elegir una vista
function setMenu(open) {
  document.body.classList.toggle('menu-open', open);
  document.querySelector('.top .menu-btn')?.setAttribute('aria-expanded', String(open));
}
function toggleMenu() { setMenu(!document.body.classList.contains('menu-open')); }
function closeMenu() { setMenu(false); }

function togglePw(btn) {
  const inp = btn.parentElement.querySelector('input');
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
  btn.innerHTML = icon(show ? 'eye-off' : 'eye');
  refreshIcons();
}

function updateNet() {
  const el = $('#net-status');
  if (!el) return;
  const on = navigator.onLine;
  el.textContent = on ? 'En vivo' : 'Sin conexión';
  el.classList.toggle('off', !on);
  if (booted && !on) toast('Sin conexión. Los cambios no se guardarán hasta recuperar la red.', 'warning');
}

// Fecha completa (lunes 12 de octubre de 2026) y hora con segundos, hora de Ciudad de México
function startClock() {
  const dEl = $('#clock-date'), tEl = $('#clock-time');
  const parts = new Intl.DateTimeFormat('es-MX', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = new Intl.DateTimeFormat('es-MX', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const tick = () => {
    const now = new Date();
    const p = Object.fromEntries(parts.formatToParts(now).map((x) => [x.type, x.value]));
    const wd = p.weekday.charAt(0).toUpperCase() + p.weekday.slice(1);
    dEl.textContent = `${wd} ${p.day} de ${p.month} del ${p.year}`;
    tEl.textContent = time.format(now);
  };
  tick(); setInterval(tick, 1000);
}

// ---------------- Tema ----------------
function currentTheme() { return prefs.get('med.theme') || 'system'; }
export function setTheme(t) {
  if (t === 'light' || t === 'dark') { document.documentElement.setAttribute('data-theme', t); prefs.set('med.theme', t); }
  else { document.documentElement.removeAttribute('data-theme'); prefs.del('med.theme'); }
  updateThemeButton();
  // Solo re-colorea las gráficas (sin volver a cargar la vista): cambio inmediato
  requestAnimationFrame(restyleCharts);
}
window.__medSetTheme = setTheme;
// Si el tema sigue al sistema y éste cambia, actualizar selector y gráficas
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (currentTheme() !== 'system') return;
  updateThemeButton();
  requestAnimationFrame(restyleCharts);
});
function effectiveDark() {
  const t = currentTheme();
  return t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
function cycleTheme() { setTheme(effectiveDark() ? 'light' : 'dark'); }
// El selector muestra sol y luna; se resalta el modo activo
function updateThemeButton() {
  const dark = effectiveDark();
  const btn = document.querySelector('.theme-toggle');
  btn.classList.toggle('is-dark', dark);
  btn.setAttribute('aria-label', dark ? 'Modo oscuro activo. Cambiar a modo claro' : 'Modo claro activo. Cambiar a modo oscuro');
}

// ---------------- Autenticación ----------------
async function login(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const msg = $('#login-msg');
  msg.className = 'login-msg hidden';
  if (!checkForm(form, {
    email: (v) => (/@petstable\.mx$/i.test(v) ? '' : 'Usa tu correo corporativo @petstable.mx.'),
  })) return;
  const btn = $('#login-submit');
  if (btn.disabled) return;
  btn.disabled = true; btn.innerHTML = '<span class="spinner sm"></span> Verificando…';
  prefs.set('med.remember', $('#login-remember').checked ? '1' : '0');
  const { error } = await sb.auth.signInWithPassword({
    email: form.email.value.trim().toLowerCase(),
    password: form.password.value,
  });
  if (error) {
    btn.disabled = false; btn.innerHTML = `${icon('log-in')} Entrar`; refreshIcons();
    msg.className = 'login-msg error';
    msg.textContent = /invalid login credentials/i.test(error.message)
      ? 'Correo o contraseña incorrectos.'
      : /email not confirmed/i.test(error.message) ? 'Tu correo aún no está confirmado. Revisa tu bandeja de entrada.'
      : /rate limit|too many/i.test(error.message) ? 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.'
      : errMsg(error);
    return;
  }
  form.password.value = '';
}

async function logout() {
  // Deja de recibir avisos en este dispositivo (podría usarlo otra persona)
  await push.desactivar().catch(() => {});
  // scope "local": cierra solo esta sesión (otras apps de Pet's Table comparten la cuenta)
  await sb.auth.signOut({ scope: 'local' });
  state.profile = null; state.session = null;
  history.replaceState(null, '', location.pathname);
  showLogin();
  toast('Sesión cerrada.', 'success');
}

async function forgotPassword() {
  const email = $('#login-email').value.trim();
  await openModal({
    title: 'Restablecer contraseña',
    subtitle: 'Te enviaremos un enlace a tu correo corporativo.',
    size: 'sm', submitText: 'Enviar enlace', confirmDiscard: false,
    body: `<div class="field"><label for="fp-email">Correo corporativo <span class="req">*</span></label>
      <input id="fp-email" name="email" type="email" required maxlength="120" value="${esc(email)}" placeholder="nombre@petstable.mx"></div>
      <p class="hint">Esta contraseña es la misma de tu cuenta Pet's Table en las demás aplicaciones.</p>`,
    onSubmit: async ({ form }) => {
      if (!checkForm(form, { email: (v) => (/@petstable\.mx$/i.test(v) ? '' : 'Usa tu correo @petstable.mx.') })) return false;
      const { error } = await sb.auth.resetPasswordForEmail(form.email.value.trim().toLowerCase(), { redirectTo: `${location.origin}/` });
      if (error) throw error;
      toast('Si el correo está registrado, recibirás un enlace para restablecer tu contraseña.', 'success', 7000);
    },
  });
}

async function recoveryFlow() {
  hideSplash();
  $('#login').classList.remove('hidden');
  await openModal({
    title: 'Define tu nueva contraseña', size: 'sm', submitText: 'Guardar contraseña', confirmDiscard: false,
    body: `<div class="field"><label for="np1">Nueva contraseña <span class="req">*</span></label>
        <input id="np1" name="p1" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></div>
      <div class="field"><label for="np2">Confirmar contraseña <span class="req">*</span></label>
        <input id="np2" name="p2" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></div>
      <p class="hint">Mínimo 8 caracteres. Combina letras, números y símbolos.</p>`,
    onSubmit: async ({ form }) => {
      if (!checkForm(form, { p2: (v, f) => (v !== f.p1.value ? 'Las contraseñas no coinciden.' : '') })) return false;
      const { error } = await sb.auth.updateUser({ password: form.p1.value });
      if (error) throw error;
      toast('Contraseña actualizada.', 'success');
    },
  });
  history.replaceState(null, '', location.pathname);
  const { data } = await sb.auth.getSession();
  if (data.session) { state.session = data.session; await loadProfileAndStart(); } else showLogin();
}

// Si la sesión inicial no dispara eventos (p. ej. sin sesión guardada), mostrar login
setTimeout(async () => {
  if (!$('#splash').classList.contains('hidden')) {
    const { data } = await sb.auth.getSession();
    if (!data.session) showLogin();
  }
}, 2500);
