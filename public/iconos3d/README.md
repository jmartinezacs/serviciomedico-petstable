# Imágenes realistas de la app (estándar Pet's Table)

Aquí van las imágenes realistas que sustituyen a las ilustraciones de `public/emoji/`. Mientras una imagen
no esté aquí **y** su nombre no esté en `ICONOS_3D` (`public/js/core.js`), la app usa la ilustración de siempre.

## Para agregar una imagen

1. Guarda aquí `<nombre>.webp`, con el **mismo nombre** que su ilustración en `public/emoji/<nombre>.svg`.
2. En `public/js/core.js`, agrega `'<nombre>'` a `ICONOS_3D`.
3. Si reemplazas una imagen ya publicada, sube `ICO3D_VER` en `core.js`.
4. Sube `APP_VERSION`, compila y publica como siempre. Si una imagen falta o no carga, la app vuelve sola a la ilustración.

## Especificación (igual en todas las apps)

- WebP de **256 × 256 px**, calidad 90, **fondo transparente**, sRGB. Original de 1024 × 1024 PNG para archivo.
- **Uno o dos objetos**, reconocibles a 24 px, con colores naturales del objeto; el color del área a lo sumo como detalle.
- Mismo sistema: cámara a ~30° sin distorsión, luz suave desde arriba a la izquierda, sombra de contacto suave,
  12 % de margen libre. Sin texto, marcos ni fondos.
- No aplica a favicons, íconos de instalación ni íconos de Apple.
