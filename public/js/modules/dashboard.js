// =====================================================================
// Panel general: KPI, gráficas, próximas citas, alertas, actividad,
// accesos rápidos y tarjeta de acceso autorizado.
// Todas las cifras provienen de la base de datos (med_dashboard + vistas).
// =====================================================================
import {
  sb, state, esc, icon, refreshIcons, todayISO, addDays, fmtDate, fmtTime, fmtDateTime, fmtNum,
  MOTIVOS, ESTADOS, estadoPill, pill, makeChart, destroyCharts, emptyState, errorState, navigate,
  monthShort, prefs, must, avatarHTML, cantUnidad, nowHHMM, isWeekday, fmtLongDate, SLOTS, push, toast, errMsg,
  getBloqueos, bloqueoDe, getAreas, slotDe, emoji, kpiHTML, animarCifras, urgentePill,
} from '../core.js';
import { openCitaForm, openDetalle } from './citas.js';
import { openEntrada } from './inventario.js';
import { openColaboradorForm } from './colaboradores.js';
import { openExamenForm } from './examenes.js';
import { describir } from './bitacora.js';

let root, token = 0, cifrasAnimadas = false;

function periodRange(p, desde, hasta) {
  const hoy = todayISO();
  switch (p) {
    case '30': return [addDays(hoy, -29), hoy];
    case '90': return [addDays(hoy, -89), hoy];
    case 'anio': return [`${hoy.slice(0, 4)}-01-01`, `${hoy.slice(0, 4)}-12-31`];
    case 'custom': return [desde, hasta];
    default: { // mes en curso
      const y = Number(hoy.slice(0, 4)), m = Number(hoy.slice(5, 7));
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return [`${hoy.slice(0, 7)}-01`, `${hoy.slice(0, 7)}-${String(last).padStart(2, '0')}`];
    }
  }
}

export default {
  async render(el) {
    root = el; cifrasAnimadas = false; ringPrevio = null;
    const p = state.profile;
    const per = prefs.get('med.dash.period') || 'mes';
    el.innerHTML = `
      <section class="page-intro">
        <div>
          <span class="eyebrow">Panel general</span>
          <h1 class="hello">Hola, ${state.isMedico ? 'Dr. ' : ''}${esc(p.nombre.split(' ')[0])} ${emoji('huella', 'hello-ilus')}</h1>
          <p>${state.isAdmin ? 'Resumen de citas e inventario del servicio médico.' : 'Resumen de las citas que has solicitado.'}</p>
        </div>
        <div class="toolbar" style="margin:0">
          ${state.isAdmin ? `<label class="sr-only" for="dash-area">Área</label>
          <select id="dash-area"><option value="">Todas las áreas</option></select>` : ''}
          <label class="sr-only" for="dash-period">Periodo</label>
          <select id="dash-period">
            <option value="mes">Mes en curso</option><option value="30">Últimos 30 días</option>
            <option value="90">Últimos 90 días</option><option value="anio">Año en curso</option>
            <option value="custom">Personalizado</option>
          </select>
          <span class="date-range hidden" id="dash-custom">
            <input type="date" id="dash-desde" aria-label="Desde"> a <input type="date" id="dash-hasta" aria-label="Hasta">
          </span>
        </div>
      </section>
      <div id="dash-body" class="dash"></div>`;
    const sel = el.querySelector('#dash-period');
    sel.value = per;
    const [d0, d1] = periodRange('mes');
    el.querySelector('#dash-desde').value = d0;
    el.querySelector('#dash-hasta').value = d1;
    el.querySelector('#dash-custom').classList.toggle('hidden', per !== 'custom');
    sel.addEventListener('change', () => {
      prefs.set('med.dash.period', sel.value);
      el.querySelector('#dash-custom').classList.toggle('hidden', sel.value !== 'custom');
      load();
    });
    el.querySelectorAll('#dash-desde, #dash-hasta').forEach((i) => i.addEventListener('change', load));
    // Filtro por área (administradores): limita las cifras de citas a colaboradores de esa área
    const selArea = el.querySelector('#dash-area');
    if (selArea) {
      getAreas().then((areas) => {
        if (!root) return;
        selArea.insertAdjacentHTML('beforeend', areas.map((a) => `<option value="${esc(a.id)}">${esc(a.nombre)}</option>`).join(''));
        const guardada = prefs.get('med.dash.area');
        if (guardada && areas.some((a) => a.id === guardada)) { selArea.value = guardada; load(); }
      }).catch(() => {});
      selArea.addEventListener('change', () => { prefs.set('med.dash.area', selArea.value); load(); });
    }
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-dash][role="link"]')) { e.preventDefault(); e.target.click(); }
    });
    await load();
  },
  destroy() { token++; root = null; },
};

