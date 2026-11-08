// =====================================================================
// Perfil del usuario: datos, cambio de contraseña, tema e instalación.
// =====================================================================
import {
  sb, state, esc, icon, refreshIcons, toast, errMsg, checkForm, prefs, fmtDateTime, APP_VERSION, avatarHTML, push, pill, openModal, emoji,
} from '../core.js';

// Créditos de autoría (mismo diseño de reconocimiento que Ruta de calidad)
const AUTOR = { nombre: 'Javier Martínez González', correo: 'javier.martinez@petstable.mx' };
// Mosaico de información con ilustración
const fila = (ilus, label, valor) => `<div class="pf-t"><span class="pf-ico">${emoji(ilus)}</span><div><small>${esc(label)}</small><b>${esc(valor)}</b></div></div>`;
// Insignia de cuenta verificada
const VERIFICADO = `<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="pf-v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3EA2FF"/><stop offset="1" stop-color="#1565E0"/></linearGradient></defs><g fill="url(#pf-v)">${Array.from({ length: 12 }, (_, i) => { const a = (i / 12) * Math.PI * 2; return `<circle cx="${(16 + 11.2 * Math.cos(a)).toFixed(2)}" cy="${(16 + 11.2 * Math.sin(a)).toFixed(2)}" r="4.4"/>`; }).join('')}<circle cx="16" cy="16" r="12.4"/></g><path d="M10.4 16.4l3.7 3.7 7.6-7.8" fill="none" stroke="#FFF" stroke-width="2.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Estado y control de las notificaciones push de este dispositivo
async function pintarNotificaciones(box) {
  if (!box) return;
  const est = await push.estado().catch(() => 'no-soportado');
  const quien = state.isAdmin
    ? (state.profile.recibe_avisos !== false ? 'Recibirás avisos de nuevas citas si tu usuario tiene activada la opción “Recibe avisos”, y de los cambios en las citas que solicites.' : 'Recibirás avisos de los cambios en las citas que solicites.')
    : 'Recibirás un aviso cuando Servicio Médico confirme, cancele o reprograme tus citas.';
  // [clase de la tarjeta .avisos, ilustración, título, etiqueta, texto, botones, contenido adicional]
  const txt = {
    activo: ['on', 'n_avisos', 'Notificaciones activadas', pill('Activadas', 'ok'), `${quien} Quedan activas en este dispositivo aunque cierres sesión o entres con otra cuenta; los avisos llegan a la última cuenta que inició sesión aquí.`, `
        <button class="btn primary" data-n="test">${icon('bell-ring')} Enviar aviso de prueba</button>
        <button class="btn secondary" data-n="off">${icon('bell-off')} Desactivar</button>`,
      `<details class="notif-ajustes"><summary>${icon('smartphone')} ¿No suena o no aparece en la pantalla bloqueada?</summary>
        <p><b>Android (Chrome):</b> mantén presionado el aviso de prueba → Configuración, o ve a Ajustes → Aplicaciones → Chrome → Notificaciones → busca este sitio y activa <b>Mostrar en pantalla emergente</b>, <b>Sonido</b> y <b>Pantalla de bloqueo</b>. Revisa también que “No molestar” esté apagado.</p>
        <p><b>iPhone:</b> Ajustes → Notificaciones → Servicio médico → activa <b>Permitir notificaciones</b>, <b>Pantalla bloqueada</b>, <b>Tiras</b> (estilo “Persistente”) y <b>Sonidos</b>. Revisa que el modo Concentración no lo silencie.</p>
      </details>`],
    inactivo: ['pend', 'n_avisos', 'Activa las notificaciones', pill('Desactivadas', 'gray'), quien, `<button class="btn primary" data-n="on">${icon('bell')} Activar notificaciones</button>`, ''],
    bloqueado: ['off', 'n_alerta', 'Notificaciones bloqueadas', pill('Bloqueadas', 'bad'), 'Las notificaciones están bloqueadas para este sitio. Permítelas desde la configuración del navegador (ícono del candado junto a la dirección) y vuelve a intentarlo.', '', ''],
    instalar: ['info', 'instalar', 'Instala la app para recibir avisos', pill('Requiere instalar', 'warn'), 'En iPhone/iPad las notificaciones solo funcionan con la app instalada: toca Compartir → “Agregar a pantalla de inicio”, ábrela desde ese ícono y regresa aquí para activarlas.', '', ''],
    'no-soportado': ['off', 'celular', 'Notificaciones no disponibles', pill('No disponibles', 'gray'), 'Este navegador no admite notificaciones web. Usa Chrome, Edge o Safari actualizados.', '', ''],
  }[est];
  box.innerHTML = `<div class="avisos ${txt[0]}"><span class="avisos-ico">${emoji(txt[1])}</span>
      <div class="avisos-txt"><b>${esc(txt[2])} ${txt[3]}</b><p>${esc(txt[4])}</p></div>
      ${txt[5] ? `<div class="avisos-acc">${txt[5]}</div>` : ''}</div>${txt[6]}`;
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
        body: 'Así se verán los avisos de citas en este dispositivo.', icon: '/notif-icon.png', badge: '/notif/badge-96.png', actions: [{ action: 'ver', title: 'Ver ahora' }],
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

// Correos de citas (administradores): vista previa con datos de ejemplo del tipo
// elegido (confirmada, reprogramada o cancelada),
// generada por notificar_med con la misma plantilla que los correos reales, o
// envío de prueba solo al correo propio. Con data-resumen, lo mismo para el
// resumen mensual (resumen_mensual_med, datos reales del mes anterior).
async function correoPrueba(btn) {
  const vista = btn.dataset.mail === 'vista';
  const resumen = 'resumen' in btn.dataset;
  const tipo = document.getElementById('mail-tipo')?.value || 'confirmada';
  btn.disabled = true;
  try {
    const { data, error } = resumen
      ? await sb.functions.invoke('resumen_mensual_med', { body: vista ? { vista: true } : { enviar: true } })
      : await sb.functions.invoke('notificar_med', { body: { accion: 'correo_prueba', vista, tipo } });
    if (error) throw error;
    if (vista) {
      // El logotipo se publica con el sitio; se incrusta como data URI para la vista previa
      let logo = '';
      try {
        const b = await (await fetch('/logo-correo.png')).blob();
        logo = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(b); });
      } catch { /* sin logo: se muestra el nombre en texto */ }
      const html = String(data.html).replace('__LOGO__', /^data:image\/png/.test(logo) ? logo : '');
      await openModal({
        title: 'Vista previa del correo', size: 'lg', submitText: 'Cerrar', onSubmit: () => true,
        subtitle: `Asunto: ${data.asunto} · De: Servicio Médico · Pet's Table`,
        body: `${data.configurado ? '' : `<div class="notice warn">${icon('info')}<span>El envío de correos aún no está configurado (falta la contraseña de aplicación de Gmail en Supabase). Esta es solo la vista previa.</span></div>`}
          <iframe class="mail-preview" title="Vista previa del correo" sandbox="" srcdoc="${esc(html)}"></iframe>
          ${resumen
            ? `<p class="hint" style="margin-top:8px">Datos reales del mes anterior. Se envía solo el día 1 de cada mes a las 08:00 h a: ${
              data.destinatarios?.length ? data.destinatarios.map((d) => `<b>${esc(d.nombre)}</b> (${esc(d.puesto)})`).join(', ') : '<b>nadie</b> (ningún usuario activo tiene los puestos configurados)'}.</p>`
            : '<p class="hint" style="margin-top:8px">Datos de ejemplo. El botón “Ver la cita” aparece cuando se configura la dirección del sitio (MED_SITE_URL) en Supabase.</p>'}`,
      });
    } else if (!data?.configurado) {
      toast('El envío de correos aún no está configurado: falta agregar la contraseña de aplicación de Gmail en Supabase.', 'warning', 7000);
    } else if (data.ok) {
      toast(`Correo de prueba enviado a ${data.para}. Revisa tu bandeja (y Spam).`, 'success', 7000);
    } else {
      toast('No se pudo enviar el correo de prueba. Revisa la contraseña de aplicación de Gmail.', 'error', 7000);
    }
  } catch (err) { toast(errMsg(err), 'error'); }
  btn.disabled = false;
}

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });

