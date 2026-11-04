// Edge Function: notificar_med
// Envía avisos de citas y de exámenes médicos (ingreso/egreso) por notificación
// push (Web Push) y, si está configurado, por correo. La invoca el sitio
// después de crear o cambiar una cita o un examen; la función valida en la base
// de datos que el evento sea real y no duplicado. Los avisos de cita dirigidos a
// quien solicitó también llegan a los usuarios de su misma área. En citas, el
// correo se envía solo al confirmar.
//
// Variables opcionales (Supabase → Edge Functions → Secrets):
//   GMAIL_USER          → cuenta de Google Workspace que envía (p. ej. javier.martinez@petstable.mx)
//   GMAIL_APP_PASSWORD  → contraseña de aplicación de esa cuenta (no la contraseña normal)
//   RESEND_API_KEY / MED_EMAIL_FROM → alternativa con Resend si no hay Gmail
//   MED_SITE_URL        → URL del sitio para los enlaces (p. ej. https://servicio-medico.vercel.app)
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const MOTIVOS: Record<string, string> = {
  consulta_general: 'Consulta general', malestar: 'Malestar', curacion: 'Curación',
  seguimiento: 'Seguimiento', toma_signos: 'Toma de signos vitales', otro: 'Otro',
};
const RESULTADOS: Record<string, string> = {
  apto: 'APTO', no_apto: 'NO APTO', apto_restricciones: 'APTO con restricciones',
  apto_restricciones_sin_interferencia: 'APTO con restricciones que no interfieren',
  sin_hallazgos: 'sin hallazgos relevantes', con_hallazgos: 'con hallazgos',
};
const b64u = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fecha = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const hora = (t: string) => String(t).slice(0, 5);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

type Dest = { id: string; email: string; nombre: string };

// deno-lint-ignore no-explicit-any
async function asegurarClaves(admin: any) {
  const r = await admin.rpc('med_vapid_claves');
  if (r.data?.[0]) return r.data[0];
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const g = await admin.rpc('med_vapid_guardar', { p_publica: pub, p_privada: jwk.d });
  if (g.error) throw g.error;
  return (await admin.rpc('med_vapid_claves')).data[0];
}

// Push a todos los dispositivos de los destinatarios
// deno-lint-ignore no-explicit-any
async function enviarPush(admin: any, dest: Dest[], payload: Record<string, unknown>) {
  let push = 0;
  const k = await asegurarClaves(admin);
  webpush.setVapidDetails(k.contacto, k.vapid_publica, k.vapid_privada);
  const { data: subs } = await admin.from('push_subs_med').select('id, endpoint, p256dh, auth').in('usuario_id', dest.map((d) => d.id));
  for (const s of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 24, urgency: 'high' });
      push++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from('push_subs_med').delete().eq('id', s.id);
      else console.error('push', code, (e as Error).message);
    }
  }
  return push;
}

