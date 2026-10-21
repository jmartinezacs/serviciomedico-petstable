// Edge Function: recordatorios_med
// La invoca pg_cron cada 20 minutos. Solo actúa de lunes a viernes entre las
// 07:00 y las 19:00 (hora de Ciudad de México):
//   1) Hora en punto: al médico (administradores con "Recibe avisos"), citas
//      pendientes por confirmar o rechazar (incluye urgencias).
//   2) 09:00: al médico, medicamentos bajo stock mínimo o agotados y lotes
//      caducados que aún tienen existencia.
//   3) 18:00: a quien solicitó cada cita confirmada del siguiente día hábil.
//   4) Cada ejecución: a quien solicitó cada cita confirmada que empieza en
//      unos 40-60 minutos.
// Los recordatorios de cita se registran en avisos_med para no repetirse.
// Protegida con un secreto que vive en la base de datos (med_private.cron).
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const TZ = 'America/Mexico_City';
const HORA_STOCK = 9;
const HORA_DIA_ANTERIOR = 18;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Aviso = { title: string; body: string; url: string; tag: string };

function igual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function plural(w: string, n: number) {
  if (Math.abs(n) === 1 || /^(ml|mg|g|l|kg|mcg|ui)$/i.test(w)) return w;
  return /[aeiouáéíóú]$/i.test(w) ? `${w}s` : `${w}es`;
}
const hhmm = (t: string) => t.slice(0, 5);
const folio = (n: number) => `CM-${String(n).padStart(5, '0')}`;
function sumarDias(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function siguienteHabil(iso: string) {
  let d = sumarDias(iso, 1);
  while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = sumarDias(d, 1);
  return d;
}
function fechaLarga(iso: string) {
  return new Intl.DateTimeFormat('es-MX', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${iso}T12:00:00Z`));
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Método no permitido.' });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: secreto } = await admin.rpc('med_cron_secreto');
    if (!secreto || !igual(req.headers.get('x-med-cron') || '', String(secreto))) return json(401, { error: 'No autorizado.' });

    // Día y hora en Ciudad de México
    const ahora = new Date();
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(ahora).map((x) => [x.type, x.value]));
    const h = Number(p.hour), min = Number(p.minute);
    if (['Sat', 'Sun'].includes(p.weekday)) return json(200, { ok: true, omitido: 'Fin de semana: sin recordatorios.' });
    if (h < 7 || h > 19) return json(200, { ok: true, omitido: 'Fuera del horario de avisos (07:00-19:00).' });
    const enPunto = min < 10; // la ejecución de la hora en punto (pg_cron puede llegar con segundos de retraso)
    const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);
    const minutosHoy = h * 60 + min;

    const alMedico: Aviso[] = [];
    const resumen: Record<string, number> = {};

    // 1) Citas pendientes (hora en punto)
    if (enPunto) {
      const { data: pend, error } = await admin.from('citas_med').select('id, tipo').eq('estado', 'pendiente').gte('fecha', hoy);
      if (error) throw error;
      resumen.pendientes = pend?.length || 0;
      if (pend?.length) {
        const n = pend.length, urg = pend.filter((x) => x.tipo === 'urgente').length;
        alMedico.push({
          title: urg
            ? `Tienes ${n} ${n === 1 ? 'cita pendiente' : 'citas pendientes'} (${urg} urgente${urg === 1 ? '' : 's'})`
            : `Tienes ${n} ${n === 1 ? 'cita pendiente' : 'citas pendientes'} por validar`,
          body: 'Revisa la sección Citas para confirmarlas o rechazarlas.',
          url: '/#/citas?estado=pendiente', tag: 'recordatorio-pendientes',
        });
      }
    }

    // 2) Inventario (09:00)
    if (enPunto && h === HORA_STOCK) {
      const { data: bajos } = await admin.from('v_stock_med')
        .select('nombre, unidad, existencia_vigente, stock_minimo, estado_stock')
        .eq('activo', true).gt('stock_minimo', 0).in('estado_stock', ['bajo', 'agotado']).order('existencia_vigente');
      const { data: cad } = await admin.from('v_lotes_med').select('id').gt('existencia', 0).eq('estado_caducidad', 'caducado');
      const stock = bajos?.length || 0, caducados = cad?.length || 0;
      resumen.stock = stock; resumen.caducados = caducados;
      if (stock || caducados) {
        const lista = (bajos || []).slice(0, 4).map((m) =>
          `${m.nombre}: ${m.estado_stock === 'agotado' ? 'agotado' : `${m.existencia_vigente} ${plural(m.unidad, m.existencia_vigente)} (mín. ${m.stock_minimo})`}`).join(' · ');
        const extra = stock > 4 ? ` y ${stock - 4} más` : '';
        const partes = [];
        if (stock) partes.push(`${stock} ${stock === 1 ? 'medicamento' : 'medicamentos'} bajo stock mínimo`);
        if (caducados) partes.push(`${caducados} ${caducados === 1 ? 'lote caducado' : 'lotes caducados'} con existencia`);
        alMedico.push({
          title: `Inventario: ${partes.join(' y ')}`,
          body: stock ? `${lista}${extra}. Registra una entrada para reabastecer.` : 'Retira los lotes caducados del inventario.',
          url: '/#/inventario?estado=alerta', tag: 'recordatorio-stock',
        });
      }
    }

    // 3 y 4) Recordatorios de cita a quien la solicitó
    type Cita = { id: string; folio: number; fecha: string; hora: string; solicitado_por: string; colaborador: { nombre: string } | null };
    const porSolicitante: { usuario: string; cita: Cita; evento: string; aviso: Aviso }[] = [];
    const sel = 'id, folio, fecha, hora, solicitado_por, colaborador:colaboradores_med(nombre)';
    if (enPunto && h === HORA_DIA_ANTERIOR) {
      const manana = siguienteHabil(hoy);
      const { data } = await admin.from('citas_med').select(sel).eq('estado', 'confirmada').eq('fecha', manana).not('hora', 'is', null).order('hora');
      for (const c of (data || []) as unknown as Cita[]) {
        porSolicitante.push({ usuario: c.solicitado_por, cita: c, evento: 'recordatorio_dia', aviso: {
          title: `Recordatorio: cita el ${fechaLarga(c.fecha)} a las ${hhmm(c.hora)} h`,
          body: `${c.colaborador?.nombre || 'Colaborador'} · ${folio(c.folio)}. Si ya no la necesita, cancélala para liberar el horario.`,
          url: `/#/citas?cita=${c.id}`, tag: `recordatorio-${c.id}`,
        } });
      }
    }
    {
      const desde = minutosHoy + 35, hasta = minutosHoy + 65;
      const t = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      if (hasta < 24 * 60) {
        const { data } = await admin.from('citas_med').select(sel).eq('estado', 'confirmada').eq('fecha', hoy)
          .gte('hora', t(desde)).lt('hora', t(hasta)).order('hora');
        for (const c of (data || []) as unknown as Cita[]) {
          porSolicitante.push({ usuario: c.solicitado_por, cita: c, evento: 'recordatorio_hora', aviso: {
            title: `En una hora: cita a las ${hhmm(c.hora)} h`,
            body: `${c.colaborador?.nombre || 'Colaborador'} · ${folio(c.folio)}. Acude puntualmente a Servicio Médico.`,
            url: `/#/citas?cita=${c.id}`, tag: `recordatorio-${c.id}`,
          } });
        }
      }
    }
    // Registrar para no repetir (el índice único de avisos_med descarta duplicados)
    const pendientesEnvio: typeof porSolicitante = [];
    for (const r of porSolicitante) {
      const { data, error } = await admin.from('avisos_med')
        .upsert({ cita_id: r.cita.id, evento: r.evento, clave: `${r.cita.fecha}T${hhmm(r.cita.hora)}` }, { onConflict: 'cita_id,evento,clave', ignoreDuplicates: true })
        .select('id');
      if (!error && data?.length) pendientesEnvio.push(r);
    }
    resumen.recordatorios_cita = pendientesEnvio.length;

    if (!alMedico.length && !pendientesEnvio.length) return json(200, { ok: true, ...resumen, enviados: 0 });

    const { data: k } = await admin.rpc('med_vapid_claves');
    if (!k?.[0]) return json(200, { ok: true, ...resumen, enviados: 0, motivo: 'Sin claves de notificación aún.' });
    webpush.setVapidDetails(k[0].contacto, k[0].vapid_publica, k[0].vapid_privada);

    const { data: medicos } = alMedico.length
      ? await admin.from('usuarios_med').select('id').eq('activo', true).eq('rol', 'admin').eq('recibe_avisos', true)
      : { data: [] as { id: string }[] };
    const destinos = new Map<string, Aviso[]>();
    for (const m of medicos || []) destinos.set(m.id, [...alMedico]);
    for (const r of pendientesEnvio) destinos.set(r.usuario, [...(destinos.get(r.usuario) || []), r.aviso]);
    if (!destinos.size) return json(200, { ok: true, ...resumen, enviados: 0, motivo: 'Sin destinatarios.' });

    const { data: activos } = await admin.from('usuarios_med').select('id').eq('activo', true).in('id', [...destinos.keys()]);
    const ids = (activos || []).map((u) => u.id);
    const { data: subs } = ids.length
      ? await admin.from('push_subs_med').select('id, usuario_id, endpoint, p256dh, auth').in('usuario_id', ids)
      : { data: [] };

    // Los recordatorios los "envía" Servicio Médico: llevan la foto del médico
    const base = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/`;
    const { data: med } = await admin.from('usuarios_med').select('foto_url').eq('activo', true).eq('es_medico', true).limit(1).maybeSingle();
    const foto = typeof med?.foto_url === 'string' && med.foto_url.startsWith(base) ? med.foto_url : null;

    let enviados = 0;
    for (const s of subs || []) {
      for (const a of destinos.get(s.usuario_id) || []) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ ...a, foto }), { TTL: 60 * 50, urgency: 'high' });
          enviados++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) { await admin.from('push_subs_med').delete().eq('id', s.id); break; }
          console.error('push', code, (e as Error).message);
        }
      }
    }
    return json(200, { ok: true, ...resumen, enviados });
  } catch (e) {
    console.error('recordatorios_med', e);
    return json(500, { error: 'Error al enviar recordatorios.' });
  }
});
