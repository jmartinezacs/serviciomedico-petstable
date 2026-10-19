# Servicio Médico · Pet's Table S.A. de C.V.

**Salud laboral** — sistema web para solicitar y controlar citas médicas y mantener actualizado el inventario de medicamentos.

- **Frontend:** HTML + CSS + JavaScript (módulos ES) empaquetados en un solo `index.html`. Librerías por CDN con versión fija: supabase-js 2.45.4, Lucide 0.453.0, Chart.js 4.4.4.
- **Backend:** Supabase (PostgreSQL, Auth, RLS, Storage, Edge Functions, pg_cron, pg_net).
- **Repositorio:** GitHub (privado) → **Vercel** despliega automáticamente cada `push` a `main`.
- **Zona horaria de operación:** `America/Mexico_City`.

---

## 1. Estructura y publicación

```
(raíz del repositorio = lo que publica Vercel)
├── index.html              ← GENERADO por tools/build-single.ps1 (no editar a mano)
├── sw.js                   ← service worker: notificaciones push
├── manifest.webmanifest    ← app instalable (iPhone lo exige para push)
├── apple-touch-icon.png    ← ícono 512×512
├── version.json            ← versión publicada (aviso "Hay una nueva versión")
├── vercel.json             ← sin compilación; encabezados de seguridad y caché
├── .vercelignore           ← deja fuera de la publicación todo lo siguiente:
├── public/                 ← FUENTES del sitio (index.html, css/, js/, img/)
├── supabase/migrations/    ← migraciones SQL (todas aplicadas)
├── supabase/functions/     ← Edge Functions (desplegadas)
├── tests/sql/              ← pruebas de reglas de negocio
├── tools/                  ← build-single.ps1, serve.ps1, make-icons.ps1
└── fuentes/                ← ícono original en alta resolución
```

**Para publicar un cambio:**
1. Editar las fuentes en `public/` y subir `APP_VERSION` en `public/js/config.js`.
2. Generar el sitio:
   ```bash
   powershell -ExecutionPolicy Bypass -File tools\build-single.ps1
   ```
3. `git commit` y `git push` a `main`. Vercel publica en 1–2 minutos y quienes tengan la app abierta verán el aviso **"Hay una nueva versión disponible · Actualizar"**.

**Revertir:** *Vercel → Deployments →* último despliegue estable *→ ⋯ → Promote to Production*, o `git revert <commit>` y `push`. Las migraciones son aditivas; para revertir objetos `_med` se requiere una migración nueva y explícita.

**Pruebas locales:** `powershell -ExecutionPolicy Bypass -File tools\serve.ps1 -Port 5173` sirve `public/` en `http://localhost:5173` (usa la base de datos real). Las reglas del servidor se prueban ejecutando los bloques de `tests/sql/pruebas_reglas_negocio.sql` en el *SQL Editor*; cada bloque revierte sus cambios y muestra los resultados como mensaje de error (intencional).

---

## 2. Roles y permisos

| Acción | Administrador | Usuario |
|---|:-:|:-:|
| Panel con KPI y gráficas | ✔ (todo) | ✔ (solo sus citas) |
| Solicitar cita (normal o de urgencia) | Para cualquier colaborador | Para sí mismo o colaboradores de su misma área |
| Ver citas, agenda del día y agenda semanal | Todas | Las que solicitó (los demás horarios aparecen "Ocupado") |
| Modificar / cancelar cita pendiente propia | ✔ | ✔ |
| Confirmar, reprogramar, asignar horario de urgencia, marcar o reabrir inasistencia | ✔ | — |
| Registrar atención y dispensar medicamentos | ✔ | — |
| Constancia de atención (imprimible, sin datos clínicos) | ✔ | De sus citas atendidas |
| Días sin servicio (festivos, ausencias) | ✔ | Solo los ve |
| Historial de atención por colaborador | ✔ | — |
| Colaboradores: consultar y registrar | ✔ | ✔ |
| Colaboradores: editar, desactivar, eliminar · áreas | ✔ | — |
| Inventario, reabasto, reportes, respaldo, usuarios, configuración y bitácora | ✔ | — |