async function onClick(e) {
  const a = e.target.closest('[data-dash]');
  if (!a) return;
  const act = a.dataset.dash;
  if (act === 'retry') return load();
  if (act === 'nueva-cita') { if (await openCitaForm()) load(); return; }
  if (act === 'entrada') { if (await openEntrada()) load(); return; }
  if (act === 'colaborador') { await openColaboradorForm(); return; }
  if (act === 'cita') { await openDetalle(a.dataset.id); load(); return; }
  if (act === 'urgente') { if (await openCitaForm({ urgente: true })) load(); return; }
  if (act === 'examen-ingreso' || act === 'examen-egreso') { await openExamenForm({ tipo: act.slice(7) }); return; }
  if (act === 'slots-todos') {
    const box = a.closest('.slots-pro');
    const abierto = box.classList.toggle('todos');
    a.setAttribute('aria-expanded', String(abierto));
    a.querySelector('span').textContent = abierto ? 'Ver menos horarios' : `Ver los ${box.querySelectorAll('.slot-chip').length} horarios del día`;
    return;
  }
  if (act === 'agendar') {
    // Efecto de selección del horario antes de abrir el formulario
    a.classList.add('elegido');
    setTimeout(() => a.classList.remove('elegido'), 600);
    if (await openCitaForm({ fecha: a.dataset.fecha, hora: a.dataset.hora })) load();
    return;
  }
  if (act === 'notif-on') {
    a.disabled = true;
    try { await push.activar(); toast('Notificaciones activadas en este dispositivo.', 'success'); a.closest('.notif-banner')?.remove(); }
    catch (err) { toast(errMsg(err), 'error'); a.disabled = false; }
    return;
  }
  if (act === 'notif-x') { prefs.set('med.notif.omitir', '1'); a.closest('.notif-banner')?.remove(); return; }
  if (act.startsWith('#')) navigate(act);
}

