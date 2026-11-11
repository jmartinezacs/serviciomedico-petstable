// Aplica el tema guardado antes de pintar la página (evita parpadeo) y detecta si la app
// corre dentro del Portal Pet's Table (en /servicio-medico/ en vez de /). Dentro del portal usa su
// tema (portal.theme) y su manifiesto, para que se instale el portal y no una app suelta.
(function () {
  var base = location.pathname.replace(/[^/]*$/, '') || '/';
  var portal = base !== '/';
  window.APP_BASE = base;
  window.APP_PORTAL = portal;
  if (portal) {
    document.documentElement.classList.add('en-portal');
    var m = document.querySelector('link[rel="manifest"]');
    if (m) m.setAttribute('href', '/manifest.webmanifest');
  }
  try {
    var t = localStorage.getItem(portal ? 'portal.theme' : 'med.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* almacenamiento no disponible: se usa el tema del sistema */ }
})();