**Usuarios iniciales:** javier.martinez, kevin.hernandez, nelisa.ramirez, julian.pacheco y servicio.medico (Administrador); abigail.ordaz (Usuario). Dominio `@petstable.mx`.

Todas las reglas se aplican **en la base de datos** (RLS, triggers y funciones). Ocultar botones en la interfaz es solo una ayuda visual.

---

## 3. Reglas de negocio

**Proporcionadas por el usuario**
1. Los usuarios solicitan citas para colaboradores de un catálogo; los colaboradores no necesitan cuenta.
2. Horario de lunes a viernes de 9:00 a 17:30, en bloques de **20 minutos** (el último inicia a las 17:00). Un bloque admite una sola cita activa.
3. **Cita de urgencia / extraordinaria:** sin bloques y cualquier día; el motivo es obligatorio. Servicio Médico asigna un horario especial al confirmarla o la rechaza.
4. Los medicamentos se descuentan al registrar la atención; además hay entradas, salidas y ajustes manuales.
5. Datos clínicos mínimos: motivo, padecimiento, sintomatología y nota breve. Solo los consultan los administradores.
6. Recordatorios al médico solo de lunes a viernes; aviso de bajo stock al médico.
7. Todos los usuarios del sistema son también colaboradores de su área. Un usuario solicita citas para sí mismo o para colaboradores de su misma área; los administradores, para todos.
8. Al registrar un colaborador o usuario, un administrador puede crear el área desde el mismo formulario.

**Carga inicial (archivo del médico, 18/10/2026):** 71 colaboradores por área y 45 renglones de fármacos (44 medicamentos, 48 lotes). Criterios usados: caducidad con solo mes/año → último día del mes; sin número de lote → lote `S/N-AAAA-MM-DD`; tubos, botes, frascos y aerosoles se cuentan por pieza; contenido por empaque 1 y stock mínimo 0 hasta que el médico los defina. 

**Insumos y equipo (v1.8):** el inventario maneja tres categorías:
- **Medicamento:** caducidad obligatoria.
- **Insumo médico:** lote y caducidad opcionales. Se pueden entregar en consulta.
- **Equipo y mobiliario:** sin alertas. No se entrega en consulta, pero sí admite salidas por baja.

Los productos que no se cuentan por pieza (geles, cremas, frascos gotero, aerosoles, botes sin conteo, rollos, bolsas) se controlan **por envase**. La existencia es el número de envases y se registra cuánto queda del envase abierto (lleno, ¾, ½ o ¼). Ese registro de uso no descuenta nada; al marcar "Se terminó" se descuenta 1 envase.

**v1.9:**
- El inventario se lleva siempre en una sola unidad: tableta, cápsula, pieza, etc. Los artículos por envase se cuentan en envases.
- La clave se genera sola por categoría (`MED-045`, `INS-034`, `EQ-028`) y no cambia al editar.
- Al dar de alta un artículo se puede registrar su existencia inicial.
- **v1.10:** en Lotes y caducidades, el médico puede editar a mano el número de lote y la caducidad con `med_editar_lote`. La existencia no cambia y el cambio queda en la bitácora.

Las entradas y salidas se capturan por unidad o por empaque. Al capturar por empaque se indica cuántas unidades trae cada uno (por ejemplo, 3 cajas de 10 = 30 tabletas) y ese contenido se recuerda para la próxima vez.

El stock mínimo de medicamentos e insumos es una propuesta inicial, ajustable en Inventario → Editar.

**Supuestos documentados (ajustables)**