// ---------- Disponibilidad de citas (hoy o el siguiente día hábil) ----------
async function libresDe(fecha, soloFuturos, bloqueos) {
  const { data, error } = await sb.rpc('med_horarios_ocupados', { p_fecha: fecha });
  if (error) throw error;
  const oc = new Set((data || []).map((h) => slotDe(fmtTime(h))));
  const now = nowHHMM();
  return SLOTS.filter((s) => !oc.has(s) && (!soloFuturos || s > now) && !bloqueoDe(bloqueos, fecha, s));
}
// Siguiente día hábil con servicio (salta fines de semana, festivos y ausencias de día completo)
function sigHabil(iso, bloqueos) {
  let d = addDays(iso, 1);
  for (let i = 0; i < 60 && (!isWeekday(d) || bloqueoDe(bloqueos, d)); i++) d = addDays(d, 1);
  return d;
}
async function disponibilidad() {
  const hoy = todayISO();
  const bloqueos = await getBloqueos(hoy, addDays(hoy, 75));
  const restantes = SLOTS.filter((s) => s > nowHHMM() && !bloqueoDe(bloqueos, hoy, s)).length;
  const sig = sigHabil(hoy, bloqueos);
  const diaBloq = isWeekday(hoy) ? bloqueoDe(bloqueos, hoy) : null;
  let d;
  if (isWeekday(hoy) && !diaBloq && restantes > 0) {
    const libres = await libresDe(hoy, true, bloqueos);
    d = libres.length ? { tipo: 'hoy', fecha: hoy, libres, base: restantes }
      : { tipo: 'lleno', fecha: sig, libres: await libresDe(sig, false, bloqueos), base: SLOTS.length, finde: false };
  } else {
    d = { tipo: 'cerrado', fecha: sig, libres: await libresDe(sig, false, bloqueos), base: SLOTS.length, finde: !isWeekday(hoy), motivo: diaBloq?.motivo };
  }
  // Solo presentación: el estado de cada horario del día mostrado, a partir de
  // los mismos libres y bloqueos (no cambia el cálculo de disponibilidad).
  d.estados = estadosDe(d.fecha, d.libres, bloqueos, d.fecha === hoy);
  return d;
}
function estadosDe(fecha, libres, bloqueos, esHoy) {
  const now = nowHHMM();
  const lib = new Set(libres);
  return SLOTS.map((s) => {
    if (lib.has(s)) return { s, e: 'libre' };
    const b = bloqueoDe(bloqueos, fecha, s);
    if (b) return { s, e: b.tipo === 'comida' ? 'comida' : 'nd' };
    if (esHoy && s <= now) return { s, e: 'nd' };
    return { s, e: 'ocupado' };
  });
}
// Indicador de horarios libres. Al entrar al Panel el anillo gira hacia la
// derecha mientras se completa hasta el porcentaje real (libres / base) y la
// cifra cuenta en sincronía. Si los datos cambian sin salir de la vista, el arco y la cifra pasan
// del valor anterior al nuevo. Nada de esto altera el cálculo.
let ringPrevio = null; // { n, pct } del último pintado en esta vista
function anilloHTML(n, base, pct) {
  const marcas = Math.max(1, base || 1);
  const primero = ringPrevio === null;
  const cambia = !primero && (ringPrevio.pct !== pct || ringPrevio.n !== n);
  const desde = primero ? 0 : ringPrevio.pct;
  return `<div class="avail-ring${primero ? ' anim' : cambia ? ' cambio' : ''}" style="--pct:${pct};--desde:${desde}" role="img" aria-label="${n} de ${marcas} horarios libres (${pct} %)">
    <svg viewBox="0 0 160 160" aria-hidden="true">
      <defs><linearGradient id="avail-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="ar-s1"/><stop offset="1" class="ar-s2"/></linearGradient></defs>
      <circle class="ar-pista" cx="80" cy="80" r="68"/>
      <g class="ar-giro">${n ? `<circle class="ar-valor" cx="80" cy="80" r="68" pathLength="100" stroke-dasharray="${pct} 100" transform="rotate(-90 80 80)"/>` : ''}</g>
    </svg>
    <div class="ar-centro"><b class="ar-num" data-desde="${primero ? 0 : ringPrevio.n}" data-hasta="${n}">${n}</b><small>libres</small><em>de ${marcas}</em>
      <span class="ar-pct">${pct} %</span></div>
  </div>`;
}
// Cifra del anillo: cuenta en sincronía con el arco (o del valor anterior al nuevo)
function contarAnillo(raiz) {
  const el = raiz?.querySelector('.ar-num');
  if (!el) return;
  const a = Number(el.dataset.desde), b = Number(el.dataset.hasta);
  if (a === b || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = b; return; }
  const dur = a === 0 && el.closest('.anim') ? 1500 : 700, t0 = performance.now();
  const cuadro = (fn) => (document.hidden ? setTimeout(() => fn(performance.now()), 16) : requestAnimationFrame(fn));
  const paso = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3;
    el.textContent = Math.round(a + (b - a) * e);
    if (k < 1 && el.isConnected) cuadro(paso);
  };
  el.textContent = a;
  cuadro(paso);
}
const ESTADO_SLOT = { libre: 'Disponible', ocupado: 'Ocupado', nd: 'No disp.', comida: 'Comida' };
const VISIBLES = 12;
function slotsHTML(d) {
  const est = d.estados || [];
  const cuenta = (e) => est.filter((x) => x.e === e || (e === 'nd' && x.e === 'comida')).length;
  // Ventana visible: a partir del primer horario libre (dos antes para contexto)
  const i0 = Math.max(0, Math.min(est.findIndex((x) => x.e === 'libre') - 2, est.length - VISIBLES));
  const chip = (x, i) => {
    const oculto = i < i0 || i >= i0 + VISIBLES ? ' extra' : '';
    const st = `style="--i:${Math.max(0, i - i0)}"`;
    return x.e === 'libre'
      ? `<button class="slot-chip s-libre${oculto}" ${st} data-dash="agendar" data-fecha="${d.fecha}" data-hora="${x.s}" title="Disponible · agendar a las ${x.s}" aria-label="${x.s}, disponible"><b>${x.s}</b></button>`
      : `<span class="slot-chip s-${x.e}${oculto}" ${st} aria-disabled="true" title="${x.s} · ${ESTADO_SLOT[x.e]}"><b>${x.s}</b><small>${ESTADO_SLOT[x.e]}</small></span>`;
  };
  return `<div class="slots-pro">
    <div class="sp-head"><span class="sp-ley"><i class="l-libre"></i>Disponibles <b>${cuenta('libre')}</b></span><span class="sp-ley"><i class="l-ocupado"></i>Ocupados <b>${cuenta('ocupado')}</b></span><span class="sp-ley"><i class="l-nd"></i>No disponibles <b>${cuenta('nd')}</b></span></div>
    <div class="sp-grid">${est.map(chip).join('')}</div>
    ${est.length > VISIBLES ? `<button type="button" class="sp-mas" data-dash="slots-todos" aria-expanded="false">${icon('chevron-down')} <span>Ver los ${est.length} horarios del día</span></button>` : ''}
  </div>`;
}
// Acciones médicas principales: tarjetas con ilustración (mismos destinos que antes)
function accionesHTML() {
  const t = [
    ['nueva-cita', 'am-cita', 'cita_nueva', state.isAdmin ? 'Nueva cita' : 'Solicitar cita', state.isAdmin ? 'Agenda en bloques de 20 minutos' : 'Para ti o un colaborador'],
    ['urgente', 'am-urg', 'urgente', 'Cita de urgencia', 'Atención inmediata o extraordinaria'],
    ...(state.puedeExamenes ? [
      ['examen-ingreso', 'am-ing', 'examen_ingreso', 'Examen de ingreso', 'Valoración de un candidato'],
      ['examen-egreso', 'am-egr', 'examen_egreso', 'Examen de egreso', 'Valoración al retirarse'],
    ] : []),
  ];
  return `<section class="acciones-med n${t.length}" aria-label="Acciones principales">
    ${t.map(([a, cls, il, tit, sub]) => `<button type="button" class="am ${cls}" data-dash="${a}">
      <span class="am-ilus" aria-hidden="true">${emoji(il)}</span>
      <span class="am-txt"><b>${esc(tit)}</b><small>${esc(sub)}</small></span>
      <span class="am-ir" aria-hidden="true">${icon('arrow-right')}</span></button>`).join('')}
  </section>`;
}

