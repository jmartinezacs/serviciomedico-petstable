// Envío de correo (mismo esquema que notificar_med): Gmail / Google Workspace por
// SMTP seguro en el puerto 465 con contraseña de aplicación (secretos GMAIL_USER y
// GMAIL_APP_PASSWORD); si no están, Resend (RESEND_API_KEY / MED_EMAIL_FROM).
// El logotipo se descarga del sitio publicado (MED_SITE_URL/logo-correo.png) y
// se adjunta incrustado (cid) para que se vea aunque se bloqueen imágenes remotas.
export const LOGO_CID = 'logo-petstable';
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const sitio = () => (Deno.env.get('MED_SITE_URL') || '').replace(/\/$/, '');
export const correoConfigurado = () => !!(Deno.env.get('GMAIL_USER') && Deno.env.get('GMAIL_APP_PASSWORD')) || !!Deno.env.get('RESEND_API_KEY');

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

let logoCache: string | null | undefined;
export async function logoB64() {
  if (logoCache !== undefined) return logoCache;
  logoCache = null;
  const site = sitio();
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

// Envía un correo ya armado. `html` debe usar `cid:logo-petstable` para el logotipo.
export async function enviar(para: string, asunto: string, html: string, texto: string) {
  const logo = await logoB64();
  const gmail = await transporteGmail();
  const resend = Deno.env.get('RESEND_API_KEY');
  if (!logo) html = html.replace(/<img [^>]*cid:logo-petstable[^>]*>/, '<span style="font-family:Segoe UI,Arial,sans-serif;color:#F58020;font-size:26px;font-weight:900">pet\'s table</span>');
  try {
    if (gmail) {
      await gmail.t.sendMail({ from: `"Servicio Médico · Pet's Table" <${gmail.user}>`, to: para, subject: asunto, text: texto, html,
        attachments: logo ? [{ filename: 'petstable.png', content: logo, encoding: 'base64', cid: LOGO_CID, contentDisposition: 'inline' }] : [] });
      return true;
    }
    if (resend) {
      const from = Deno.env.get('MED_EMAIL_FROM') || 'Servicio Médico <onboarding@resend.dev>';
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${resend}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [para], subject: asunto, html, text: texto,
          attachments: logo ? [{ filename: 'petstable.png', content: logo, content_id: LOGO_CID }] : [] }),
      });
      if (r.ok) return true;
      console.error('correo', r.status, await r.text());
    }
  } catch (e) { console.error('correo', (e as Error).message); }
  return false;
}
