// Edge Function: gestionar_usuarios_med
// Crea la cuenta de Supabase Auth de un usuario ya registrado en usuarios_med.
// - Solo la pueden invocar administradores activos de Servicio Médico.
// - La service_role key vive únicamente aquí (variable de entorno de Supabase).
// - NUNCA modifica cuentas existentes (contraseñas compartidas con otras apps).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Método no permitido.' });

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // 1) Identidad y rol de quien llama (con su propio token)
    const caller = createClient(url, anon, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: perfil, error: perfilErr } = await caller.rpc('med_mi_perfil');
    if (perfilErr || !perfil?.[0] || perfil[0].rol !== 'admin') {
      return json(403, { error: 'Solo los administradores de Servicio Médico pueden crear cuentas.' });
    }

    const body = await req.json().catch(() => ({}));
    if (body.accion !== 'crear_cuenta') return json(400, { error: 'Acción no válida.' });

    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!/^[a-z0-9._%+-]+@petstable\.mx$/.test(email)) return json(400, { error: 'El correo debe ser @petstable.mx.' });
    if (password.length < 8 || password.length > 72) return json(400, { error: 'La contraseña temporal debe tener entre 8 y 72 caracteres.' });

    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

    // 2) Solo se crean cuentas para usuarios previamente autorizados en esta app
    const { data: u, error: uErr } = await admin.from('usuarios_med').select('id, nombre, activo').eq('email', email).maybeSingle();
    if (uErr) throw uErr;
    if (!u) return json(400, { error: 'Primero registra a la persona en Usuarios de Servicio Médico.' });
    if (!u.activo) return json(400, { error: 'El usuario está inactivo.' });

    // 3) Crear la cuenta (confirmada). Si ya existe, no se toca.
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: u.nombre },
    });
    if (error) {
      const msg = String(error.message || '');
      if ((error as { code?: string }).code === 'email_exists' || /already|exists|registered/i.test(msg)) {
        return json(409, { error: 'Ese correo ya tiene cuenta Pet\'s Table: entrará con su contraseña actual.' });
      }
      if ((error as { code?: string }).code === 'weak_password' || /password/i.test(msg)) {
        return json(400, { error: 'La contraseña no cumple la política de seguridad: usa al menos 8 caracteres con letras y números.' });
      }
      throw error;
    }
    return json(200, { ok: true, id: data.user?.id });
  } catch (e) {
    console.error('gestionar_usuarios_med', e);
    return json(500, { error: 'No se pudo crear la cuenta. Intenta de nuevo.' });
  }
});