function availHTML(d) {
  if (!d) return '';
  const n = d.libres.length;
  const pct = Math.round((n / Math.max(1, d.base)) * 100);
  const dia = fmtLongDate(d.fecha);
  const t = {
    hoy: ['', 'Citas disponibles hoy', `${n} ${n === 1 ? 'horario libre' : 'horarios libres'} hoy`, `El próximo es a las ${d.libres[0]} h. Toca un horario para agendar.`],
    lleno: ['lleno', 'Agenda llena hoy', 'Ya no hay horarios disponibles hoy', `Próximo día hábil: ${dia} · ${n} ${n === 1 ? 'horario libre' : 'horarios libres'}.`],
    cerrado: ['cerrado', d.finde ? 'Fin de semana' : d.motivo ? 'Sin servicio' : 'Fuera de horario',
      d.finde ? 'Hoy no hay servicio médico' : d.motivo ? `Hoy no hay servicio: ${d.motivo}` : 'El servicio de hoy ya concluyó',
      `Próximo día con servicio: ${dia} · ${n} ${n === 1 ? 'horario libre' : 'horarios libres'}.`],
  }[d.tipo];
  const html = `<section class="avail avail-pro ${t[0]}${ringPrevio === null ? ' entra-av' : ''}" aria-label="Disponibilidad de citas">
    ${anilloHTML(n, d.base, pct)}
    <div class="avail-txt"><span class="avail-tag">${esc(t[1])}</span><h3>${esc(t[2])}</h3><p>${esc(t[3])} Atención de lunes a viernes de 9:00 a 18:00.</p>
      ${(d.estados || []).length ? slotsHTML(d) : ''}</div>
  </section>`;
  ringPrevio = { n, pct };
  return html;
}
async function notifHTML() {
  if (prefs.get('med.notif.omitir') === '1') return '';
  const est = await push.estado().catch(() => 'no-soportado');
  if (est === 'inactivo') {
    return `<div class="notif-banner"><span class="nb-ico ilus">${emoji('n_avisos')}</span><div class="nb-txt"><b>Activa las notificaciones</b>
      <span>${state.isAdmin ? 'Recibe un aviso cuando se solicite una nueva cita.' : 'Recibe un aviso cuando Servicio Médico confirme o cancele tus citas.'}</span></div>
      <button class="btn primary" data-dash="notif-on">${icon('bell')} Activar</button><button class="icon-btn" data-dash="notif-x" aria-label="Ocultar aviso">${icon('x')}</button></div>`;
  }
  if (est === 'instalar') {
    return `<div class="notif-banner"><span class="nb-ico ilus">${emoji('instalar')}</span><div class="nb-txt"><b>Instala la app para recibir avisos</b>
      <span>En iPhone: toca Compartir → “Agregar a pantalla de inicio”, abre la app desde ahí y activa las notificaciones.</span></div>
      <button class="icon-btn" data-dash="notif-x" aria-label="Ocultar aviso">${icon('x')}</button></div>`;
  }
  return '';
}

async function load() {
  const t = ++token;
  const body = root?.querySelector('#dash-body');
  if (!body) return;
  const per = root.querySelector('#dash-period').value;
  const area = root.querySelector('#dash-area')?.value || null;
  const [desde, hasta] = periodRange(per, root.querySelector('#dash-desde').value, root.querySelector('#dash-hasta').value);
  if (!desde || !hasta || hasta < desde) {
    body.innerHTML = emptyState({ ico: 'calendar-x', title: 'Periodo inválido', text: 'La fecha final debe ser igual o posterior a la inicial.' });
    refreshIcons(); return;
  }
  if (!body.children.length) body.innerHTML = `<div class="grid grid-4 kx-grid">${'<div class="kx kx-esqueleto"><div class="skeleton" style="width:55%"></div><div class="skeleton" style="height:34px;width:38%"></div><div class="skeleton" style="width:70%"></div></div>'.repeat(4)}</div>`;
  const hoy = todayISO();
  try {
    const reqs = [
      sb.rpc('med_dashboard', { p_desde: desde, p_hasta: hasta, p_area: area }),
      sb.from('v_citas_med').select('id, folio_txt, fecha, hora, colaborador, area, motivo, estado, tipo')
        .in('estado', ['pendiente', 'confirmada']).gte('fecha', hoy).match(area ? { area_id: area } : {}).order('fecha').order('hora').limit(6),
    ];
    if (state.isAdmin) {
      reqs.push(
        sb.rpc('med_estadisticas_padecimientos', { p_desde: desde, p_hasta: hasta, p_area: area }),
        sb.from('v_lotes_med').select('id, medicamento, unidad, lote, caducidad, existencia, dias_para_caducar, estado_caducidad')
          .gt('existencia', 0).in('estado_caducidad', ['caducado', 'por_caducar']).order('caducidad').limit(6),
        sb.from('v_stock_med').select('id, clave, nombre, existencia_vigente, stock_minimo, unidad, estado_stock')
          .eq('activo', true).gt('stock_minimo', 0).in('estado_stock', ['bajo', 'agotado']).order('existencia_vigente').limit(6),
        sb.from('v_bitacora_med').select('id, tabla, registro_id, accion, cambios, usuario_email, created_at, actor_nombre, actor_foto, actor_medico, objeto, referencia, subtipo')
          .order('created_at', { ascending: false }).limit(8),
      );
    }
    const [res, disp, notif] = await Promise.all([
      Promise.all(reqs),
      disponibilidad().catch((e) => { console.error(e); return null; }),
      notifHTML(),
    ]);
    res.forEach(must);
    if (t !== token) return;
    const [k, prox, pad, lotes, stock, act] = res.map((r) => r.data);
    destroyCharts();
    body.innerHTML = notif + availHTML(disp) + accionesHTML()
      + (state.isAdmin ? adminHTML(k, prox, lotes, stock, act, pad) : userHTML(k, prox)) + quickHTML() + accesoHTML();
    refreshIcons();
    drawCharts(k, pad);
    contarAnillo(body);
    // Las cifras cuentan desde 0 solo en el primer pintado de la vista (no en cada filtro)
    if (!cifrasAnimadas) { cifrasAnimadas = true; animarCifras(body); }
  } catch (err) {
    if (t !== token) return;
    console.error(err);
    body.innerHTML = errorState(err).replace('data-action="retry"', 'data-dash="retry"');
    refreshIcons();
  }
}

