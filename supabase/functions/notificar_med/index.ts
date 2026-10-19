// Edge Function: notificar_med
// Envía avisos de citas por notificación push (Web Push) y, si está configurado,
// por correo (Resend). La invoca el sitio después de crear o cambiar una cita;
// la función valida en la base de datos que el evento sea real y no duplicado.
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
const b64u = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fecha = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const hora = (t: string) => String(t).slice(0, 5);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

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

    // Inicializa claves VAPID (cualquier miembro; idempotente)
    if (body.accion === 'init') {
      const k = await asegurarClaves(admin);
      return json(200, { publica: k.vapid_publica });
    }
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
    let dest: { id: string; email: string; nombre: string }[] = [];
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
    const site = (Deno.env.get('MED_SITE_URL') || '').replace(/\/$/, '');

    // ---- Push ----
    let push = 0;
    const k = await asegurarClaves(admin);
    webpush.setVapidDetails(k.contacto, k.vapid_publica, k.vapid_privada);
    const { data: subs } = await admin.from('push_subs_med').select('id, endpoint, p256dh, auth').in('usuario_id', dest.map((d) => d.id));
    for (const s of subs || []) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title, body: msg, url: '/#/citas', tag: `${c.id}-${evento}` }),
          { TTL: 60 * 60 * 24, urgency: 'high' },
        );
        push++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await admin.from('push_subs_med').delete().eq('id', s.id);
        else console.error('push', code, (e as Error).message);
      }
    }

    // ---- Correo (opcional) ----
    let correo = 0;
    const resend = Deno.env.get('RESEND_API_KEY');
    if (resend) {
      const from = Deno.env.get('MED_EMAIL_FROM') || 'Servicio Médico <onboarding@resend.dev>';
      for (const d of dest) {
        const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #e3eaef;border-radius:14px;overflow:hidden">
          <div style="background:#090D12;color:#fff;padding:18px 22px"><b style="font-size:18px">Servicio Médico</b><br><span style="color:#8494A1;font-size:12px">Salud laboral · Pet's Table S.A. de C.V.</span></div>
          <div style="padding:22px"><p style="margin:0 0 6px;color:#F58020;font-weight:800">${esc(title)}</p>
          <p style="margin:0 0 16px;color:#172431">Hola ${esc(d.nombre)},<br>${esc(msg)}</p>
          ${site ? `<a href="${esc(site)}/#/citas" style="display:inline-block;background:#F58020;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;font-weight:800">Ver en el sistema</a>` : ''}
          <p style="margin:18px 0 0;color:#687B8C;font-size:11px">Aviso automático. No contiene información clínica.</p></div></div>`;
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: `Bearer ${resend}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [d.email], subject: title, html }),
        });
        if (r.ok) correo++; else console.error('correo', r.status, await r.text());
      }
    }
    await admin.from('avisos_med').update({ enviados_push: push, enviados_correo: correo }).eq('id', ins.data!.id);
    return json(200, { ok: true, push, correo });
  } catch (e) {
    console.error('notificar_med', e);
    return json(500, { error: 'No se pudo enviar el aviso.' });
  }
});
