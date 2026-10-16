# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"Servicio Médico · Salud laboral – Pet's Table S.A. de C.V." is a web app for requesting and tracking medical appointments (citas) for employees (colaboradores) and for managing the medication inventory.

- **Language:** the UI is in Spanish. The user communicates in Spanish; reply in Spanish.
- **Time zone:** the business time zone is `America/Mexico_City`.
- **Brand colors:** `#F58020`, `#1BC7C7` and navy/near-black.
- **Frontend:** vanilla JS ES modules, with no npm and no framework. Libraries load from jsdelivr at pinned versions: supabase-js 2.45.4, lucide 0.453.0 and chart.js 4.4.4.
- **Backend:** Supabase project `domumnsezocubigfqwry`, which provides Postgres, Auth, RLS, Storage, Edge Functions, pg_cron and pg_net. It is managed through the Supabase MCP tools.
- **Repo and hosting:** the private GitHub repo is `https://github.com/jmartinezacs/serviciomedico-petstable.git`. The local clone is this folder.

## Repository layout and publishing

- **Published site.** The repo root holds the 5 files Vercel publishes: `index.html`, `sw.js`, `manifest.webmanifest`, `apple-touch-icon.png` and `version.json`. The app polls `version.json` and offers "Actualizar" when it differs from `APP_VERSION`.
  - `index.html` is **generated**, so never edit it by hand.
  - `vercel.json` (no build, output `.`, headers) and `.vercelignore` keep everything else out of the deployment.
- **Sources.** Sources live in `public/`, `supabase/`, `tests/`, `tools/` and `fuentes/`. `fuentes/` holds the original icon.
- **Obsolete leftovers.** `entrega/`, `scripts/` and `package.json` are left over from v1.0. They are git-ignored, so don't revive them.
- **Release flow:**
  1. Edit `public/`.
  2. Bump `APP_VERSION` in `public/js/config.js`.
  3. Run the build.
  4. Commit and push to `main`. Vercel deploys automatically.
- **Pushing:** pushing to the repo is authorized by the user.
  - Git for Windows is installed. In a fresh shell, refresh `PATH` first: `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`.
  - Authentication goes through Git Credential Manager, where the user signs in. Never type credentials.

## Commands (Windows PowerShell 5.1, run from the repo root)

Build the single-file `index.html` at the repo root. This also copies `sw.js`, the manifest and the icon:

```bash
powershell -ExecutionPolicy Bypass -File tools\build-single.ps1
```

Build the test version, which exposes all modules on `window.__medModules`. Write it elsewhere so it is never committed:

```bash
powershell -ExecutionPolicy Bypass -File tools\build-single.ps1 -Prueba -Out $env:TEMP\med-prueba
```

Start a local static server:

```bash
powershell -ExecutionPolicy Bypass -File tools\serve.ps1 -Port 5173
```

- The server defaults to `public/`. Pass `-Root <folder>` to serve a built file.
- It talks to the **real** database.

**SQL rule tests** live in `tests/sql/pruebas_reglas_negocio.sql`.
- Each test is a `DO` block. It simulates a JWT with `set_config('request.jwt.claims', …)` and `set local role authenticated`, then ends with `RAISE EXCEPTION` carrying the results.
- Raising the exception rolls everything back, so the "error" output *is* the test report.
- To run one, send its block through `execute_sql`.

## Architecture

### Frontend (`public/`)

`js/core.js` holds the shared infrastructure:
- the `sb` Supabase client and the global `state`
- date and slot helpers; `SLOTS` holds 20-min blocks from 09:00 to 17:00
- the UI helpers `toast`, `openModal`, `confirmDialog`, `checkForm` and the `DataTable` renderer
- the chart helpers `makeChart` and `restyleCharts`
- photo upload helpers
- unit helpers for the double-unit inventory (a minimum unit plus a package with `contenido_empaque`)
- the custom dropdowns `mejorarSelect` and `mejorarDatalist`, applied automatically through a MutationObserver
- `avisar()`, which triggers notifications, and the `push` subscription helper

Other frontend files:
- `js/app.js` handles the session and auth gating, the hash router (`#/ruta?query`), the header with clock, theme toggle and menu, and the FABs.
- Each route renders one module from `js/modules/`: dashboard, citas, colaboradores, inventario, reportes, usuarios, bitacora or perfil.
- **No circular imports.** The bundler evaluates modules in `$order`, so a module cannot import one that comes later. To call across, publish the function on `ganchos` in `core.js` (e.g. `citas.js` sets `ganchos.openDetalle`, which `colaboradores.js` calls).
- `core.js` also holds `getBloqueos`/`bloqueoDe` (days or slots without service) and the export helpers `fetchAll`, `toCSV` (Excel-safe CSV) and `descargar`.
- `css/app.css` is a base stylesheet followed by per-version blocks (`/* v1.1 */` … ). Later blocks override earlier ones.
  - Color tokens are defined on `:root` and `[data-theme=dark]`.
  - The login is always dark because its tokens are scoped under `.login`.
- `sw.js` and `manifest.webmanifest` must stay separate files, because Web Push and iOS require it.

### Single-file build (`tools/build-single.ps1`)

