// Edge Function: resumen_mensual_med
// Resumen mensual de Servicio Médico por correo (solo datos agregados: sin
// nombres de colaboradores ni notas clínicas).
//  - pg_cron (trabajo med_resumen_mensual, día 1 a las 08:00 h de Ciudad de
//    México) la llama con el encabezado x-med-cron: envía el resumen del mes
//    anterior a los usuarios activos cuyo puesto está en
//    config_med.resumen_puestos. resumenes_med evita enviar dos veces el mismo mes.
//  - Un administrador, desde Mi perfil: { vista: true } devuelve el HTML y los
//    destinatarios sin enviar; { enviar: true } lo manda solo a su propio correo.
// Las estadísticas vienen de public.med_resumen_mensual(p_mes).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { correoConfigurado, enviar, esc, LOGO_CID, sitio } from './correo.ts';

const TZ = 'America/Mexico_City';
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
const fmtN = (n: number) => new Intl.NumberFormat('es-MX').format(n || 0);
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function igual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// Primer día del mes anterior (hora de Ciudad de México)
function mesAnterior() {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const d = new Date(`${hoy.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}
const nombreMes = (iso: string) => {
  const s = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// ---------------- Plantilla ----------------
// deno-lint-ignore no-explicit-any
type R = any;
const FONT = "font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// Variación contra el mes anterior: flecha y porcentaje. Sin color de "bueno" o
// "malo": más consultas no es necesariamente mejor ni peor.
function variacion(act: number, ant: number) {
  if (!ant) return act ? `<span style="color:#6B7C8A">sin datos del mes anterior</span>` : '';
  const p = Math.round(((act - ant) / ant) * 100);
  if (p === 0) return `<span style="color:#6B7C8A">igual que el mes anterior</span>`;
  return `<span style="color:#0B2235;font-weight:700">${p > 0 ? '&#9650;' : '&#9660;'} ${Math.abs(p)}%</span> <span style="color:#6B7C8A">vs. mes anterior (${fmtN(ant)})</span>`;
}
function tile(etiqueta: string, valor: number, extra: string, color: string) {
  return `<td width="50%" style="padding:6px;vertical-align:top">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F9FB;border:1px solid #E3E9EE;border-radius:14px">
      <tr><td style="padding:16px 16px 14px;${FONT}">
        <div style="width:28px;height:4px;border-radius:2px;background:${color};margin-bottom:10px;font-size:0;line-height:0">&nbsp;</div>
        <div style="color:#6B7C8A;font-size:11.5px;font-weight:800;letter-spacing:.6px;text-transform:uppercase">${esc(etiqueta)}</div>
        <div style="color:#0B2235;font-size:30px;font-weight:800;line-height:1.2;margin-top:4px">${fmtN(valor)}</div>
        <div style="font-size:12px;line-height:1.5;margin-top:4px">${extra}</div>
      </td></tr></table></td>`;
}
// Lista con barras horizontales (tablas: se ve igual en Gmail, Outlook y celular)
function barras(titulo: string, items: { nombre: string; n: number }[], color: string, unidad = '') {
  if (!items.length) return '';
  const max = Math.max(...items.map((x) => x.n), 1);
  return `<tr><td style="padding:22px 32px 0;${FONT}">
    <div style="color:#0B2235;font-size:15px;font-weight:800;margin-bottom:10px">${esc(titulo)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    ${items.map((x) => `<tr>
      <td style="padding:5px 10px 5px 0;${FONT};color:#33475B;font-size:13px;width:42%;vertical-align:middle">${esc(x.nombre)}</td>
      <td style="padding:5px 0;vertical-align:middle">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td width="${Math.max(3, Math.round((x.n / max) * 82))}%" style="background:${color};height:12px;border-radius:0 6px 6px 0;font-size:0;line-height:0">&nbsp;</td>
          <td style="padding-left:8px;${FONT};color:#0B2235;font-size:13px;font-weight:800;white-space:nowrap">${fmtN(x.n)}${unidad}</td>
        </tr></table></td></tr>`).join('')}
    </table></td></tr>`;
}

function plantilla(r: R, nombre: string, logo: string) {
  const c = r.citas?.actual || {}, c0 = r.citas?.anterior || {};
  const e = r.examenes?.actual || {};
  const inv = r.inventario || {};
  const disp = Number(r.dispensadas?.actual || 0), disp0 = Number(r.dispensadas?.anterior || 0);
  const mes = nombreMes(r.desde);
  const site = sitio();
  const asistencia = c.solicitadas ? Math.round((c.atendidas / c.solicitadas) * 100) : 0;
  const alertas = [
    inv.agotados ? `<b>${fmtN(inv.agotados)}</b> medicamento${inv.agotados === 1 ? '' : 's'} agotado${inv.agotados === 1 ? '' : 's'}` : '',
    inv.bajo_minimo ? `<b>${fmtN(inv.bajo_minimo)}</b> bajo stock mínimo` : '',
    inv.por_caducar ? `<b>${fmtN(inv.por_caducar)}</b> lote${inv.por_caducar === 1 ? '' : 's'} por caducar` : '',
    inv.caducados ? `<b>${fmtN(inv.caducados)}</b> lote${inv.caducados === 1 ? '' : 's'} caducado${inv.caducados === 1 ? '' : 's'} con existencia` : '',
  ].filter(Boolean);
  const sinActividad = !c.solicitadas && !e.ingreso && !e.egreso;

  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>Resumen mensual · ${esc(mes)}</title></head>
<body style="margin:0;padding:0;background:#F1F4F7;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${fmtN(c.atendidas)} consultas atendidas en ${esc(mes)}. Resumen de Servicio Médico.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F4F7"><tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px">
    <tr><td style="padding:0 4px 18px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle">${logo ? `<img src="${logo}" width="96" alt="Pet's Table" style="display:block;width:96px;height:auto;border:0">` : `<span style="${FONT};color:#F58020;font-size:26px;font-weight:900">pet's table</span>`}</td>
        <td align="right" style="vertical-align:middle;${FONT}">
          <div style="color:#0B2235;font-size:15px;font-weight:800">Servicio Médico</div>
          <div style="color:#6B7C8A;font-size:12px;margin-top:2px">Salud laboral</div></td>
      </tr></table></td></tr>
    <tr><td style="background:#FFFFFF;border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(11,34,53,.08)">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="background:#0B2235;padding:30px 32px 26px;${FONT}">
          <div style="color:#FFB36B;font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase">Resumen mensual</div>
          <div style="color:#FFFFFF;font-size:28px;font-weight:800;line-height:1.2;margin-top:6px">${esc(mes)}</div>
          <div style="color:#B9C7D2;font-size:14px;line-height:1.6;margin-top:8px">Hola <b style="color:#FFFFFF">${esc(nombre)}</b>, este es el resumen de la actividad de Servicio Médico del mes.</div>
        </td></tr>
        <tr><td style="height:5px;line-height:5px;font-size:0;background:#F58020">&nbsp;</td></tr>
        <tr><td style="padding:20px 26px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>${tile('Consultas atendidas', c.atendidas || 0, variacion(c.atendidas || 0, c0.atendidas || 0), '#1BB56F')}
                ${tile('Colaboradores atendidos', c.colaboradores || 0, `<span style="color:#6B7C8A">personas distintas</span>`, '#1BC7C7')}</tr>
            <tr>${tile('Citas solicitadas', c.solicitadas || 0, `<span style="color:#6B7C8A">${asistencia}% se atendió · ${fmtN(c.urgentes)} urgente${c.urgentes === 1 ? '' : 's'}</span>`, '#F58020')}
                ${tile('Unidades de medicamento', disp, variacion(disp, disp0), '#7A5BE6')}</tr>
          </table></td></tr>
        ${(c.canceladas || c.no_asistio) ? `<tr><td style="padding:10px 32px 0;${FONT};color:#4A5B69;font-size:13px;line-height:1.6">
          Además hubo <b>${fmtN(c.canceladas)}</b> cita${c.canceladas === 1 ? '' : 's'} cancelada${c.canceladas === 1 ? '' : 's'} y <b>${fmtN(c.no_asistio)}</b> en las que el colaborador no se presentó.</td></tr>` : ''}
        ${sinActividad ? `<tr><td style="padding:22px 32px 0;${FONT};color:#4A5B69;font-size:14px">No se registraron citas ni exámenes en este mes.</td></tr>` : ''}
        ${barras('Consultas por departamento', (r.por_area || []), '#5B8DEF')}
        ${barras('Principales padecimientos atendidos', (r.padecimientos || []), '#0FA3A6')}
        ${barras('Motivo de la consulta', (r.por_motivo || []).map((m: R) => ({ nombre: MOTIVOS[m.motivo] || m.motivo, n: m.n })), '#F58020')}
        ${barras('Medicamentos más entregados', (r.medicamentos || []), '#7A5BE6')}
        ${(e.ingreso || e.egreso) ? `<tr><td style="padding:22px 32px 0;${FONT}">
          <div style="color:#0B2235;font-size:15px;font-weight:800;margin-bottom:8px">Exámenes médicos</div>
          <div style="color:#4A5B69;font-size:13.5px;line-height:1.7">
            <b>${fmtN(e.ingreso)}</b> de ingreso${e.ingreso ? ` (${fmtN(e.no_aptos)} no apto${e.no_aptos === 1 ? '' : 's'}, ${fmtN(e.con_restricciones)} con restricciones)` : ''} · <b>${fmtN(e.egreso)}</b> de egreso</div></td></tr>` : ''}
        <tr><td style="padding:22px 32px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${alertas.length ? '#FFF4E5' : '#E7F6EC'};border-radius:14px"><tr>
            <td style="padding:14px 18px;${FONT};font-size:13.5px;line-height:1.6;color:#0B2235">
              <b style="color:${alertas.length ? '#B45309' : '#15803D'}">Inventario al día de hoy:</b>
              ${alertas.length ? alertas.join(' · ') : 'sin medicamentos bajo mínimo ni lotes caducados.'}</td></tr></table></td></tr>
        ${site ? `<tr><td style="padding:26px 32px 0">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:#F58020">
            <a href="${esc(site)}/" style="display:inline-block;padding:14px 26px;${FONT};color:#FFFFFF;font-size:15px;font-weight:800;text-decoration:none;border-radius:12px">Ver el panel completo &rarr;</a>
          </td></tr></table></td></tr>` : ''}
        <tr><td style="padding:30px 32px 28px;${FONT}">
          <div style="border-top:1px solid #EDF1F4;padding-top:16px;color:#8494A1;font-size:12px;line-height:1.6">
            Información estadística agregada: no incluye nombres de colaboradores ni datos clínicos individuales.<br>
            Lo recibes por tu puesto. Envío automático el día 1 de cada mes.</div></td></tr>
      </table></td></tr>
    <tr><td align="center" style="padding:22px 12px 0;${FONT};color:#97A6B2;font-size:12px;line-height:1.6">
      <b style="color:#6B7C8A">Pet's Table S.A. de C.V.</b> · Servicio Médico · Salud laboral<br>
      © ${new Date().getFullYear()} Pet's Table. Uso interno.</td></tr>
  </table>
</td></tr></table></body></html>`;
}
function textoPlano(r: R, nombre: string) {
  const c = r.citas?.actual || {}, e = r.examenes?.actual || {};
  return [`Hola ${nombre},`, `Resumen de Servicio Médico · ${nombreMes(r.desde)}`,
    `Consultas atendidas: ${fmtN(c.atendidas)} · Colaboradores atendidos: ${fmtN(c.colaboradores)}`,
    `Citas solicitadas: ${fmtN(c.solicitadas)} · Canceladas: ${fmtN(c.canceladas)} · No se presentó: ${fmtN(c.no_asistio)}`,
    `Medicamento entregado: ${fmtN(r.dispensadas?.actual)} unidades`,
    `Exámenes: ${fmtN(e.ingreso)} de ingreso, ${fmtN(e.egreso)} de egreso`,
    sitio() ? `${sitio()}/` : ''].filter(Boolean).join('\n');
}

// deno-lint-ignore no-explicit-any
async function destinatarios(admin: any) {
  const { data: cfg } = await admin.from('config_med').select('resumen_puestos').eq('id', 1).maybeSingle();
  const puestos = new Set(((cfg?.resumen_puestos || []) as string[]).map(norm));
  const { data: us } = await admin.from('usuarios_med').select('id, nombre, email, puesto').eq('activo', true);
  return ((us || []) as { id: string; nombre: string; email: string; puesto: string | null }[])
    .filter((u) => u.email && u.puesto && puestos.has(norm(u.puesto)));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Método no permitido.' });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    const body = await req.json().catch(() => ({}));
    const cronHdr = req.headers.get('x-med-cron');

    // ---- Envío automático (pg_cron) ----
    if (cronHdr) {
      const { data: secreto } = await admin.rpc('med_cron_secreto');
      if (!secreto || !igual(cronHdr, String(secreto))) return json(401, { error: 'No autorizado.' });
      const mes = mesAnterior();
      const ins = await admin.from('resumenes_med').insert({ periodo: mes }).select('periodo').maybeSingle();
      if (ins.error) {
        if (ins.error.code === '23505') return json(200, { ok: true, duplicado: true, periodo: mes });
        throw ins.error;
      }
      const { data: r, error } = await admin.rpc('med_resumen_mensual', { p_mes: mes });
      if (error) throw error;
      const dest = await destinatarios(admin);
      let enviados = 0;
      for (const d of dest) {
        if (await enviar(d.email, `Resumen mensual de Servicio Médico · ${nombreMes(mes)}`, plantilla(r, d.nombre, `cid:${LOGO_CID}`), textoPlano(r, d.nombre))) enviados++;
      }
      await admin.from('resumenes_med').update({ enviados }).eq('periodo', mes);
      return json(200, { ok: true, periodo: mes, destinatarios: dest.length, enviados });
    }

    // ---- Vista previa / prueba (administradores, desde Mi perfil) ----
    const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: perfil, error: pErr } = await caller.rpc('med_mi_perfil');
    const yo = perfil?.[0];
    if (pErr || !yo) return json(403, { error: 'Usuario no autorizado.' });
    if (yo.rol !== 'admin') return json(403, { error: 'Solo para administradores.' });
    const mes = /^\d{4}-\d{2}$/.test(String(body.mes || '')) ? `${body.mes}-01` : mesAnterior();
    const { data: r, error } = await caller.rpc('med_resumen_mensual', { p_mes: mes });
    if (error) throw error;
    const dest = await destinatarios(admin);
    const asunto = `Resumen mensual de Servicio Médico · ${nombreMes(mes)}`;
    if (body.vista) {
      return json(200, { html: plantilla(r, yo.nombre, '__LOGO__'), asunto, configurado: correoConfigurado(),
        destinatarios: dest.map((d) => ({ nombre: d.nombre, puesto: d.puesto })) });
    }
    if (!correoConfigurado()) return json(200, { ok: false, configurado: false });
    const ok = await enviar(yo.email, `[Prueba] ${asunto}`, plantilla(r, yo.nombre, `cid:${LOGO_CID}`), textoPlano(r, yo.nombre));
    return json(200, { ok, configurado: true, para: yo.email });
  } catch (e) {
    console.error('resumen_mensual_med', e);
    return json(500, { error: 'No se pudo generar el resumen.' });
  }
});
