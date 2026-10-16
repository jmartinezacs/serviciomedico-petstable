// Aplica el tema guardado antes de pintar la página (evita parpadeo).
(function () {
  try {
    var t = localStorage.getItem('med.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* almacenamiento no disponible: se usa el tema del sistema */ }
})();
