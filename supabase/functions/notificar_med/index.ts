// Edge Function: notificar_med
// Envía avisos de citas y de exámenes médicos (ingreso/egreso) por notificación
// push (Web Push) y, si está configurado, por correo (Resend). La invoca el sitio
// después de crear o cambiar una cita o un examen; la función valida en la base
// de datos que el evento sea real y no duplicado.
//
// Variables opcionales (Supabase → Edge Functions → Secrets):
//   RESEND_API_KEY  → habilita los correos
//   MED_EMAIL_FROM  → remitente, p. ej. "Servicio Médico <avisos@petstable.mx>"
//   MED_SITE_URL    → URL del sitio para los enlaces (p. ej. https://servicio-medico.vercel.app)
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

// Correo opcional (Resend)
async function enviarCorreo(dest: Dest[], title: string, msg: string, ruta: string) {
  const resend = Deno.env.get('RESEND_API_KEY');
  if (!resend) return 0;
  let correo = 0;
  const site = (Deno.env.get('MED_SITE_URL') || '').replace(/\/$/, '');
  const from = Deno.env.get('MED_EMAIL_FROM') || 'Servicio Médico <onboarding@resend.dev>';
  for (const d of dest) {
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #e3eaef;border-radius:14px;overflow:hidden">
      <div style="background:#090D12;color:#fff;padding:18px 22px"><b style="font-size:18px">Servicio Médico</b><br><span style="color:#8494A1;font-size:12px">Salud laboral · Pet's Table S.A. de C.V.</span></div>
      <div style="padding:22px"><p style="margin:0 0 6px;color:#F58020;font-weight:800">${esc(title)}</p>
      <p style="margin:0 0 16px;color:#172431">Hola ${esc(d.nombre)},<br>${esc(msg)}</p>
      ${site ? `<a href="${esc(site)}/${esc(ruta)}" style="display:inline-block;background:#F58020;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;font-weight:800">Ver en el sistema</a>` : ''}
      <p style="margin:18px 0 0;color:#687B8C;font-size:11px">Aviso automático. No contiene información clínica.</p></div></div>`;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${resend}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [d.email], subject: title, html }),
    });
    if (r.ok) correo++; else console.error('correo', r.status, await r.text());
  }
  return correo;
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
    if (!dest.length) return json(200, { ok: true, enviados: 0, motivo: 'Sin destinatarios' });

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
    const push = await enviarPush(admin, dest, { title, body: msg, url: `/#/citas?cita=${c.id}`, tag: `${c.id}-${evento}`, foto });
    const correo = await enviarCorreo(dest, title, msg, '#/citas');
    await admin.from('avisos_med').update({ enviados_push: push, enviados_correo: correo }).eq('id', ins.data!.id);
    return json(200, { ok: true, push, correo });
  } catch (e) {
    console.error('notificar_med', e);
    return json(500, { error: 'No se pudo enviar el aviso.' });
  }
});