| Supuesto | Valor | Dónde cambiarlo |
|---|---|---|
| Ventana de alerta de caducidad | 60 días | Usuarios → Configuración |
| Stock mínimo | Por medicamento (0 = sin alerta) | Inventario → Editar |
| Días festivos | Días de descanso obligatorio de la LFT (art. 74) 2026–2027 precargados; los demás los registra el médico | Citas → Días sin servicio |
| Un día u horario sin servicio bloquea citas **normales**; las urgencias se permiten | Sí | Trigger `med_validar_cita` |
| Citas ya agendadas cuando se registra un bloqueo | No se cancelan solas; se muestran para reprogramarlas | — |
| Inasistencia automática | 19:05 de L-V: citas confirmadas cuyo horario ya pasó y no se atendieron | `cron` `med_inasistencias` |
| Una inasistencia puede reabrirse (admin) para registrar la atención | Sí | Trigger `med_validar_cita` |
| Recordatorio pendientes al médico | Cada hora en punto, L-V 07:00–19:00 | `recordatorios_med` |
| Aviso de inventario al médico | 09:00 L-V (bajo mínimo, agotados, lotes caducados con existencia) | `recordatorios_med` |
| Recordatorio a quien solicitó la cita | 18:00 del día hábil anterior y ~1 hora antes | `recordatorios_med` |
| Consumo para reabasto | Piezas entregadas en consultas, últimos 90 días | `med_reabasto` |
| Cobertura objetivo del pedido sugerido | 60 días (nunca menos que el stock mínimo) | Usuarios → Configuración |
| Un usuario agenda solo horarios futuros; un admin puede registrar citas del día en un bloque ya transcurrido | Sí | Trigger `med_validar_cita` |
| Solo se atienden citas de hoy o de fechas pasadas | Sí | `med_atender_cita` |
| Lotes caducados no se dispensan; sí pueden darse de baja. Se propone primero el lote que caduca antes | Sí | RPC / interfaz |
| Las citas no se eliminan; se cancelan | Sí | Sin política DELETE |
| Colaboradores, medicamentos y áreas con historial no se eliminan; se desactivan | Sí | Llaves foráneas `RESTRICT` |
| Siempre hay al menos un administrador activo; nadie cambia su propio rol ni estado | Sí | Trigger `med_validar_usuario` |
| La bitácora no replica el contenido clínico | Sí | `med_auditar` |

---

## 4. Modelo de datos (sufijo `_med`)

| Tabla | Propósito |
|---|---|
| `areas_med` | Catálogo de áreas |
| `usuarios_med` | Usuarios autorizados, rol, foto y "Recibe avisos" |
| `colaboradores_med` | Pacientes |
| `citas_med` | Citas (`tipo` normal/urgente; índice único parcial `(fecha, hora)` para citas normales activas) |
| `atenciones_med` | Atención 1:1 con la cita (padecimiento, sintomatología, nota) |
| `padecimientos_med` | Catálogo de padecimientos |
| `dias_sin_servicio_med` | Festivos y ausencias (día completo o rango de horas) |
| `medicamentos_med` · `lotes_med` · `movimientos_med` | Inventario en doble unidad (pieza y empaque) y kardex |
| `push_subs_med` · `avisos_med` | Suscripciones push y registro de avisos enviados (evita duplicados) |
| `bitacora_med` | Auditoría automática |
| `config_med` | Configuración (alerta de caducidad, cobertura, aviso de privacidad) |

**Vistas** (`security_invoker`): `v_citas_med`, `v_stock_med`, `v_lotes_med`, `v_movimientos_med`.

**RPC principales:** `med_mi_perfil`, `med_horarios_ocupados`, `med_atender_cita`, `med_registrar_entrada`, `med_registrar_salida`, `med_ajustar_lote`, `med_dashboard`, `med_estadisticas_padecimientos`, `med_constancia`, `med_reabasto`, `med_aviso_privacidad` (la única accesible sin sesión: solo devuelve el enlace del aviso).

**Aislamiento:** la instancia `domumnsezocubigfqwry` la comparten otras aplicaciones (EPP, `brom_*`, `*_pruind`, `*_calbas`). Este proyecto no modifica objetos ajenos; todos los suyos llevan el sufijo `_med` o el prefijo `med_`.

