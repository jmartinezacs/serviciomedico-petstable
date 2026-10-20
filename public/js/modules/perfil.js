// =====================================================================
// Perfil del usuario: datos, cambio de contraseña, tema e instalación.
// =====================================================================
import {
  sb, state, esc, icon, refreshIcons, toast, errMsg, checkForm, prefs, fmtDateTime, APP_VERSION, avatarHTML, push, pill,
} from '../core.js';

// Estado y control de las notificaciones push de este dispositivo
async function pintarNotificaciones(box) {
  if (!box) return;
  const est = await push.estado().catch(() => 'no-soportado');
  const quien = state.isAdmin
    ? (state.profile.recibe_avisos !== false ? 'Recibirás avisos de nuevas citas si tu usuario tiene activada la opción “Recibe avisos”, y de los cambios en las citas que solicites.' : 'Recibirás avisos de los cambios en las citas que solicites.')
    : 'Recibirás un aviso cuando Servicio Médico confirme, cancele o reprograme tus citas.';
  const txt = {
    activo: [pill('Activadas', 'ok'), quien, `<div class="page-actions" style="justify-content:flex-start">
        <button class="btn primary" data-n="test">${icon('bell-ring')} Enviar aviso de prueba</button>
        <button class="btn secondary" data-n="off">${icon('bell-off')} Desactivar en este dispositivo</button></div>
      <details class="notif-ajustes"><summary>${icon('smartphone')} ¿No suena o no aparece en la pantalla bloqueada?</summary>
        <p><b>Android (Chrome):</b> mantén presionado el aviso de prueba → Configuración, o ve a Ajustes → Aplicaciones → Chrome → Notificaciones → busca este sitio y activa <b>Mostrar en pantalla emergente</b>, <b>Sonido</b> y <b>Pantalla de bloqueo</b>. Revisa también que “No molestar” esté apagado.</p>
        <p><b>iPhone:</b> Ajustes → Notificaciones → Servicio médico → activa <b>Permitir notificaciones</b>, <b>Pantalla bloqueada</b>, <b>Tiras</b> (estilo “Persistente”) y <b>Sonidos</b>. Revisa que el modo Concentración no lo silencie.</p>
      </details>`],
    inactivo: [pill('Desactivadas', 'gray'), quien, `<button class="btn primary" data-n="on">${icon('bell')} Activar notificaciones</button>`],
    bloqueado: [pill('Bloqueadas', 'bad'), 'Las notificaciones están bloqueadas para este sitio. Permítelas desde la configuración del navegador (ícono del candado junto a la dirección) y vuelve a intentarlo.', ''],
    instalar: [pill('Requiere instalar', 'warn'), 'En iPhone/iPad las notificaciones solo funcionan con la app instalada: toca Compartir → “Agregar a pantalla de inicio”, ábrela desde ese ícono y regresa aquí para activarlas.', ''],
    'no-soportado': [pill('No disponibles', 'gray'), 'Este navegador no admite notificaciones web. Usa Chrome, Edge o Safari actualizados.', ''],
  }[est];
  box.innerHTML = `<p style="margin:0 0 8px">${txt[0]}</p><p class="hint" style="margin:0 0 10px">${esc(txt[1])}</p>${txt[2]}`;
  refreshIcons();
  box.querySelector('[data-n="test"]')?.addEventListener('click', async () => {
    // Aviso local con las mismas opciones que los avisos reales (vibración, permanece en pantalla)
    try {
      const reg = await navigator.serviceWorker.ready;
      // El service worker arma el ícono con tu foto y la insignia de la app, como en los avisos reales
      if (reg.active) {
        reg.active.postMessage({ tipo: 'aviso-prueba', title: 'Aviso de prueba · Servicio Médico', body: 'Así se verán los avisos de citas en este dispositivo.', foto: state.profile.foto_url || null });
        return;
      }
      await reg.showNotification('Aviso de prueba · Servicio Médico', {
        body: 'Así se verán los avisos de citas en este dispositivo.', icon: '/notif-icon.png', badge: '/notif-badge.png', actions: [{ action: 'ver', title: 'Ver ahora' }],
        tag: `prueba-${Date.now()}`, renotify: true, requireInteraction: true, silent: false, vibrate: [300, 120, 300, 120, 500], data: { url: '/#/perfil' },
      });
    } catch (err) { toast(errMsg(err), 'error'); }
  });
  box.querySelector('[data-n="on"], [data-n="off"]')?.addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try {
      if (b.dataset.n === 'on') { await push.activar(); toast('Notificaciones activadas en este dispositivo.', 'success'); }
      else { await push.desactivar(); toast('Notificaciones desactivadas en este dispositivo.', 'success'); }
    } catch (err) { toast(errMsg(err), 'error'); }
    pintarNotificaciones(box);
  });
}

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });

