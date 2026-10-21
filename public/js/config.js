// Configuración pública del cliente.
// La llave "publishable/anon" está diseñada para usarse en el navegador:
// la seguridad la imponen las políticas RLS y las funciones del servidor.
// NUNCA coloques aquí la service_role key.
// Se incrusta en index.html con tools/build-single.ps1; APP_VERSION también
// se publica en version.json para avisar de nuevas versiones.
window.MED_CONFIG = {
  SUPABASE_URL: "https://domumnsezocubigfqwry.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_CDb37asQiekme1SuDnIANw_csZ5ZNRh",
  APP_VERSION: "1.15.0"
};