---

## 5. Avisos y tareas programadas

- **Push:** cada persona los activa en *Mi perfil* o desde el aviso del Panel. En iPhone primero debe instalar la app ("Agregar a pantalla de inicio") y abrirla desde ese ícono.
- **`notificar_med`** (al momento): nuevas solicitudes y cancelaciones/reprogramaciones de usuarios → administradores con "Recibe avisos"; confirmación, rechazo, cancelación o reprogramación → quien solicitó la cita. Correo opcional con Resend (secretos `RESEND_API_KEY`, `MED_EMAIL_FROM`, `MED_SITE_URL` en *Edge Functions → Secrets*).
- **`recordatorios_med`** (pg_cron `med_recordatorio_pendientes`, cada 20 min; solo actúa L-V 07:00–19:00): pendientes al médico cada hora en punto, inventario a las 09:00, recordatorio de cita a quien la solicitó (18:00 del día hábil anterior y ~1 h antes). Protegida con el secreto `med_private.cron`.
- **`med_inasistencias`** (pg_cron, 19:05 L-V): marca inasistencias automáticas.
- Para pausar un trabajo: `select cron.unschedule('<nombre>');`.

---

## 6. Autenticación

- Se usa la cuenta de **Supabase Auth compartida** (misma contraseña de las demás apps de Pet's Table). El acceso a esta app lo define `usuarios_med`, vinculado por correo.
- Al cerrar sesión se usa `scope: 'local'` para no cerrar las sesiones de las otras apps.
- **Alta de usuarios** (Usuarios → Nuevo usuario): si el correo ya tiene cuenta, no se modifica; si no, la Edge Function `gestionar_usuarios_med` la crea con contraseña temporal. Fotos nuevas en el bucket `avatares_med`; las del bucket `avatares` solo se enlazan.

### Pendiente en el panel de Supabase (lo hace un administrador del proyecto)
1. **Authentication → URL Configuration → Redirect URLs:** agregar `https://TU-DOMINIO.vercel.app/**` (para "¿Olvidaste tu contraseña?").
2. **Authentication → Attack Protection → "Prevent use of leaked passwords":** activarla. Solo está disponible en el plan Pro de Supabase; en el plan gratuito la opción aparece bloqueada.

---

## 7. Instalación en la pantalla de inicio

- **iPhone/iPad (Safari):** *Compartir → Agregar a pantalla de inicio*.
- **Android (Chrome):** *menú ⋮ → Instalar aplicación*.
- Si iOS muestra un ícono anterior: borrar el acceso directo, eliminar los datos del sitio en *Ajustes → Safari → Avanzado → Datos de sitios web* y volver a agregarlo.

---

## 8. Registro de pruebas

**Ejecutadas (base de datos, sesiones simuladas, todo revertido):** reglas de citas, inventario, permisos y bitácora (27 verificaciones, v1.0); urgencias y bloques de 20 min (v1.4); v1.6 — horario bloqueado y festivo rechazados para citas normales y permitidos para urgencias, usuario sin permiso para crear bloqueos ni ver reabasto, reapertura de inasistencia, constancia solo para el solicitante o admin, URL de aviso sin https rechazada, inasistencia automática.

**Ejecutadas (navegador con datos simulados):** agenda semanal (escritorio y 375 px), días sin servicio (alta de varios días, lista), horarios bloqueados en el formulario, disponibilidad del Panel saltando festivos, reabasto y su exportación, reportes CSV y respaldo JSON, historial por colaborador, constancia (contenido de impresión), aviso de nueva versión y enlace de privacidad en el login.

**Ejecutadas (Edge Function):** `recordatorios_med` v3 responde 200 con el secreto correcto.

**Pendientes (requieren uso real):** inicio de sesión real con cada rol; recepción de push en un dispositivo (incluidos los recordatorios de 18:00, 1 h antes y 09:00); impresión real de la constancia; descarga de archivos en iPhone; iPhone/Android físicos.