// Indicador con el componente único .kx (mismos datos y destinos que antes)
const kpi = (tono, ilus, label, value, desc, go = '', extra = '') =>
  kpiHTML({ tono, ilus, label, valor: fmtNum(value), desc, go, extra });

const statusCard = (cls, title, desc, n, go = '', ilus = '') =>
  `<div class="status-card ${go ? 'clickable' : ''}" ${go ? `data-dash="${go}" role="link" tabindex="0"` : ''}>
    ${ilus ? `<span class="sc-ilus" aria-hidden="true">${emoji(ilus)}</span>` : ''}
    <div class="status-head"><span class="dot blinking ${cls}"></span><b>${esc(title)}</b></div><p>${esc(desc)}</p><span class="num" data-cifra>${fmtNum(n)}</span></div>`;

const cardHead = (title, sub = '', btn = '', ilus = '') =>
  `<div class="card-head center"><div>${ilus ? `<span class="ch-ilus" aria-hidden="true">${emoji(ilus)}</span>` : ''}<h3>${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ''}</div>${btn}</div>`;

function proximasHTML(prox) {
  if (!prox.length) return emptyState({ ico: 'calendar', title: 'Sin citas próximas', text: 'No hay citas pendientes ni confirmadas a partir de hoy.' });
  return `<div class="list">${prox.map((c) => `
    <button class="list-item" data-dash="cita" data-id="${esc(c.id)}" style="text-align:left;cursor:pointer;color:inherit">
      <div class="date-chip"><small>${esc(monthShort(c.fecha))}</small><b>${esc(c.fecha.slice(8, 10))}</b></div>
      <div class="li-main"><b>${esc(c.colaborador)}${c.tipo === 'urgente' ? ` ${urgentePill()}` : ''}</b><span>${c.hora ? fmtTime(c.hora) : 'Horario por asignar'} · ${esc(MOTIVOS[c.motivo] || c.motivo)} · ${esc(c.area)}</span></div>
      ${estadoPill(c.estado)}
    </button>`).join('')}</div>`;
}

// Ilustración de cada gráfica junto a su título
const ILUS_GRAFICA = { 'ch-serie': 'grafica', 'ch-estado': 'n_citas', 'ch-area': 'personas', 'ch-motivo': 'libro', 'ch-top': 'pastilla' };
function chartCard(id, title, sub, cls = '', total = null, label = 'Total de consultas') {
  const tb = total === null ? '' : `<span class="total-badge">${esc(label)}: <b>${fmtNum(total)}</b></span>`;
  const il = ILUS_GRAFICA[id] ? `<span class="ch-ilus" aria-hidden="true">${emoji(ILUS_GRAFICA[id])}</span>` : '';
  return `<div class="card chart-card"><div class="card-head center"><div>${il}<h3>${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ''}${tb}</div></div>
    <div tabindex="0" title="Ampliar gráfica" class="chart-box ${cls}"><canvas id="${id}" role="img" aria-label="${esc(title)}"></canvas></div></div>`;
}

// Gráficas de consultas atendidas por padecimiento: toda la empresa y una por departamento
function padecimientosHTML(pad) {
  if (!pad) return '';
  const head = '<div class="section-label">Consultas por padecimiento</div>';
  if (!pad.total) {
    return `${head}<div class="card">${emptyState({ ico: 'stethoscope', title: 'Sin consultas atendidas en el periodo', text: 'Al registrar la atención de una cita se elige el padecimiento; aquí verás la estadística general y por departamento.' })}</div>`;
  }
  const alto = (n) => `style="height:${Math.max(180, 46 + n * 30)}px"`;
  return `${head}
    <div class="card chart-card"><div class="card-head center"><div><span class="ch-ilus" aria-hidden="true">${emoji('estetoscopio')}</span><h3>Toda la empresa</h3><p>Consultas atendidas en el periodo, por padecimiento</p>
      <span class="total-badge">Total de consultas: <b>${fmtNum(pad.total)}</b></span></div></div>
      <div tabindex="0" title="Ampliar gráfica" class="chart-box" ${alto(pad.general.length)}><canvas id="ch-pad-gen" role="img" aria-label="Consultas por padecimiento en toda la empresa"></canvas></div></div>
    <div class="section-label">Por departamento</div>
    <div class="dept-grid">${pad.por_area.map((a, i) => `<div class="card chart-card"><div class="card-head center"><div><span class="ch-ilus" aria-hidden="true">${emoji('personas')}</span><h3>${esc(a.area)}</h3>
      <span class="total-badge">Total de consultas: <b>${fmtNum(a.total)}</b></span></div></div>
      <div tabindex="0" title="Ampliar gráfica" class="chart-box" ${alto(a.items.length)}><canvas id="ch-pad-a${i}" role="img" aria-label="Consultas por padecimiento en ${esc(a.area)}"></canvas></div></div>`).join('')}</div>`;
}