- **Modules:** it regex-converts `import`/`export` into an IIFE module map `__m`.
  - Module order is hard-coded in `$order`, so **add new modules there**.
  - Only the `import {a} from './x.js'` and `import X from` forms are supported.
- **Inlining:** it inlines the CSS, the config and the theme-init script. The logo, favicon and login icon are embedded as data URIs.
- **CSP:** it writes a CSP `<meta>` with sha256 hashes of the inline scripts. Add any new external origin to the CSP in the script.
- **Encoding:** keep the `.ps1` files as **UTF-8 with BOM**. Without the BOM, PowerShell 5.1 corrupts accented strings. The Edit tool can drop the BOM, so re-add it after editing.

### Database (`supabase/migrations/`, all already applied)

- **Shared instance.** Other apps live in the same database: EPP, `brom_*`, `*_pruind` and `*_calbas`.
  - Every object of this project uses the `_med` suffix or the `med_` prefix. Never alter objects without one of them.
  - New migrations go in a new timestamped file and are applied with `apply_migration`.
- **Access.**
  - Auth is shared with the other apps. Access to *this* app comes from `usuarios_med`, matched by the JWT email.
  - Roles are `admin` and `usuario`.
  - RLS uses the security-definer helpers `med_es_admin()`, `med_es_miembro()` and `med_usuario_actual_id()`.
  - Logout uses `signOut({scope:'local'})` so the other apps' sessions survive.
- **Business rules are enforced in the DB, not the UI.**
  - Triggers: `med_validar_cita` checks weekdays, slots, overlaps and non-admin restrictions. `med_validar_usuario` keeps at least one active admin. `med_auditar` writes to `bitacora_med` and never copies clinical text.
  - Multi-step operations are transactional RPCs:
    - `med_atender_cita` closes the cita, saves the atención and its padecimiento, and dispenses from lotes.
    - `med_registrar_entrada`/`_salida` and `med_ajustar_lote` handle manual stock moves.
  - `lotes_med` has no direct writes, and `movimientos_med` is insert-only.
- **Citas.**
  - `tipo` is `normal` or `urgente`.
  - Normal citas use 20-min slots on weekdays. A partial unique index on `(fecha, hora)` prevents double booking.
  - `dias_sin_servicio_med` holds holidays and doctor absences, either a full day or an hour range. LFT holidays for 2026–2027 are preloaded. Blocks reject normal citas, through `med_motivo_bloqueo` in the trigger, but still allow urgent ones.
  - The pg_cron job `med_inasistencias` (19:05 MX, Mon–Fri) marks past confirmed citas as `no_asistio`. An admin can reopen a `no_asistio` cita back to `confirmada`.
  - An urgent cita has `hora` null until an admin assigns a time or rejects it.
  - States go pendiente → confirmada → atendida, plus cancelada and no asistió. Citas are cancelled, never deleted.
- **Views:** `v_citas_med`, `v_stock_med`, `v_lotes_med` and `v_movimientos_med` use `security_invoker`.
- **Secrets:** the VAPID keys and the cron secret live in the `med_private` schema. Only service_role can read them, through RPCs.

### Edge Functions (`supabase/functions/`, deployed via MCP)

- **`gestionar_usuarios_med`** is admin-only and creates Auth accounts. It is the only code that uses the service role for that.
- **`notificar_med`** sends Web Push (`npm:web-push`) and optional Resend email for cita events.
  - It is called from the frontend through `avisar(evento, citaId)`.
  - It re-checks that the event really happened before sending.
  - Resend needs the secrets `RESEND_API_KEY`, `MED_EMAIL_FROM` and `MED_SITE_URL`.
- **`recordatorios_med`** runs the scheduled reminders.
  - It has `verify_jwt` set to false and is protected by the `x-med-cron` header, which must match `med_private.cron`.
  - It is called by the pg_cron job `med_recordatorio_pendientes` every 20 minutes.
  - It acts only Monday to Friday, 07:00 to 19:00 MX time.
  - On the top-of-hour run, it reminds admins with `recibe_avisos` about pending citas. At 09:00 it also sends a low-stock and expired-lots reminder.
  - It reminds each cita's requester at 18:00 on the previous business day, and again about 1 hour before. These reminders are recorded in `avisos_med` (`recordatorio_dia`/`recordatorio_hora`) so they never repeat.

## Testing the UI without real credentials

Do not enter real passwords. Instead:
1. Serve a `-Prueba` build.
2. Mock `sb.from` and `sb.rpc`, and fake a session with `sb.auth._notifyAllSubscribers('SIGNED_IN', session)`.
3. For getter properties such as `sb.storage` and `sb.functions`, use `Object.defineProperty`.

`requestAnimationFrame` stalls when the browser pane is hidden, so use `setTimeout` in test scripts.

## Constraints from the user

- **Secrets:** never put the service_role key, secrets or tokens in frontend code or in the repo. The public config holds only the URL and the `sb_publishable_…` key.
- **Business rules:** don't invent them. Ask the user, or document an assumption as adjustable in the README.
- **Reporting:** separate the tests you executed from the ones still pending. Never claim something was tested on a real iPhone or device unless it was.