// Correo opcional. Preferencia: Gmail / Google Workspace por SMTP seguro (puerto
// 465; Supabase bloquea 25 y 587) con una contraseña de aplicación; si no está
// configurado, Resend; si tampoco, no se envían correos.
type Correo = {
  estado?: string; tono?: 'ok' | 'warn' | 'bad' | 'info'; detalles?: [string, string][]; nota?: string; boton?: string;
  destacado?: { etiqueta: string; valor: string; sub?: string };
};
let smtp: { sendMail: (o: Record<string, unknown>) => Promise<unknown> } | null = null;
async function transporteGmail() {
  const user = Deno.env.get('GMAIL_USER'), pass = Deno.env.get('GMAIL_APP_PASSWORD');
  if (!user || !pass) return null;
  if (!smtp) {
    const nodemailer = (await import('npm:nodemailer@6.9.16')).default;
    smtp = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass: pass.replace(/\s+/g, '') } });
  }
  return { t: smtp!, user };
}
const correoConfigurado = () => !!(Deno.env.get('GMAIL_USER') && Deno.env.get('GMAIL_APP_PASSWORD')) || !!Deno.env.get('RESEND_API_KEY');
const fechaLarga = (iso: string) => {
  const s = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// Plantilla HTML (tablas y estilos en línea para que se vea igual en Gmail,
// Outlook y celular). `logo` es la fuente de la imagen: cid:… en los correos
// (adjunto incrustado), __LOGO__ en la vista previa (el sitio pone la imagen) o
// vacío si no hay logo (se muestra el nombre de la empresa en texto).
const LOGO_CID = 'logo-petstable';
// El logotipo se publica con el sitio (logo-correo.png); se descarga una vez y se
// adjunta incrustado para que se vea aunque el cliente bloquee imágenes remotas.
let logoCache: string | null | undefined;
async function logoB64() {
  if (logoCache !== undefined) return logoCache;
  const site = (Deno.env.get('MED_SITE_URL') || '').replace(/\/$/, '');
  logoCache = null;
  if (site) {
    try {
      const r = await fetch(`${site}/logo-correo.png`);
      if (r.ok && (r.headers.get('content-type') || '').includes('image/png')) {
        const b = new Uint8Array(await r.arrayBuffer());
        let s = '';
        for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
        logoCache = btoa(s);
      }
    } catch (e) { console.error('logo', (e as Error).message); }
  }
  return logoCache;
}
function plantillaCorreo(nombre: string, title: string, msg: string, ruta: string, o: Correo = {}, logo = `cid:${LOGO_CID}`) {
  const site = (Deno.env.get('MED_SITE_URL') || '').replace(/\/$/, '');
  const tonos = { ok: ['#E7F6EC', '#15803D', '#16A34A'], warn: ['#FFF4E5', '#B45309', '#F59E0B'], bad: ['#FDECEC', '#B91C1C', '#DC2626'], info: ['#E6F8F8', '#0E7C7C', '#1BC7C7'] };
  const [fondo, color, fuerte] = tonos[o.tono || 'info'];
  const font = "font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const filas = (o.detalles || []).map(([k, v], i) => `
          <tr>
            <td style="padding:12px 16px;${i ? 'border-top:1px solid #EDF1F4;' : ''}${font};color:#6B7C8A;font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;width:36%;vertical-align:top">${esc(k)}</td>
            <td style="padding:12px 16px;${i ? 'border-top:1px solid #EDF1F4;' : ''}${font};color:#0B2235;font-size:15px;font-weight:600;vertical-align:top">${esc(v)}</td>
          </tr>`).join('');
  const d = o.destacado;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#F1F4F7;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(msg)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F4F7"><tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
    <!-- Encabezado con logotipo -->
    <tr><td style="padding:0 4px 18px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle">${logo
          ? `<img src="${logo}" width="96" alt="Pet's Table" style="display:block;width:96px;height:auto;border:0">`
          : `<span style="${font};color:#F58020;font-size:26px;font-weight:900;letter-spacing:-.5px">pet's table</span>`}</td>
        <td align="right" style="vertical-align:middle;${font}">
          <div style="color:#0B2235;font-size:15px;font-weight:800">Servicio Médico</div>
          <div style="color:#6B7C8A;font-size:12px;margin-top:2px">Salud laboral</div></td>
      </tr></table></td></tr>
    <!-- Tarjeta -->
    <tr><td style="background:#FFFFFF;border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(11,34,53,.08)">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="height:6px;line-height:6px;font-size:0;background:#F58020">&nbsp;</td><td style="height:6px;width:30%;line-height:6px;font-size:0;background:#1BC7C7">&nbsp;</td></tr>
        <tr><td colspan="2" style="padding:34px 32px 6px;${font}">
          ${o.estado ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="width:30px;height:30px;border-radius:15px;background:${fuerte};color:#FFFFFF;font-size:17px;font-weight:800;text-align:center;line-height:30px">${o.tono === 'ok' ? '&#10003;' : '!'}</td>
            <td style="padding-left:10px;color:${color};font-size:13px;font-weight:800;letter-spacing:.8px;text-transform:uppercase">${esc(o.estado)}</td></tr></table>` : ''}
          <h1 style="margin:18px 0 10px;color:#0B2235;font-size:26px;line-height:1.25;font-weight:800">${esc(title)}</h1>
          <p style="margin:0 0 6px;color:#0B2235;font-size:16px;line-height:1.6">Hola <b>${esc(nombre)}</b>,</p>
          <p style="margin:0;color:#4A5B69;font-size:16px;line-height:1.6">${esc(msg)}</p>
        </td></tr>
        ${d ? `<tr><td colspan="2" style="padding:24px 32px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${fondo};border-radius:14px"><tr>
            <td style="padding:18px 20px;${font}">
              <div style="color:${color};font-size:12px;font-weight:800;letter-spacing:.8px;text-transform:uppercase">${esc(d.etiqueta)}</div>
              <div style="color:#0B2235;font-size:22px;font-weight:800;margin-top:6px;line-height:1.3">${esc(d.valor)}</div>
              ${d.sub ? `<div style="color:#0B2235;font-size:30px;font-weight:800;margin-top:2px;letter-spacing:-.5px">${esc(d.sub)}</div>` : ''}
            </td></tr></table></td></tr>` : ''}
        ${filas ? `<tr><td colspan="2" style="padding:20px 32px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E3E9EE;border-radius:14px;border-collapse:separate">${filas}
          </table></td></tr>` : ''}
        ${o.nota ? `<tr><td colspan="2" style="padding:20px 32px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="width:4px;background:#F58020;border-radius:4px">&nbsp;</td>
            <td style="padding:4px 0 4px 14px;${font};color:#4A5B69;font-size:14px;line-height:1.6">${esc(o.nota)}</td></tr></table></td></tr>` : ''}
        ${site ? `<tr><td colspan="2" style="padding:28px 32px 0">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:#F58020">
            <a href="${esc(site)}/${esc(ruta)}" style="display:inline-block;padding:14px 26px;${font};color:#FFFFFF;font-size:15px;font-weight:800;text-decoration:none;border-radius:12px">${esc(o.boton || 'Ver en el sistema')} &rarr;</a>
          </td></tr></table></td></tr>` : ''}
        <tr><td colspan="2" style="padding:32px 32px 30px;${font}">
          <div style="border-top:1px solid #EDF1F4;padding-top:18px;color:#8494A1;font-size:12.5px;line-height:1.6">
            Aviso automático de Servicio Médico. No contiene información clínica.<br>Si tienes dudas, acude al consultorio o responde a este correo.</div></td></tr>
      </table></td></tr>
    <!-- Pie -->
    <tr><td align="center" style="padding:22px 12px 0;${font};color:#97A6B2;font-size:12px;line-height:1.6">
      <b style="color:#6B7C8A">Pet's Table S.A. de C.V.</b> · Servicio Médico · Salud laboral<br>
      © ${new Date().getFullYear()} Pet's Table. Uso interno.</td></tr>
  </table>
</td></tr></table></body></html>`;
}

async function enviarCorreo(dest: Dest[], title: string, msg: string, ruta: string, o: Correo = {}) {
  const gmail = await transporteGmail();
  const resend = Deno.env.get('RESEND_API_KEY');
  if (!gmail && !resend) return 0;
  let correo = 0;
  const site = (Deno.env.get('MED_SITE_URL') || '').replace(/\/$/, '');
  const logo = await logoB64();
  for (const d of dest) {
    if (!d.email) continue;
    const html = plantillaCorreo(d.nombre, title, msg, ruta, o, logo ? `cid:${LOGO_CID}` : '');
    const texto = [`Hola ${d.nombre},`, msg, o.destacado ? `${o.destacado.etiqueta}: ${o.destacado.valor} ${o.destacado.sub || ''}` : '',
      ...(o.detalles || []).map(([k, v]) => `${k}: ${v}`), o.nota || '', site ? `${site}/${ruta}` : ''].filter(Boolean).join('\n');
    try {
      if (gmail) {
        await gmail.t.sendMail({ from: `"Servicio Médico · Pet's Table" <${gmail.user}>`, to: d.email, subject: title, text: texto, html,
          attachments: logo ? [{ filename: 'petstable.png', content: logo, encoding: 'base64', cid: LOGO_CID, contentDisposition: 'inline' }] : [] });
        correo++;
      } else {
        const from = Deno.env.get('MED_EMAIL_FROM') || 'Servicio Médico <onboarding@resend.dev>';
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: `Bearer ${resend}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [d.email], subject: title, html, text: texto,
            ...(logo ? { attachments: [{ filename: 'petstable.png', content: logo, content_id: LOGO_CID }] } : {}) }),
        });
        if (r.ok) correo++; else console.error('correo', r.status, await r.text());
      }
    } catch (e) { console.error('correo', (e as Error).message); }
  }
  return correo;
}

// Datos del correo de cita confirmada (real y de prueba)
// deno-lint-ignore no-explicit-any
function correoConfirmada(c: any, conSolicitante: boolean): [string, string, Correo] {
  const urg = c.tipo === 'urgente';
  return [`Cita ${c.folio_txt} confirmada`,
    urg ? `Servicio Médico atenderá la cita urgente de ${c.colaborador}.` : `Servicio Médico confirmó la cita de ${c.colaborador}.`,
    {
      estado: urg ? 'Cita urgente confirmada' : 'Cita confirmada', tono: 'ok', boton: 'Ver la cita',
      destacado: { etiqueta: 'Fecha y hora', valor: fechaLarga(c.fecha), sub: c.hora ? `${hora(c.hora)} h` : 'Horario por asignar' },
      detalles: [
        ['Colaborador', c.colaborador], ['Área', c.area || '—'],
        ['Motivo', MOTIVOS[c.motivo] || c.motivo || '—'], ['Folio', c.folio_txt],
        ...(conSolicitante ? [['Solicitó', c.solicitante] as [string, string]] : []),
      ],
      nota: 'Pide al colaborador presentarse puntualmente en el consultorio de Servicio Médico. Si ya no podrá asistir, cancela o reprograma la cita desde el sistema para liberar el horario.',
    }];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Método no permitido.' });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: perfil, error: pErr } = await caller.rpc('med_mi_perfil');
    const yo = perfil?.[0];
    if (pErr || !yo) return json(403, { error: 'Usuario no autorizado.' });

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    const body = await req.json().catch(() => ({}));
    // Foto de quien genera el aviso (solo fotos públicas del Storage de este proyecto);
    // el service worker la muestra como ícono con la insignia de la app
    const foto = typeof yo.foto_url === 'string' && yo.foto_url.startsWith(`${url}/storage/v1/object/public/`) ? yo.foto_url : null;

    // Inicializa claves VAPID (cualquier miembro; idempotente)
    if (body.accion === 'init') {
      const k = await asegurarClaves(admin);
      return json(200, { publica: k.vapid_publica });
    }

    // Correo de prueba (solo administradores): con vista=true devuelve el HTML
    // sin enviarlo; si no, lo envía únicamente al correo de quien lo pide.
    if (body.accion === 'correo_prueba') {
      if (yo.rol !== 'admin') return json(403, { error: 'Solo para administradores.' });
      const manana = new Date(Date.now() - 6 * 3600 * 1000 + 24 * 3600 * 1000).toISOString().slice(0, 10);
      const ej = { folio_txt: 'CM-00000', colaborador: 'Juan Pérez López', area: 'Producción', fecha: manana, hora: '10:20:00',
        motivo: 'consulta_general', tipo: 'normal', solicitante: yo.nombre };
      const [t, m, o] = correoConfirmada(ej, false);
      const titulo = `[Prueba] ${t}`;
      if (body.vista) {
        const html = plantillaCorreo(yo.nombre, titulo, m, '#/citas', o, '__LOGO__');
        return json(200, { html, configurado: correoConfigurado(), asunto: titulo });
      }
      if (!correoConfigurado()) return json(200, { ok: false, configurado: false });
      const n = await enviarCorreo([{ id: yo.id, email: yo.email, nombre: yo.nombre }], titulo, m, '#/citas', o);
      return json(200, { ok: n > 0, configurado: true, para: yo.email });
    }

    // ---------------- Exámenes médicos (ingreso / egreso) ----------------
    if (body.accion === 'examen') {
      const evento = String(body.evento || '');
      if (!['examen_nuevo', 'examen_confirmado', 'examen_reprogramado', 'examen_realizado', 'examen_cancelado'].includes(evento)) return json(400, { error: 'Evento no válido.' });
      const { data: puede } = await caller.rpc('med_puede_examenes');
      if (!puede) return json(403, { error: 'Usuario no autorizado.' });
      const { data: e, error: eErr } = await admin.from('v_examenes_med').select('*').eq('id', body.examen_id).maybeSingle();
      if (eErr) throw eErr;
      if (!e) return json(404, { error: 'Examen no encontrado.' });
      const esMedico = !!yo.es_medico;
      const esSolicitante = e.solicitado_por === yo.id;
      const reciente = Date.now() - new Date(evento === 'examen_nuevo' ? e.created_at : e.updated_at).getTime() < 15 * 60 * 1000;
      let ok = reciente;
      if (evento === 'examen_nuevo') ok = ok && esSolicitante && ['pendiente', 'confirmado'].includes(e.estado);
      if (evento === 'examen_confirmado') ok = ok && esMedico && e.estado === 'confirmado';
      if (evento === 'examen_reprogramado') ok = ok && (esMedico || esSolicitante) && ['pendiente', 'confirmado'].includes(e.estado);
      if (evento === 'examen_realizado') ok = ok && esMedico && e.estado === 'realizado';
      if (evento === 'examen_cancelado') ok = ok && (esMedico || esSolicitante) && e.estado === 'cancelado';
      if (!ok) return json(409, { error: 'El evento no corresponde al estado actual del examen.' });

      const sel = 'id, email, nombre';
      const medicos = async () => (await admin.from('usuarios_med').select(sel).eq('activo', true).eq('es_medico', true)).data || [];
      const solicitante = async () => (await admin.from('usuarios_med').select(sel).eq('id', e.solicitado_por).eq('activo', true)).data || [];
      const rh = async () => {
        const { data: areas } = await admin.from('areas_med').select('id, nombre');
        const ids = (areas || []).filter((a) => a.nombre.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim() === 'recursos humanos').map((a) => a.id);
        return ids.length ? (await admin.from('usuarios_med').select(sel).eq('activo', true).in('area_id', ids)).data || [] : [];
      };
      let dest: Dest[] = [];
      if (evento === 'examen_nuevo') dest = esMedico ? await rh() : await medicos();
      else if (evento === 'examen_realizado') dest = [...await rh(), ...await solicitante()];
      else dest = esMedico ? await solicitante() : await medicos();
      dest = [...new Map(dest.filter((d) => d.id !== yo.id).map((d) => [d.id, d])).values()];
      if (!dest.length) return json(200, { ok: true, enviados: 0, motivo: 'Sin destinatarios' });

      const clave = evento === 'examen_reprogramado' ? `${e.fecha} ${e.hora}` : 'u';
      const ins = await admin.from('avisos_examen_med').insert({ examen_id: e.id, evento, clave }).select('id').maybeSingle();
      if (ins.error) {
        if (ins.error.code === '23505') return json(200, { ok: true, duplicado: true });
        throw ins.error;
      }
      const tipo = e.tipo === 'ingreso' ? 'ingreso' : 'egreso';
      const cuando = `${fecha(e.fecha)} a las ${hora(e.hora)} h`;
      const detalle = [e.area, e.puesto].filter(Boolean).join(' · ');
      const txt: Record<string, [string, string]> = {
        examen_nuevo: [`Nuevo examen de ${tipo} ${e.folio_txt}`, `${e.persona} (${detalle}) · ${cuando}. Solicitó: ${e.solicitante}.`],
        examen_confirmado: [`Examen de ${tipo} ${e.folio_txt} confirmado`, `${e.persona} · ${cuando}. Servicio Médico lo espera.`],
        examen_reprogramado: [`Examen de ${tipo} ${e.folio_txt} reprogramado`, `${e.persona} ahora es el ${cuando}.`],
        examen_realizado: e.tipo === 'ingreso'
          ? [`Examen de ingreso ${e.folio_txt}: ${RESULTADOS[e.resultado] || ''}`, `${e.persona} (${detalle}). ${e.resultado === 'no_apto' ? 'No se registró como colaborador.' : 'Quedó registrado como colaborador.'} La constancia ya está disponible en Exámenes médicos.`]
          : [`Examen de egreso ${e.folio_txt} realizado`, `${e.persona} (${detalle}) quedó dado de baja en el sistema. La constancia ya está disponible en Exámenes médicos.`],
        examen_cancelado: [`Examen de ${tipo} ${e.folio_txt} cancelado`, `${e.persona} · ${cuando}${e.motivo_cancelacion ? `. Motivo: ${e.motivo_cancelacion}` : ''}.`],
      };
      const [title, msg] = txt[evento];
      const ruta = `#/examenes?examen=${e.id}`;
      const push = await enviarPush(admin, dest, { title, body: msg, url: `/${ruta}`, tag: `${e.id}-${evento}`, foto });
      const correo = await enviarCorreo(dest, title, msg, ruta);
      await admin.from('avisos_examen_med').update({ enviados: push + correo }).eq('id', ins.data!.id);
      return json(200, { ok: true, push, correo });
    }

    // ---------------- Citas ----------------
    if (body.accion !== 'aviso') return json(400, { error: 'Acción no válida.' });

    const evento = String(body.evento || '');
    if (!['nueva_cita', 'confirmada', 'cancelada', 'reprogramada'].includes(evento)) return json(400, { error: 'Evento no válido.' });

    const { data: c, error: cErr } = await admin.from('v_citas_med').select('*').eq('id', body.cita_id).maybeSingle();
    if (cErr) throw cErr;
    if (!c) return json(404, { error: 'Cita no encontrada.' });
    const reciente = Date.now() - new Date(evento === 'nueva_cita' ? c.created_at : c.updated_at).getTime() < 15 * 60 * 1000;
    const esSolicitante = c.solicitado_por === yo.id;
    // Solo el médico (es_medico) gestiona citas; los demás actúan como solicitantes
    const esAdmin = yo.rol === 'admin' && !!yo.es_medico;

    // Validación del evento contra el estado real de la cita
    let ok = reciente;
    if (evento === 'nueva_cita') ok = ok && esSolicitante && c.estado === 'pendiente';
    if (evento === 'confirmada') ok = ok && esAdmin && c.estado === 'confirmada';
    if (evento === 'cancelada') ok = ok && (esAdmin || esSolicitante) && c.estado === 'cancelada';
    if (evento === 'reprogramada') ok = ok && (esAdmin || esSolicitante) && ['pendiente', 'confirmada'].includes(c.estado);
    if (!ok) return json(409, { error: 'El evento no corresponde al estado actual de la cita.' });

    // Destinatarios: al médico (admins con avisos) o al solicitante
    const haciaMedico = evento === 'nueva_cita' || (!esAdmin && ['cancelada', 'reprogramada'].includes(evento));
    let dest: Dest[] = [];
    if (haciaMedico) {
      const { data } = await admin.from('usuarios_med').select('id, email, nombre').eq('activo', true).eq('rol', 'admin').eq('recibe_avisos', true);
      dest = data || [];
    } else {
      const { data } = await admin.from('usuarios_med').select('id, email, nombre').eq('id', c.solicitado_por).eq('activo', true);
      dest = data || [];
    }
    dest = dest.filter((d) => d.id !== yo.id);
    // Compañeros del área de quien solicitó (p. ej. supervisores de otro turno):
    // también se enteran de la confirmación, cancelación o reprogramación.
    let area: Dest[] = [];
    if (!haciaMedico) {
      const { data: sol } = await admin.from('usuarios_med').select('area_id').eq('id', c.solicitado_por).maybeSingle();
      if (sol?.area_id) {
        const { data } = await admin.from('usuarios_med').select('id, email, nombre').eq('activo', true).eq('area_id', sol.area_id)
          .eq('es_medico', false).neq('id', c.solicitado_por);
        area = (data || []).filter((d) => d.id !== yo.id);
      }
    }
    if (!dest.length && !area.length) return json(200, { ok: true, enviados: 0, motivo: 'Sin destinatarios' });

    // Evita duplicados (misma cita, evento y fecha/hora)
    const clave = evento === 'reprogramada' ? `${c.fecha} ${c.hora}` : 'u';
    const ins = await admin.from('avisos_med').insert({ cita_id: c.id, evento, clave }).select('id').maybeSingle();
    if (ins.error) {
      if (ins.error.code === '23505') return json(200, { ok: true, duplicado: true });
      throw ins.error;
    }

    const cuando = c.hora ? `${fecha(c.fecha)} a las ${hora(c.hora)} h` : `${fecha(c.fecha)} (horario por asignar)`;
    const urg = c.tipo === 'urgente';
    const motivo = MOTIVOS[c.motivo] || c.motivo;
    const txt: Record<string, [string, string]> = {
      nueva_cita: [`${urg ? 'URGENTE · ' : ''}Nueva cita ${c.folio_txt}`, `${c.colaborador} (${c.area}) · ${cuando} · ${motivo}. Solicitó: ${c.solicitante}.`],
      confirmada: [`Cita ${c.folio_txt} confirmada`, urg ? `Servicio Médico atenderá la cita urgente de ${c.colaborador} el ${cuando}.` : `La cita de ${c.colaborador} para el ${cuando} fue confirmada por Servicio Médico.`],
      cancelada: [`Cita ${c.folio_txt} ${urg && !esSolicitante ? 'rechazada' : 'cancelada'}`, `La cita de ${c.colaborador} del ${cuando} fue cancelada${c.motivo_cancelacion ? `. Motivo: ${c.motivo_cancelacion}` : ''}.`],
      reprogramada: [`Cita ${c.folio_txt} reprogramada`, `La cita de ${c.colaborador} ahora es el ${cuando}.`],
    };
    const [title, msg] = txt[evento];
    const payload = { url: `/#/citas?cita=${c.id}`, tag: `${c.id}-${evento}`, foto };
    const msgArea = `${msg} Solicitó: ${c.solicitante}.`;
    let push = await enviarPush(admin, dest, { ...payload, title, body: msg });
    if (area.length) push += await enviarPush(admin, area, { ...payload, title, body: msgArea });
    // Correo solo al confirmar (a quien solicitó y a su área)
    let correo = 0;
    if (evento === 'confirmada') {
      const ruta = `#/citas?cita=${c.id}`;
      const [t1, m1, o1] = correoConfirmada(c, false);
      const [, , o2] = correoConfirmada(c, true);
      correo = await enviarCorreo(dest, t1, m1, ruta, o1)
        + await enviarCorreo(area, t1, `${m1} La solicitó ${c.solicitante}, de tu área.`, ruta, o2);
    }
    await admin.from('avisos_med').update({ enviados_push: push, enviados_correo: correo }).eq('id', ins.data!.id);
    return json(200, { ok: true, push, correo });
  } catch (e) {
    console.error('notificar_med', e);
    return json(500, { error: 'No se pudo enviar el aviso.' });
  }
});
