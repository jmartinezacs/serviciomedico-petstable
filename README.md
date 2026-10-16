# Servicio Médico · Pet's Table S.A. de C.V.

**Salud laboral** — sistema web para solicitar y controlar citas médicas y mantener actualizado el inventario de medicamentos.

- **Frontend:** HTML + CSS + JavaScript (módulos ES), sin compilación. Librerías por CDN con versión fija: supabase-js 2.45.4, Lucide 0.453.0, Chart.js 4.4.4.
- **Backend:** Supabase (PostgreSQL, Auth, RLS, funciones `security definer`).
- **Hosting:** Vercel, con despliegue automático desde GitHub.
- **Zona horaria de operación:** `America/Mexico_City`.

---

## 0. Publicación (4 archivos)

La carpeta **`entrega/`** contiene todo lo que hay que subir:

| Archivo | Contenido |
|---|---|
| `index.html` | El sitio completo: estilos, código, logotipo, ícono del login, favicon, configuración pública de Supabase y una Content-Security-Policy con hashes |
| `apple-touch-icon.png` | Ícono de 180×180 para iPhone/iPad y para las notificaciones |
| `sw.js` | *Service worker*: muestra las notificaciones push. El navegador exige que sea un archivo aparte |
| `manifest.webmanifest` | Manifiesto de la app instalada. iPhone lo exige para permitir notificaciones |

1. Crea un repositorio en GitHub y sube **los cuatro archivos a la raíz** (no dentro de una carpeta).
2. En Vercel, *Add New → Project →* elige el repositorio *→ Deploy*. No necesita variables de entorno, comando de compilación ni configuración.
3. Abre `https://TU-DOMINIO/apple-touch-icon.png` para confirmar que el ícono responde.

### Horario y citas de urgencia (v1.4)
- **Bloques:** de 20 minutos, de lunes a viernes, de 09:00 a 17:20; el último bloque empieza a las 17:00.
- **Cita de urgencia / extraordinaria:**
  - No usa bloques y puede pedirse cualquier día. El motivo de la urgencia es obligatorio.
  - Servicio Médico recibe el aviso y **asigna un horario especial** al confirmarla, o la **rechaza** con un motivo; quien la pidió recibe el aviso.
  - Si se atiende sin horario asignado, se registra la hora en que se atendió.
- **Recordatorio cada hora al médico:**
  - `pg_cron` ejecuta `recordatorios_med` cada hora en punto. La función envía un push a los administradores con "Recibe avisos" mientras haya citas pendientes por validar.
  - Solo envía **de lunes a viernes**, entre las 07:00 y las 19:00, hora de Ciudad de México.
  - **Inventario:** una vez al día, a las 09:00, avisa qué medicamentos están bajo su stock mínimo o agotados y qué lotes caducados aún tienen existencia.
  - El llamado está protegido con un secreto guardado en `med_private.cron`.
  - Para pausarlo, ejecuta `select cron.unschedule('med_recordatorio_pendientes');`.

### Avisos de citas (notificaciones y correo)
- **Push:** cada persona los activa en *Mi perfil* o desde el aviso del Panel. En iPhone primero debe instalar la app ("Agregar a pantalla de inicio") y abrirla desde ese ícono.
- **Quién recibe qué:**
  - Los administradores con la opción **"Recibe avisos de nuevas citas"** reciben las solicitudes nuevas y las cancelaciones o reprogramaciones que hace un usuario.
  - Quien solicitó una cita recibe el aviso cuando Servicio Médico la **confirma, cancela o reprograma**.