export default {
  async render(el) {
    const p = state.profile;
    const user = state.session?.user;
    const theme = prefs.get('med.theme') || 'system';
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    el.innerHTML = `
      <section class="page-intro"><div><span class="eyebrow">Cuenta</span><h1>Mi perfil</h1><p>Tus datos de acceso y preferencias.</p></div></section>
      <section class="profile-hero">
        <div class="access-photo">${avatarHTML(p.nombre, p.foto_url, 'xl')}<span class="access-check">${icon('badge-check')}</span></div>
        <div>
          <span class="access-badge">${icon(p.rol === 'admin' ? 'crown' : 'user')} ${p.rol === 'admin' ? 'Administrador' : 'Usuario'}</span>
          <h2>${esc(p.nombre)}</h2>
          <p class="puesto">${esc(p.puesto || 'Puesto no registrado')}</p>
          <span class="mail">${icon('mail')} ${esc(p.email)}</span>
        </div>
      </section>
      <div class="profile-tiles mt">
        <div class="p-tile"><span class="ti">${icon('briefcase')}</span><small>Puesto</small><b>${esc(p.puesto || 'Sin puesto registrado')}</b></div>
        <div class="p-tile"><span class="ti">${icon('building-2')}</span><small>Área</small><b>${esc(p.area || 'Sin área')}</b></div>
        <div class="p-tile"><span class="ti">${icon('shield-check')}</span><small>Permisos</small><b>${p.rol === 'admin' ? 'Gestión completa de citas, inventario y usuarios' : 'Solicitar y consultar sus citas; registrar colaboradores'}</b></div>
        <div class="p-tile"><span class="ti">${icon('clock')}</span><small>Último acceso</small><b>${fmtDateTime(user?.last_sign_in_at)}</b></div>
        <div class="p-tile"><span class="ti">${icon('mail')}</span><small>Correo</small><b>${esc(p.email)}</b></div>
        <div class="p-tile"><span class="ti">${icon('info')}</span><small>Versión del sistema</small><b>${esc(APP_VERSION)}</b></div>
      </div>
      <div class="grid grid-2 mt">
        <div class="card">
          <div class="card-head"><div><h3>Cambiar contraseña</h3><p>Aplica a todas las aplicaciones de Pet's Table que usan esta cuenta.</p></div></div>
          <form id="pw-form" novalidate>
            <div class="field"><label for="pw1">Nueva contraseña <span class="req">*</span></label>
              <div class="pw-wrap"><input id="pw1" name="p1" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
              <button type="button" class="pw-toggle" data-action="toggle-pw" aria-label="Mostrar contraseña">${icon('eye')}</button></div></div>
            <div class="field"><label for="pw2">Confirmar contraseña <span class="req">*</span></label>
              <input id="pw2" name="p2" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></div>
            <p class="hint">Mínimo 8 caracteres. Combina mayúsculas, minúsculas, números y símbolos.</p>
            <div class="form-error" role="alert"></div>
            <button type="submit" class="btn primary">${icon('key-round')} Actualizar contraseña</button>
          </form>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Apariencia</h3><p>Se guarda en este dispositivo.</p></div></div>
          <div class="seg" role="radiogroup" aria-label="Tema">
            <button data-theme-opt="light" class="${theme === 'light' ? 'active' : ''}">${icon('sun')} Claro</button>
            <button data-theme-opt="dark" class="${theme === 'dark' ? 'active' : ''}">${icon('moon')} Oscuro</button>
            <button data-theme-opt="system" class="${theme === 'system' ? 'active' : ''}">${icon('monitor-smartphone')} Sistema</button>
          </div>
          <div class="section-title" style="margin-top:22px">${icon('bell-ring')} Notificaciones en este dispositivo</div>
          <div id="notif-box"><div class="skeleton" style="height:36px"></div></div>
          <div class="section-title" style="margin-top:22px">${icon('smartphone')} Instalar en la pantalla de inicio</div>
          ${standalone ? `<p class="hint">${icon('check-circle-2')} Ya estás usando la aplicación instalada.</p>` : `
          <button class="btn secondary hidden" id="install-btn">${icon('download')} Instalar aplicación</button>
          <p class="hint" style="margin:10px 0 6px"><b>iPhone / iPad (Safari):</b></p>
          <ol class="steps"><li>Toca el botón <b>Compartir</b>.</li><li>Elige <b>Agregar a pantalla de inicio</b>.</li><li>Confirma el nombre “Servicio médico” y toca <b>Agregar</b>.</li></ol>
          <p class="hint" style="margin:10px 0 6px"><b>Android (Chrome):</b></p>
          <ol class="steps"><li>Abre el menú <b>⋮</b>.</li><li>Elige <b>Instalar aplicación</b> o <b>Agregar a pantalla principal</b>.</li></ol>`}
        </div>
      </div>`;
    refreshIcons();

    el.querySelectorAll('[data-theme-opt]').forEach((b) => b.addEventListener('click', () => {
      window.__medSetTheme?.(b.dataset.themeOpt);
      el.querySelectorAll('[data-theme-opt]').forEach((x) => x.classList.toggle('active', x === b));
    }));
    pintarNotificaciones(el.querySelector('#notif-box'));
    const ib = el.querySelector('#install-btn');
    if (ib && deferredPrompt) {
      ib.classList.remove('hidden');
      ib.addEventListener('click', async () => {
        deferredPrompt.prompt();
        const r = await deferredPrompt.userChoice.catch(() => null);
        if (r?.outcome === 'accepted') toast('Aplicación instalada.', 'success');
        deferredPrompt = null; ib.classList.add('hidden');
      });
    }

    const form = el.querySelector('#pw-form');
    let busy = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      form.querySelector('.form-error').textContent = '';
      if (!checkForm(form, { p2: (v, f) => (v !== f.p1.value ? 'Las contraseñas no coinciden.' : '') })) return;
      busy = true;
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      const { error } = await sb.auth.updateUser({ password: form.p1.value });
      busy = false; btn.disabled = false;
      if (error) {
        form.querySelector('.form-error').textContent = /same|different from the old/i.test(error.message)
          ? 'La nueva contraseña debe ser distinta de la actual.'
          : /weak|short|characters/i.test(error.message) ? 'La contraseña no cumple los requisitos de seguridad.'
          : /reauthentication|recent/i.test(error.message) ? 'Por seguridad, cierra sesión, vuelve a entrar e inténtalo de nuevo.'
          : errMsg(error);
        return;
      }
      form.reset();
      toast('Contraseña actualizada.', 'success');
    });
  },
};
