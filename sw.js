// Service worker de Servicio Médico · Pet's Table
// Solo muestra notificaciones push. No guarda caché ni funciona sin conexión.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const ICONO = '/notif-icon.png';

// Ícono "tipo Facebook": foto circular de quien genera el aviso con el ícono de la
// app en pequeño abajo a la derecha. Si algo falla (sin foto, sin red, navegador
// sin OffscreenCanvas) se usa el ícono normal de la app.
async function iconoConFoto(foto) {
  if (!foto || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return ICONO;
  try {
    if (new URL(foto).protocol !== 'https:') return ICONO;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const [rf, ri] = await Promise.all([fetch(foto, { mode: 'cors', signal: ctl.signal }), fetch(ICONO, { signal: ctl.signal })]);
    clearTimeout(t);
    if (!rf.ok || !ri.ok) return ICONO;
    const [img, ico] = await Promise.all([createImageBitmap(await rf.blob()), createImageBitmap(await ri.blob())]);
    const S = 256, c = new OffscreenCanvas(S, S), g = c.getContext('2d');
    // Foto recortada en círculo (centrada, cubriendo todo el círculo)
    g.save(); g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); g.clip();
    const k = Math.max(S / img.width, S / img.height), w = img.width * k, h = img.height * k;
    g.drawImage(img, (S - w) / 2, (S - h) / 2, w, h); g.restore();
    // Insignia: ícono de la app en un círculo con aro blanco
    const r = 46, cx = S - r - 6, cy = S - r - 6;
    g.beginPath(); g.arc(cx, cy, r + 7, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    g.save(); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
    g.drawImage(ico, cx - r, cy - r, r * 2, r * 2); g.restore();
    const b = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return `data:image/png;base64,${btoa(s)}`;
  } catch {
    return ICONO;
  }
}

async function mostrar(d) {
  // Aviso visible: vibra, se mantiene en pantalla hasta que la persona lo atiende
  // y vuelve a sonar aunque reemplace a uno anterior con la misma etiqueta.
  const opciones = {
    body: d.body || '',
    icon: await iconoConFoto(d.foto),
    // Android pinta la insignia de la barra de estado como silueta: debe ser blanca sobre transparente
    badge: '/notif-badge.png',
    tag: d.tag || `med-${Date.now()}`,
    renotify: true,
    requireInteraction: true,
    silent: false,
    vibrate: [300, 120, 300, 120, 500],
    timestamp: Date.now(),
    actions: [{ action: 'ver', title: 'Ver ahora' }],
    data: { url: d.url || '/' },
  };
  try {
    await self.registration.showNotification(d.title || 'Servicio Médico', opciones);
  } catch {
    // Si el navegador rechaza el ícono generado, se muestra con el de la app
    await self.registration.showNotification(d.title || 'Servicio Médico', { ...opciones, icon: ICONO });
  }
}

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(mostrar(d));
});

// Aviso de prueba desde Mi perfil (misma apariencia que los avisos reales)
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.tipo !== 'aviso-prueba' || (e.origin && e.origin !== self.location.origin)) return;
  e.waitUntil(mostrar({ title: d.title, body: d.body, foto: d.foto, tag: `prueba-${Date.now()}`, url: '/#/perfil' }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (new URL(c.url).origin === self.location.origin) {
        if ('navigate' in c) await c.navigate(url).catch(() => {});
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