function adminHTML(k, prox, lotes, stock, act, pad) {
  const pe = k.por_estado || {};
  const alertas = [
    ...lotes.map((l) => `<div class="list-item"><span class="dot blinking ${l.estado_caducidad === 'caducado' ? 'bad' : 'warn'}"></span>
      <div class="li-main"><b>${esc(l.medicamento)} · Lote ${esc(l.lote)}</b>
      <span>${l.estado_caducidad === 'caducado' ? `Caducó el ${fmtDate(l.caducidad)}` : `Caduca el ${fmtDate(l.caducidad)} (${l.dias_para_caducar} días)`} · ${esc(cantUnidad(l.existencia, l.unidad))}</span></div>
      ${pill(l.estado_caducidad === 'caducado' ? 'Caducado' : 'Por caducar', l.estado_caducidad === 'caducado' ? 'bad' : 'warn')}</div>`),
    ...stock.map((s) => `<div class="list-item"><span class="dot blinking ${s.estado_stock === 'agotado' ? 'bad' : 'warn'}"></span>
      <div class="li-main"><b>${esc(s.nombre)}</b><span>Existencia ${esc(cantUnidad(s.existencia_vigente, s.unidad))} · mínimo ${esc(cantUnidad(s.stock_minimo, s.unidad))}</span></div>
      ${pill(s.estado_stock === 'agotado' ? 'Agotado' : 'Bajo mínimo', s.estado_stock === 'agotado' ? 'bad' : 'warn')}</div>`),
  ];
  return `
    <div class="grid grid-4 kx-grid">
      ${kpi('blue', 'kpi_hoy', 'Citas de hoy', k.citas_hoy, 'Programadas y atendidas hoy', '#/citas?vista=agenda')}
      ${kpi('orange', 'cita_pendiente', 'Por confirmar', k.pendientes, 'Pendientes a partir de hoy', '#/citas?estado=pendiente')}
      ${kpi('green', 'cita_atendida', 'Atendidas', pe.atendida || 0, 'En el periodo seleccionado', '#/citas?estado=atendida')}
      ${kpi('red', 'stock_bajo', 'Stock bajo mínimo', k.bajo_minimo, `De ${fmtNum(k.medicamentos_activos)} medicamentos activos`, '#/inventario?estado=alerta', k.bajo_minimo > 0 ? 'alerta' : '')}
    </div>
    <div class="grid grid-3 mt">
      ${statusCard(k.por_caducar ? 'warn' : '', 'Lotes por caducar', `Caducan en ${k.dias_alerta} días o menos`, k.por_caducar, '#/inventario?cad=por_caducar', 'caducado')}
      ${statusCard(k.caducados ? 'bad' : '', 'Lotes caducados con existencia', 'Retirar del inventario', k.caducados, '#/inventario?cad=caducado', 'n_alerta')}
      ${statusCard('', 'Citas confirmadas próximas', 'A partir de hoy', k.confirmadas_proximas, '#/citas?estado=confirmada', 'cita_confirmada')}
    </div>
    ${k.total ? `
    <div class="grid grid-main mt">
      ${chartCard('ch-serie', 'Citas en el periodo', k.serie_por_dia ? 'Por día' : 'Por mes')}
      ${chartCard('ch-estado', 'Citas por estado', `${fmtNum(k.total)} citas en el periodo`)}
    </div>
    <div class="grid grid-2 mt">
      ${chartCard('ch-area', 'Citas por departamento', 'Departamento del colaborador (sin canceladas)', 'sm', (k.por_area || []).reduce((s, a) => s + a.n, 0), 'Total de citas')}
      ${chartCard('ch-motivo', 'Citas por motivo', 'Sin canceladas', 'sm', (k.por_motivo || []).reduce((s, a) => s + a.n, 0), 'Total de citas')}
    </div>` : `<div class="card mt">${emptyState({ ico: 'bar-chart-3', title: 'Sin citas en el periodo', text: 'Cuando se registren citas en estas fechas verás aquí sus gráficas.' })}</div>`}
    ${padecimientosHTML(pad)}
    <div class="grid grid-2 mt">
      <div class="card">${cardHead('Próximas citas', 'Pendientes y confirmadas', `<button class="btn secondary" data-dash="#/citas?vista=agenda">${icon('calendar-range')} Ver agenda</button>`, 'calendario')}${proximasHTML(prox)}</div>
      <div class="card">${cardHead('Alertas de inventario', 'Caducidades y stock mínimo', `<button class="btn secondary" data-dash="#/inventario">${icon('pill')} Inventario</button>`, 'n_alerta')}
        ${alertas.length ? `<div class="list">${alertas.join('')}</div>` : emptyState({ ico: 'shield-check', title: 'Sin alertas', text: 'No hay lotes por caducar ni medicamentos bajo su stock mínimo.' })}</div>
    </div>
    <div class="grid grid-2 mt">
      ${k.top_dispensados?.length ? chartCard('ch-top', 'Medicamentos más dispensados', 'Unidades entregadas en citas del periodo', 'sm') : `<div class="card">${cardHead('Medicamentos más dispensados')}${emptyState({ ico: 'pill', title: 'Sin dispensaciones en el periodo', text: 'Se registran al atender una cita y entregar medicamentos.' })}</div>`}
      ${actividadHTML(act)}
    </div>`;
}