export default {
  async render(el) {
    const p = state.profile;
    const user = state.session?.user;
    const theme = prefs.get('med.theme') || 'system';
    const standalone = push.instalada();
    const admin = p.rol === 'admin';
    el.innerHTML = `
      <section class="page-intro"><div><span class="eyebrow">Cuenta</span><h1>Mi perfil</h1><p>Tus datos de acceso y preferencias.</p></div></section>
      <div class="pf">
        <section class="pf-id">
          <div class="pf-foto">${avatarHTML(p.nombre, p.foto_url, 'xl')}<span class="pf-verif" role="img" aria-label="Cuenta identificada de Pet's Table" title="Cuenta identificada de Pet's Table">${VERIFICADO}</span></div>
          <span class="pf-rol ${admin ? 'admin' : ''}">${icon(admin ? 'crown' : 'user-round')} ${admin ? 'Administrador' : 'Usuario'}</span>
          <h2>${esc(p.nombre)}</h2>
          <p class="pf-puesto">${esc(p.puesto || 'Puesto no registrado')}</p>
          <span class="pf-mail">${icon('mail')} ${esc(p.email)}</span>
        </section>
        <div class="pf-info">
          <section class="pf-bloque"><h3 class="pf-sec">${icon('briefcase')} Información laboral</h3>
            <div class="pf-tiles t2">${fila('gafete', 'Puesto', p.puesto || 'Sin puesto registrado')}${fila('personas', 'Área', p.area || 'Sin área')}</div></section>
          <section class="pf-bloque"><h3 class="pf-sec">${icon('shield-check')} Acceso</h3>
            <div class="pf-tiles t3">${fila('llave', 'Permisos', admin ? 'Gestión completa de citas, inventario y usuarios' : 'Solicitar y consultar sus citas; registrar colaboradores')}${fila('reloj', 'Último acceso', fmtDateTime(user?.last_sign_in_at))}${fila('correo', 'Correo', p.email)}</div></section>
          <section class="pf-bloque"><h3 class="pf-sec">${icon('bell')} Notificaciones en este dispositivo</h3>
            <div id="notif-box"><div class="skeleton" style="height:64px"></div></div></section>
          <section class="pf-sistema"><span class="brand-logo pf-logo" aria-hidden="true"></span>
            <div><small>Sistema</small><b>Servicio Médico<i>·</i><span>Salud laboral</span></b></div>
            <span class="pf-ver"><small>Versión</small><b>${esc(APP_VERSION)}</b></span></section>
        </div>
      </div>
      ${state.isAdmin ? `<section class="pf-bloque mt pf-correos"><h3 class="pf-sec">${icon('mail')} Correos del servicio médico</h3>
        <div class="avisos info"><span class="avisos-ico">${emoji('correo')}</span>
          <div class="avisos-txt"><b>Correos de citas</b><p>Revisa cómo se ven los correos que reciben quien solicitó la cita y su área cuando Servicio Médico la confirma, la reprograma o la cancela.</p></div>
          <div class="avisos-acc">
            <select id="mail-tipo" aria-label="Tipo de correo">
              <option value="confirmada">Cita confirmada</option>
              <option value="reprogramada">Cita reprogramada</option>
              <option value="cancelada">Cita cancelada</option>
            </select>
            <button class="btn secondary" data-mail="vista">${icon('eye')} Ver vista previa</button>
            <button class="btn primary" data-mail="enviar">${icon('send')} Enviarme un correo de prueba</button></div></div>
        <div class="avisos info mt-s"><span class="avisos-ico">${emoji('grafica')}</span>
          <div class="avisos-txt"><b>Resumen mensual por correo</b><p>Cada día 1, a las 08:00 h, se envía el resumen del mes anterior al Supervisor de seguridad, salud y ambiente, al Gerente y al Ingeniero de procesos y mejora continua. Solo datos agregados, sin nombres de colaboradores.</p></div>
          <div class="avisos-acc">
            <button class="btn secondary" data-mail="vista" data-resumen>${icon('eye')} Ver resumen del mes anterior</button>
            <button class="btn primary" data-mail="enviar" data-resumen>${icon('send')} Enviármelo de prueba</button></div></div>
      </section>` : ''}
      <div class="grid grid-2 mt">
        <div class="card">
          <div class="card-head"><div class="ch-con-ilus"><span class="ch-ilus" aria-hidden="true">${emoji('candado')}</span><h3>Cambiar contraseña</h3><p>Aplica a todas las aplicaciones de Pet's Table que usan esta cuenta.</p></div></div>
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
          <div class="card-head"><div class="ch-con-ilus"><span class="ch-ilus" aria-hidden="true">${emoji('tema')}</span><h3>Apariencia</h3><p>Se guarda en este dispositivo.</p></div></div>
          <div class="seg" role="radiogroup" aria-label="Tema">
            <button data-theme-opt="light" class="${theme === 'light' ? 'active' : ''}">${icon('sun')} Claro</button>
            <button data-theme-opt="dark" class="${theme === 'dark' ? 'active' : ''}">${icon('moon')} Oscuro</button>
            <button data-theme-opt="system" class="${theme === 'system' ? 'active' : ''}">${icon('monitor-smartphone')} Sistema</button>
          </div>
          <div class="section-title pf-instalar" style="margin-top:22px">${emoji('instalar', 'sm')} Instalar en la pantalla de inicio</div>
          ${standalone ? `<p class="hint">${icon('check-circle-2')} Ya estás usando la aplicación instalada.</p>` : `
          <button class="btn secondary hidden" id="install-btn">${icon('download')} Instalar aplicación</button>
          <p class="hint" style="margin:10px 0 6px"><b>iPhone / iPad (Safari):</b></p>
          <ol class="steps"><li>Toca el botón <b>Compartir</b>.</li><li>Elige <b>Agregar a pantalla de inicio</b>.</li><li>Confirma el nombre “Servicio médico” y toca <b>Agregar</b>.</li></ol>
          <p class="hint" style="margin:10px 0 6px"><b>Android (Chrome):</b></p>
          <ol class="steps"><li>Abre el menú <b>⋮</b>.</li><li>Elige <b>Instalar aplicación</b> o <b>Agregar a pantalla principal</b>.</li></ol>`}
        </div>
      </div>
      <section class="cr mt" aria-labelledby="cr-t">
        <div class="cr-foto" id="cr-foto">${avatarHTML(AUTOR.nombre, String(p.email).toLowerCase() === AUTOR.correo ? p.foto_url : null, 'xl')}</div>
        <div class="cr-cuerpo">
          <span class="cr-eyebrow">${icon('sparkles')} Desarrollado por</span>
          <h3 id="cr-t">${esc(AUTOR.nombre)}</h3>
          <p class="cr-rol">Creador y desarrollador de la plataforma</p>
          <p class="cr-txt">Concibió, diseñó, desarrolló e implementó Servicio Médico · Salud laboral: la agenda de citas en bloques de 20 minutos, el inventario de medicamentos, los exámenes médicos, la base de datos y sus permisos, los avisos y correos, y la experiencia en escritorio y móvil.</p>
          <ul class="cr-etapas" aria-label="Participación"><li>Conceptualización</li><li>Diseño</li><li>Desarrollo</li><li>Implementación</li></ul>
        </div>
        <figure class="cr-firma"><span class="cr-firma-img" role="img" aria-label="Firma de ${esc(AUTOR.nombre)}"></span>
          <figcaption><b>${esc(AUTOR.nombre)}</b><small>Autor de la plataforma</small></figcaption></figure>
      </section>`;
    refreshIcons();
    // Foto del autor (si su cuenta tiene fotografía y es visible para este usuario)
    if (String(p.email).toLowerCase() !== AUTOR.correo) {
      sb.from('usuarios_med').select('foto_url').eq('email', AUTOR.correo).maybeSingle()
        .then(({ data }) => { const caja = el.querySelector('#cr-foto'); if (data?.foto_url && caja) caja.innerHTML = avatarHTML(AUTOR.nombre, data.foto_url, 'xl'); })
        .catch(() => { /* sin foto: se muestran las iniciales */ });
    }

    el.querySelectorAll('[data-theme-opt]').forEach((b) => b.addEventListener('click', () => {
      window.__medSetTheme?.(b.dataset.themeOpt);
      el.querySelectorAll('[data-theme-opt]').forEach((x) => x.classList.toggle('active', x === b));
    }));
    pintarNotificaciones(el.querySelector('#notif-box'));
    el.querySelectorAll('[data-mail]').forEach((b) => b.addEventListener('click', () => correoPrueba(b)));
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
