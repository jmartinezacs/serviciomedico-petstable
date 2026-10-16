// Edge Function: recordatorios_med
// La invoca pg_cron cada hora en punto. Solo actúa de lunes a viernes entre
// las 07:00 y las 19:00 (hora de Ciudad de México) y envía push a los
// administradores con "Recibe avisos":
//   1) Cada hora: citas pendientes por confirmar o rechazar (incluye urgencias).
//   2) Una vez al día (09:00): medicamentos bajo stock mínimo o agotados y
//      lotes caducados que aún tienen existencia.
// Protegida con un secreto que vive en la base de datos (med_private.cron).
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const TZ = 'America/Mexico_City';
const HORA_STOCK = 9;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

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
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(ahora).map((x) => [x.type, x.value]));
    const h = Number(p.hour);
    if (['Sat', 'Sun'].includes(p.weekday)) return json(200, { ok: true, omitido: 'Fin de semana: sin recordatorios.' });
    if (h < 7 || h > 19) return json(200, { ok: true, omitido: 'Fuera del horario de avisos (07:00-19:00).' });
    const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);

    // Mensajes a enviar en esta ejecución
    const avisos: { title: string; body: string; url: string; tag: string }[] = [];

    // 1) Citas pendientes (cada hora)
    const { data: pend, error } = await admin.from('citas_med').select('id, tipo').eq('estado', 'pendiente').gte('fecha', hoy);
    if (error) throw error;
    if (pend?.length) {
      const n = pend.length, urg = pend.filter((x) => x.tipo === 'urgente').length;
      avisos.push({
        title: urg
          ? `Tienes ${n} ${n === 1 ? 'cita pendiente' : 'citas pendientes'} (${urg} urgente${urg === 1 ? '' : 's'})`
          : `Tienes ${n} ${n === 1 ? 'cita pendiente' : 'citas pendientes'} por validar`,
        body: 'Revisa la sección Citas para confirmarlas o rechazarlas.',
        url: '/#/citas?estado=pendiente', tag: 'recordatorio-pendientes',
      });
    }

    // 2) Inventario (una vez al día)
    let stock = 0, caducados = 0;
    if (h === HORA_STOCK) {
      const { data: bajos } = await admin.from('v_stock_med')
        .select('nombre, unidad, existencia_vigente, stock_minimo, estado_stock')
        .eq('activo', true).gt('stock_minimo', 0).in('estado_stock', ['bajo', 'agotado']).order('existencia_vigente');
      const { data: cad } = await admin.from('v_lotes_med').select('id').gt('existencia', 0).eq('estado_caducidad', 'caducado');
      stock = bajos?.length || 0; caducados = cad?.length || 0;
      if (stock || caducados) {
        const lista = (bajos || []).slice(0, 4).map((m) =>
          `${m.nombre}: ${m.estado_stock === 'agotado' ? 'agotado' : `${m.existencia_vigente} ${plural(m.unidad, m.existencia_vigente)} (mín. ${m.stock_minimo})`}`).join(' · ');
        const extra = stock > 4 ? ` y ${stock - 4} más` : '';
        const partes = [];
        if (stock) partes.push(`${stock} ${stock === 1 ? 'medicamento' : 'medicamentos'} bajo stock mínimo`);
        if (caducados) partes.push(`${caducados} ${caducados === 1 ? 'lote caducado' : 'lotes caducados'} con existencia`);
        avisos.push({
          title: `Inventario: ${partes.join(' y ')}`,
          body: stock ? `${lista}${extra}. Registra una entrada para reabastecer.` : 'Retira los lotes caducados del inventario.',
          url: '/#/inventario?estado=alerta', tag: 'recordatorio-stock',
        });
      }
    }
    if (!avisos.length) return json(200, { ok: true, pendientes: pend?.length || 0, stock, caducados, enviados: 0 });

    const { data: dest } = await admin.from('usuarios_med').select('id').eq('activo', true).eq('rol', 'admin').eq('recibe_avisos', true);
    if (!dest?.length) return json(200, { ok: true, enviados: 0, motivo: 'Sin destinatarios.' });
    const { data: k } = await admin.rpc('med_vapid_claves');
    if (!k?.[0]) return json(200, { ok: true, enviados: 0, motivo: 'Sin claves de notificación aún.' });
    webpush.setVapidDetails(k[0].contacto, k[0].vapid_publica, k[0].vapid_privada);

    const { data: subs } = await admin.from('push_subs_med').select('id, endpoint, p256dh, auth').in('usuario_id', dest.map((d) => d.id));
    let enviados = 0;
    for (const s of subs || []) {
      for (const a of avisos) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(a), { TTL: 60 * 50 });
          enviados++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) { await admin.from('push_subs_med').delete().eq('id', s.id); break; }
          console.error('push', code, (e as Error).message);
        }
      }
    }
    return json(200, { ok: true, pendientes: pend?.length || 0, stock, caducados, enviados });
  } catch (e) {
    console.error('recordatorios_med', e);
    return json(500, { error: 'Error al enviar recordatorios.' });
  }
});