function quickHTML() {
  const items = state.isAdmin
    ? [['nueva-cita', 'n_citas', 'Nueva cita', 'Agendar para un colaborador'],
       ['entrada', 'paquete', 'Registrar entrada', 'Ingresar medicamento por lote'],
       ['colaborador', 'n_colaboradores', 'Nuevo colaborador', 'Alta en el catálogo'],
       ['#/citas?vista=agenda', 'reloj', 'Agenda de hoy', 'Bloques de 20 minutos']]
    : [['nueva-cita', 'n_citas', 'Solicitar cita', 'Para ti o un colaborador'],
       ['colaborador', 'n_colaboradores', 'Registrar colaborador', 'Si no aparece en el catálogo'],
       ['#/citas', 'libro', 'Mis solicitudes', 'Consulta su estado'],
       ['#/citas?vista=agenda', 'calendario', 'Disponibilidad', 'Horarios libres']];
  return `<section class="card mt quick-section">${cardHead('Accesos rápidos', 'Las acciones más utilizadas', '', 'n_ayuda')}
    <div class="quick-grid">
      ${items.map(([a, ic, t, s]) => `<button class="quick-action" data-dash="${a}"><span class="qi ilus">${emoji(ic)}</span><b>${esc(t)}</b><span>${esc(s)}</span></button>`).join('')}
    </div></section>`;
}

function accesoHTML() {
  const p = state.profile;
  const u = state.session?.user;
  return `<section class="access-card mt" aria-label="Acceso autorizado">
    <div class="access-photo">${avatarHTML(p.nombre, p.foto_url, 'xl')}<span class="access-check">${icon('badge-check')}</span></div>
    <div class="access-info">
      <span class="access-badge">${icon('shield-check')} Acceso autorizado</span>
      <h2>${esc(p.nombre)}</h2>
      <p class="access-puesto">${esc(p.puesto || 'Puesto no registrado')}</p>
      <div class="access-tags">
        <span>${icon(state.isAdmin ? 'crown' : 'user')} ${state.isAdmin ? 'Administrador' : 'Usuario'}</span>
        <span>${icon('building-2')} ${esc(p.area || 'Sin área')}</span>
        <span>${icon('mail')} ${esc(p.email)}</span>
        <span>${icon('clock')} Último acceso: ${fmtDateTime(u?.last_sign_in_at)}</span>
      </div>
      <p class="access-foot">${icon('lock')} Sesión verificada con tu cuenta corporativa Pet's Table.</p>
    </div>
  </section>`;
}

// Actividad reciente: foto de quien hizo la acción y la misma descripción breve de la Bitácora
const ACC = { INSERT: ['Alta', 'ok'], UPDATE: ['Cambio', 'info'], DELETE: ['Baja', 'bad'] };
function hace(ts) {
  const min = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (min < 1) return 'Hace un momento';
  if (min < 60) return `Hace ${min} min`;
  if (min < 24 * 60 && new Date(ts).toDateString() === new Date().toDateString()) return `Hoy, ${fmtTime(new Date(ts).toTimeString().slice(0, 5))} h`;
  return fmtDateTime(ts);
}
function actividadHTML(act) {
  return `<div class="card">${cardHead('Actividad reciente', 'Últimos cambios registrados en la bitácora', `<button class="btn secondary" data-dash="#/bitacora">${icon('history')} Bitácora</button>`, 'n_bitacora')}
    ${act?.length ? `<div class="list act-list">${act.map((b) => `<div class="list-item act-item">
      ${b.usuario_email ? `<span class="act-photo">${avatarHTML(b.actor_nombre || b.usuario_email, b.actor_foto, 'sm')}</span>` : `<span class="act-photo user-photo bit-sistema">${icon('cpu')}</span>`}
      <div class="li-main"><span class="act-desc">${describir(b)}</span>
        <span class="act-meta">${pill(ACC[b.accion]?.[0] || b.accion, ACC[b.accion]?.[1])} ${esc(hace(b.created_at))}</span></div></div>`).join('')}</div>`
      : emptyState({ ico: 'history', title: 'Sin actividad', text: 'Aquí aparecerán los cambios recientes.' })}</div>`;
}