- La Edge Function `notificar_med` verifica que cada aviso corresponda a un cambio real y no lo envía dos veces. Las claves de notificación se generan y guardan dentro de Supabase.
- **Correo (opcional):**
  1. Crea una cuenta en [resend.com](https://resend.com). El plan gratuito incluye 3,000 correos al mes.
  2. Verifica el dominio `petstable.mx`.
  3. En *Supabase → Edge Functions → Secrets* agrega:
     - `RESEND_API_KEY`: la clave de Resend.
     - `MED_EMAIL_FROM`: por ejemplo `Servicio Médico <avisos@petstable.mx>`.
     - `MED_SITE_URL`: la URL de Vercel.

  Sin esa clave solo se envían los avisos push.

**Para modificar el sitio:** edita las fuentes en `public/` y regenera con el comando de abajo. Luego sube el nuevo `entrega/index.html`.

```bash
powershell -ExecutionPolicy Bypass -File tools\build-single.ps1
```

**Alta de usuarios desde el sitio (Usuarios → Nuevo usuario):** se capturan nombre, correo, puesto, área, rol y foto.
- Si el correo **ya tiene** cuenta Pet's Table, la persona entra con su contraseña de siempre. Esa cuenta **no se modifica**.
- Si **no tiene** cuenta, se crea con una contraseña temporal (hay un botón para generarla) a través de la Edge Function `gestionar_usuarios_med`. Esa función vive en Supabase y es la única que usa la llave secreta. La persona puede cambiar la contraseña en *Mi perfil*.
- Las fotos nuevas se recortan a 320×320 y se guardan en el bucket propio `avatares_med`. Las fotos existentes del bucket `avatares` solo se enlazan; esta app no puede escribir en él.

---

## 1. Estructura

```
servicio-medico/
├── public/                     ← raíz publicada por Vercel
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── apple-touch-icon.png    (180×180, ícono oficial)
│   ├── favicon.ico             (16/32/48)
│   ├── icons/ icon-192.png · icon-512.png · icon-maskable-512.png · favicon-32.png
│   ├── img/logo-petstable.webp (logotipo oficial, sin modificar)
│   ├── css/app.css
│   └── js/
│       ├── config.js           (URL + llave pública; se regenera en Vercel)
│       ├── theme-init.js
│       ├── core.js             (cliente, utilidades, modales, tablas, validación)
│       ├── app.js              (sesión, header, menú, rutas)
│       └── modules/ dashboard · citas · colaboradores · inventario · usuarios · bitacora · perfil
├── supabase/migrations/        ← migraciones SQL reproducibles (ya aplicadas)
├── tests/sql/pruebas_reglas_negocio.sql
├── scripts/generate-config.mjs ← genera config.js con variables de entorno
├── tools/make-icons.ps1        ← regenera íconos desde el original
├── tools/serve.ps1             ← servidor local para pruebas (Windows)
├── vercel.json · package.json · .env.example · .gitignore
```

---

## 2. Roles y permisos

| Acción | Administrador | Usuario |
|---|:-:|:-:|
| Ver panel con KPI y gráficas | ✔ (todo) | ✔ (solo sus citas) |
| Solicitar cita para un colaborador | ✔ | ✔ |
| Ver citas | Todas | Solo las que solicitó |
| Modificar cita pendiente propia | ✔ | ✔ |
| Confirmar · reprogramar confirmada · marcar inasistencia | ✔ | — |
| Cancelar cita (con motivo obligatorio) | ✔ | Solo las propias |
| Registrar atención y dispensar medicamentos | ✔ | — |
| Ver sintomatología y notas de atención | ✔ | — |
| Consultar y registrar colaboradores | ✔ | ✔ |
| Editar, desactivar o eliminar colaboradores · gestionar áreas | ✔ | — |
| Inventario (catálogo, entradas, salidas, ajustes, movimientos) | ✔ | — |
| Usuarios, configuración y bitácora | ✔ | — |

**Usuarios iniciales:** javier.martinez, kevin.hernandez, nelisa.ramirez, julian.pacheco y servicio.medico (Administrador); abigail.ordaz (Usuario). Todos con dominio `@petstable.mx`.

Todas las reglas se aplican **en la base de datos** (RLS, triggers y funciones). Ocultar botones en la interfaz es solo una ayuda visual.

---

## 3. Reglas de negocio

**Proporcionadas por el usuario**
1. Los usuarios solicitan citas para colaboradores de un catálogo. Los colaboradores no necesitan cuenta.
2. Horario: lunes a viernes de 9:00 a 17:30, en bloques de 30 minutos (el último inicia a las 17:00). Un bloque admite una sola cita activa.
3. Los medicamentos se descuentan al registrar la atención. Además hay entradas, salidas y ajustes manuales.
4. Datos clínicos mínimos: motivo, sintomatología y una nota breve. Solo los consultan los administradores.

**Supuestos documentados (ajustables)**

| Supuesto | Valor | Dónde cambiarlo |
|---|---|---|
| Ventana de alerta de caducidad | 60 días | Usuarios → Configuración |
| Stock mínimo | Por medicamento (0 = sin alerta) | Inventario → Editar |
| Días festivos | **No** se bloquean automáticamente | Requiere migración si se desea |
| Estados de cita | pendiente → confirmada → atendida; cancelada; no asistió | — |
| Un usuario no administrador agenda solo horarios futuros | Sí | Trigger `med_validar_cita` |
| Un administrador puede registrar citas del día en un bloque ya transcurrido (atención inmediata) | Sí | Trigger `med_validar_cita` |
| Solo se atienden citas de hoy o de fechas pasadas | Sí | `med_atender_cita` |
| Lotes caducados no se pueden dispensar; sí pueden darse de baja | Sí | RPC |
| Las entradas exigen caducidad posterior a hoy; un lote existente debe conservar su caducidad | Sí | `med_registrar_entrada` |
| Las citas no se eliminan; se cancelan (trazabilidad) | Sí | Sin política DELETE |
| Colaboradores, medicamentos y áreas con historial no se eliminan; se desactivan | Sí | Llaves foráneas `RESTRICT` |
| Siempre debe existir al menos un administrador activo; nadie cambia su propio rol ni estado | Sí | Trigger `med_validar_usuario` |
| La bitácora no replica el contenido clínico | Sí | `med_auditar` |

---

## 4. Modelo de datos (sufijo `_med`)

| Tabla | Propósito | Claves y restricciones principales |
|---|---|---|
| `areas_med` | Catálogo de áreas | nombre único (sin distinguir mayúsculas) |
| `usuarios_med` | Usuarios autorizados y su rol | email único `@petstable.mx`; rol `admin`/`usuario`; FK área |
| `colaboradores_med` | Pacientes | No. de empleado único (opcional); FK área (RESTRICT) |
| `citas_med` | Citas | folio consecutivo; día hábil; hora en bloque válido; **índice único parcial `(fecha, hora)` para citas activas**; motivo obligatorio al cancelar |
| `atenciones_med` | Atención 1:1 con la cita | sintomatología ≤500, nota ≤1000; solo administradores |
| `medicamentos_med` | Catálogo | clave única; stock mínimo ≥ 0 |
| `lotes_med` | Existencia por lote | (medicamento, lote) único; existencia ≥ 0; **sin escritura directa** |
| `movimientos_med` | Kardex (solo inserción) | tipo entrada/salida/ajuste/dispensación; signo validado; existencia resultante |
| `bitacora_med` | Auditoría automática | escritura solo por triggers |
| `config_med` | Configuración (fila única) | días de alerta 1–365 |

**Vistas** (`security_invoker`, respetan RLS): `v_citas_med`, `v_stock_med`, `v_lotes_med`, `v_movimientos_med`.

**Funciones RPC:** `med_mi_perfil`, `med_horarios_ocupados`, `med_atender_cita` (transaccional: cierra la cita, guarda la atención y descuenta los lotes en una sola operación), `med_registrar_entrada`, `med_registrar_salida`, `med_ajustar_lote`, `med_dashboard`, `med_estado_cuentas`.

**Aislamiento:** la instancia `domumnsezocubigfqwry` la comparten otras aplicaciones (EPP, `brom_*`, `*_pruind`, `*_calbas`). Este proyecto **no modificó** ninguna tabla, función, política ni trigger ajeno. Todos sus objetos llevan el sufijo `_med` o el prefijo `med_`.

---

## 5. Autenticación

- Se usa la cuenta de **Supabase Auth compartida**: la contraseña es la misma de las demás apps de Pet's Table.
- El acceso a *esta* app lo define la tabla `usuarios_med`, que se vincula por correo. Una cuenta sin registro activo ahí recibe el mensaje "sin acceso" y su sesión se cierra.
- Al cerrar sesión se usa `scope: 'local'`, para no cerrar las sesiones de las otras apps.
- "Mantener sesión" desactivado guarda la sesión en `sessionStorage`, que se borra al cerrar el navegador.

### ⚠ Pendiente: cuenta de `servicio.medico@petstable.mx`
Ese correo **todavía no existe en Supabase Auth**. Para crearlo: *Supabase → Authentication → Users → Invite user*.
Ten en cuenta que, al crear cualquier usuario en esta instancia, se ejecutan triggers de otras apps (`trg_asignar_perfil` crea un perfil "Usuario" en la app de EPP y `brom_on_auth_user_created` no hace nada para este correo). Es el comportamiento existente de la instancia y no lo modifiqué.

### Configuración de Auth recomendada (panel de Supabase)
1. **Authentication → URL Configuration → Redirect URLs:** agrega `https://TU-DOMINIO.vercel.app/**` para que funcione el enlace de "Olvidé mi contraseña".
2. **Authentication → Providers → Email → Leaked password protection:** activarla (aviso del asesor de seguridad).

---

## 6. Despliegue: GitHub + Vercel

### 6.1 Subir a GitHub
Este equipo no tiene `git` instalado. Hay dos opciones:
- **Web:** crea un repositorio privado en GitHub → *Add file → Upload files* → arrastra el **contenido** de la carpeta `servicio-medico/` (incluidos `.gitignore` y `.env.example`).
- **Con Git:** desde la carpeta `servicio-medico`:

```bash
git init -b main
```
```bash
git add . && git commit -m "Servicio Médico v1.0.0"
```
```bash
git remote add origin https://github.com/ORG/servicio-medico.git && git push -u origin main
```

### 6.2 Conectar Vercel
1. *Vercel → Add New → Project →* importa el repositorio.
2. **Framework Preset:** *Other*. `vercel.json` ya define `buildCommand` (`node scripts/generate-config.mjs`) y `outputDirectory` (`public`).
3. **Environment Variables** (Production y Preview), con los valores de `.env.example`:
   - `SUPABASE_URL` = `https://domumnsezocubigfqwry.supabase.co`
   - `SUPABASE_ANON_KEY` = la llave **publishable** (`sb_publishable_…`). El script **rechaza** las llaves `service_role` y `sb_secret_`.
4. *Deploy.* Cada `push` a `main` despliega a producción, y cada rama o PR genera una *Preview*.

> Si cambias de proyecto de Supabase, actualiza también el dominio en `connect-src` de la *Content-Security-Policy* en `vercel.json`.

### 6.3 Comprobar que el despliegue terminó bien
1. *Vercel → Deployments:* el último debe aparecer como **Ready** y asociado al commit correcto.
2. En *Build Logs* debe aparecer `[config] public/js/config.js generado para https://…`.
3. Abre estas URLs y confirma que responden `200` con el tipo correcto:
   - `https://TU-DOMINIO/apple-touch-icon.png` → `image/png`
   - `https://TU-DOMINIO/manifest.webmanifest` → `application/manifest+json`
   - `https://TU-DOMINIO/icons/icon-192.png`, `/icons/icon-512.png`, `/icons/icon-maskable-512.png`, `/favicon.ico`
4. En Chrome de escritorio: *DevTools → Application → Manifest*. No debe haber errores y deben verse los 3 íconos.
5. *DevTools → Console:* sin errores. Si aparece "Refused to connect", revisa la CSP.

### 6.4 Revertir a una versión estable
- **Inmediato:** *Vercel → Deployments →* elige el último despliegue estable → **⋯ → Promote to Production** (Instant Rollback). No requiere tocar el código.
- **Definitivo:** revierte el commit en GitHub (`git revert <sha>` y luego `push`). Vercel desplegará la versión corregida.
- **Base de datos:** las migraciones son aditivas. Para revertir objetos `_med` se necesita una migración nueva y explícita. **Nunca** ejecutes `drop` sobre objetos sin el sufijo `_med`.

---

## 7. Instalación en la pantalla de inicio

- **iPhone/iPad (Safari):** *Compartir → Agregar a pantalla de inicio*. Nombre: "Servicio médico". Ícono: `apple-touch-icon.png` (180×180).
- **Android (Chrome):** *menú ⋮ → Instalar aplicación*. Usa `manifest.webmanifest` (192, 512 y *maskable*).

**Si iOS sigue mostrando un ícono anterior:** borra el acceso directo, cierra Safari por completo, ve a *Ajustes → Safari → Avanzado → Datos de sitios web* y elimina el dominio, vuelve a abrir el sitio y agrégalo de nuevo. Si cambias el ícono en el futuro, sube el número en `?v=1` de los `<link>` de `index.html`.

**Nota sobre los íconos:** el ícono oficial que se recibió mide **180×180 px**. `apple-touch-icon.png` sale de él, aplanado sobre el naranja de su propio borde, porque iOS rellena de negro las esquinas transparentes. Las versiones de 192 y 512 px se generaron **ampliando** ese original, así que en Android pueden verse algo suaves. Para máxima nitidez, entrega el original en 1024×1024 y ejecuta:

```bash
powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1 -Src C:\ruta\icono-1024.png -Logo public\img\logo-petstable.webp -Out public
```

El sitio **no** incluye *service worker* ni modo sin conexión, porque no se solicitó. Necesita conexión para funcionar.

---

## 8. Pruebas locales

```bash
powershell -ExecutionPolicy Bypass -File tools\serve.ps1 -Port 5173
```
Abre `http://localhost:5173`. Usa la base de datos real, así que lo que registres queda guardado.

Para validar las reglas del servidor, ejecuta `tests/sql/pruebas_reglas_negocio.sql` en el *SQL Editor* de Supabase. Ese script revierte todos sus cambios al terminar y muestra los resultados como mensaje de error (eso es intencional).

---

## 9. Registro de pruebas (12/10/2026)

### Ejecutadas ✔
**Base de datos (sesiones simuladas de admin, usuario, cuenta sin acceso y anónimo; todo revertido):** 27 de 27 verificaciones correctas.
- Cita creada por un usuario queda forzada a `pendiente`; se rechazan sábado, 17:30, 09:15, fecha pasada y traslape del mismo bloque.
- Un usuario no puede confirmar, no puede reprogramar una cita confirmada, no ve medicamentos ni atenciones y no puede registrar entradas.
- Cancelar exige motivo y libera el bloque.
- Entradas: un lote existente suma existencia, se rechaza una caducidad distinta y se rechaza una caducidad vencida.
- La atención no procede en fecha futura; al faltar existencia se revierte **toda** la operación; la atención correcta descuenta el lote.
- Una cita solo pasa a "atendida" vía la RPC; salida sin motivo rechazada; el ajuste por conteo físico funciona.
- No se puede borrar un medicamento con lotes; un admin no puede desactivarse a sí mismo; correo fuera de `@petstable.mx` rechazado.
- La bitácora no contiene datos clínicos.
- Una cuenta Auth no autorizada no ve ni crea nada, y el rol anónimo no tiene acceso.
- Asesor de seguridad de Supabase: sin hallazgos para los objetos `_med`, salvo el aviso esperado de funciones `security definer` ejecutables por usuarios autenticados (validan rol internamente).

**Navegador (servidor local, panel integrado de Claude, motor Chromium):**
- Carga sin errores de consola; supabase-js, Lucide y Chart.js cargan desde el CDN.
- La llave *publishable* funciona con supabase-js 2.45.4; el rol anónimo recibe `permission denied` en tablas y RPC; Auth responde a credenciales inválidas.
- Pantalla de acceso a 375 px sin desbordamiento horizontal; tema claro y oscuro.
- Los 7 módulos se renderizan sin errores con respuestas **simuladas**. Gráficas (5 en el panel), tablas tipo tarjeta en móvil, modal tipo hoja inferior en móvil.
- Formulario de cita: validaciones, buscador de colaborador, bloqueo de fin de semana, horarios ocupados deshabilitados, confirmación de "descartar cambios".
- Atención: tope por existencia del lote, confirmación previa y payload correcto hacia `med_atender_cita`. Cancelación con motivo obligatorio. Entrada con lote existente.
- Recursos: `apple-touch-icon.png` (PNG 180×180), íconos 192/512/maskable (PNG), `favicon.ico`, manifiesto válido y metadatos en `<head>`. Comprobado por HTTP local, **no** por HTTPS.

### Pendientes ⏳ (requieren despliegue o credenciales reales)
- Inicio de sesión real con cada rol. No se ingresaron contraseñas reales.
- Flujo completo contra la base de datos desde la interfaz: crear, confirmar, atender y cancelar con datos reales.
- Restablecimiento de contraseña por correo (requiere configurar Redirect URLs).
- Accesibilidad de los recursos por **HTTPS** en Vercel y encabezados CSP en producción.
- **iPhone real con Safari** y "Agregar a pantalla de inicio" (no se ha probado en un dispositivo iOS).
- Android real (instalación y apariencia del ícono *maskable*).
- Tableta física y tablas con muchos registros reales.