function userHTML(k, prox) {
  const pe = k.por_estado || {};
  return `
    <div class="grid grid-4 kx-grid">
      ${kpi('blue', 'cita_confirmada', 'Confirmadas próximas', k.confirmadas_proximas, 'A partir de hoy', '#/citas?estado=confirmada')}
      ${kpi('orange', 'cita_pendiente', 'Pendientes', k.pendientes, 'Esperando confirmación', '#/citas?estado=pendiente')}
      ${kpi('green', 'cita_atendida', 'Atendidas', pe.atendida || 0, 'En el periodo seleccionado')}
      ${kpi('red', 'cita_cancelada', 'Canceladas', pe.cancelada || 0, 'En el periodo seleccionado')}
    </div>
    <div class="grid grid-2 mt">
      <div class="card">${cardHead('Mis próximas citas', 'Pendientes y confirmadas', `<button class="btn primary" data-dash="nueva-cita">${icon('calendar-plus')} Solicitar cita</button>`, 'calendario')}${proximasHTML(prox)}</div>
      ${k.total ? chartCard('ch-estado', 'Mis citas por estado', `${fmtNum(k.total)} en el periodo`, 'sm') : `<div class="card">${cardHead('Mis citas por estado')}${emptyState({ ico: 'pie-chart', title: 'Sin citas en el periodo', text: 'Solicita una cita para verla aquí.' })}</div>`}
    </div>
    ${k.total ? `<div class="mt">${chartCard('ch-serie', 'Mis citas en el periodo', k.serie_por_dia ? 'Por día' : 'Por mes', 'sm')}</div>` : ''}`;
}

const ESTADO_COLOR = { pendiente: '#FFB020', confirmada: '#1BC7C7', atendida: '#1BB56F', cancelada: '#9AAAB6', no_asistio: '#E0464E' };
// Cada categoría con su color. Se asigna por nombre en orden alfabético (no por
// lugar en la gráfica), así una categoría no cambia de color cuando sube o baja.
const COLORES = ['#2A78D6', '#EB6834', '#1BAF7A', '#EDA100', '#E87BA4', '#008300', '#6250D6', '#E34948', '#0891B2', '#7C3AED', '#CA8A04', '#0D9488', '#DB2777', '#4F46E5', '#65A30D', '#64748B'];
const coloresPorNombre = (nombres) => new Map([...new Set(nombres)].sort((a, b) => a.localeCompare(b, 'es')).map((n, i) => [n, COLORES[i % COLORES.length]]));
const COLOR_TOP = '#7A5BE6';
function drawPadecimientos(pad) {
  if (!pad?.total) return;
  const color = coloresPorNombre(pad.general.map((g) => g.padecimiento));
  const barra = (id, items) => makeChart(document.getElementById(id), {
    type: 'bar',
    data: {
      labels: items.map((x) => x.padecimiento),
      datasets: [{ label: 'Consultas', data: items.map((x) => x.n), backgroundColor: items.map((x) => color.get(x.padecimiento) || '#64748B'), maxBarThickness: 22 }],
    },
    options: { indexAxis: 'y', plugins: { legend: { display: false } } },
  });
  barra('ch-pad-gen', pad.general);
  pad.por_area.forEach((a, i) => barra(`ch-pad-a${i}`, a.items));
}

function drawCharts(k, pad) {
  drawPadecimientos(pad);
  const fmtPeriodo = (p) => (k.serie_por_dia ? `${p.slice(8, 10)}/${p.slice(5, 7)}` : `${monthShort(p + '-15')} ${p.slice(2, 4)}`);
  const serie = k.serie || [];
  makeChart(document.getElementById('ch-serie'), {
    type: 'bar',
    data: {
      labels: serie.map((s) => fmtPeriodo(s.periodo)),
      datasets: [
        // Barras agrupadas: citas solicitadas (sin canceladas) y atendidas, lado a lado
        { label: 'Citas', data: serie.map((s) => s.total), backgroundColor: '#F58020', maxBarThickness: 26 },
        { label: 'Atendidas', data: serie.map((s) => s.atendidas), backgroundColor: '#1BB56F', maxBarThickness: 26 },
      ],
    },
  });
  const pe = Object.entries(k.por_estado || {});
  makeChart(document.getElementById('ch-estado'), {
    type: 'doughnut',
    data: {
      labels: pe.map(([e]) => ESTADOS[e]?.label || e),
      datasets: [{ data: pe.map(([, n]) => n), backgroundColor: pe.map(([e]) => ESTADO_COLOR[e] || '#999') }],
    },
    options: { plugins: { medCentro: { label: 'citas' } } },
  });
  const colorArea = coloresPorNombre((k.por_area || []).map((a) => a.area));
  makeChart(document.getElementById('ch-area'), {
    type: 'bar',
    data: { labels: (k.por_area || []).map((a) => a.area), datasets: [{ label: 'Citas', data: (k.por_area || []).map((a) => a.n), backgroundColor: (k.por_area || []).map((a) => colorArea.get(a.area)), maxBarThickness: 22 }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false } } },
  });
  const colorMotivo = coloresPorNombre(Object.keys(MOTIVOS));
  makeChart(document.getElementById('ch-motivo'), {
    type: 'bar',
    data: { labels: (k.por_motivo || []).map((m) => MOTIVOS[m.motivo] || m.motivo), datasets: [{ label: 'Citas', data: (k.por_motivo || []).map((m) => m.n), backgroundColor: (k.por_motivo || []).map((m) => colorMotivo.get(m.motivo) || '#64748B'), maxBarThickness: 34 }] },
    options: { plugins: { legend: { display: false } } },
  });
  makeChart(document.getElementById('ch-top'), {
    type: 'bar',
    data: { labels: (k.top_dispensados || []).map((m) => m.medicamento), datasets: [{ label: 'Unidades', data: (k.top_dispensados || []).map((m) => m.n), backgroundColor: COLOR_TOP, maxBarThickness: 22 }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false } } },
  });
}
