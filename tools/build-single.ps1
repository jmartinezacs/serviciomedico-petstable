# Genera la versión de UN SOLO ARCHIVO (index.html en la raíz) + apple-touch-icon.png, sw.js y manifiesto
# a partir del código fuente en public/. Incrusta CSS, JavaScript (módulos), configuración
# y logotipo; calcula los hashes de la Content-Security-Policy de los scripts en línea.
# Uso: powershell -ExecutionPolicy Bypass -File tools\build-single.ps1
#     -Prueba : (solo pruebas) expone los módulos en window.__medModules. No usar para publicar.
#     Por omisión escribe en la raíz del repositorio (lo que publica Vercel).
param([string]$Src = (Join-Path $PSScriptRoot '..\public'), [string]$Out = (Join-Path $PSScriptRoot '..'), [switch]$Prueba)
$ErrorActionPreference = 'Stop'
$Src = (Resolve-Path $Src).Path
New-Item -ItemType Directory -Force $Out | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
function Read-Text($rel) { ([IO.File]::ReadAllText((Join-Path $Src $rel), [Text.Encoding]::UTF8)).Replace("`r`n", "`n") }

# ---------- 1. Empaquetar módulos ES en un script clásico ----------
$order = @('core', 'modules/colaboradores', 'modules/inventario', 'modules/citas', 'modules/dashboard',
           'modules/usuarios', 'modules/bitacora', 'modules/perfil', 'modules/reportes', 'app')
function Resolve-Key([string]$from, [string]$spec) {
  $s = $spec -replace '\.js$', ''
  if ($s.StartsWith('../')) { return $s.Substring(3) }
  $s = $s.Substring(2)
  if ($from.StartsWith('modules/')) { return "modules/$s" }
  return $s
}
$bundle = New-Object Text.StringBuilder
[void]$bundle.Append("(function () {`n'use strict';`nconst __m = {};`n")
foreach ($key in $order) {
  $code = Read-Text("js/$key.js")
  $names = New-Object Collections.Generic.List[string]
  # import { a, b } from '...';
  $code = [regex]::Replace($code, "import\s*\{([^}]*)\}\s*from\s*'([^']+)';", [Text.RegularExpressions.MatchEvaluator]{
    param($m) "const {$($m.Groups[1].Value)} = __m['$(Resolve-Key $key $m.Groups[2].Value)'];" })
  # import X from '...';
  $code = [regex]::Replace($code, "import\s+(\w+)\s+from\s*'([^']+)';", [Text.RegularExpressions.MatchEvaluator]{
    param($m) "const $($m.Groups[1].Value) = __m['$(Resolve-Key $key $m.Groups[2].Value)'].default;" })
  if ($code -match '(^|\n)\s*import\s') { throw "Import no convertido en $key" }
  foreach ($m in [regex]::Matches($code, 'export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)')) { $names.Add($m.Groups[1].Value) }
  $code = [regex]::Replace($code, 'export\s+((?:async\s+)?(?:function|class|const|let)\s)', '$1')
  $code = $code.Replace('export default ', '__exp.default = ')
  if ($code -match '(^|\n)\s*export\s') { throw "Export no convertido en $key" }
  $assign = if ($names.Count) { "Object.assign(__exp, { $($names -join ', ') });" } else { '' }
  [void]$bundle.Append("`n// ===== $key.js =====`n__m['$key'] = (function () {`nconst __exp = {};`n$code`n$assign`nreturn __exp;`n})();`n")
}
if ($Prueba) { [void]$bundle.Append("window.__medModules = __m;`n") }
[void]$bundle.Append("})();")
$bundleJs = $bundle.ToString()
if ($bundleJs -match '</script') { throw 'El código contiene </script>' }

# ---------- 2. Recursos incrustados ----------
$css = Read-Text('css/app.css')
$logo = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $Src 'img/logo-petstable.webp')))
$css = $css.Replace("url('/img/logo-petstable.webp')", "url('data:image/webp;base64,$logo')")
if ($css.Contains('/img/')) { throw 'Quedó una referencia a /img/ en el CSS' }
$themeJs = (Read-Text('js/theme-init.js')).Trim()
$configJs = (Read-Text('js/config.js')).Trim()

function Sha([string]$t) { 'sha256-' + [Convert]::ToBase64String([Security.Cryptography.SHA256]::Create().ComputeHash($utf8.GetBytes($t))) }
$supa = 'https://domumnsezocubigfqwry.supabase.co'
$csp = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net '$(Sha $themeJs)' '$(Sha $configJs)' '$(Sha $bundleJs)'; " +
       "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
       "img-src 'self' data: blob: $supa; connect-src 'self' $supa wss://domumnsezocubigfqwry.supabase.co; " +
       "manifest-src 'self'; worker-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'"
$icon128 = 'data:image/png;base64,' + [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $Src 'img/app-icon-128.png')))
$fav64 = 'data:image/png;base64,' + [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $Src 'img/favicon-64.png')))

# ---------- 3. Ensamblar HTML ----------
$html = Read-Text('index.html')
function Swap([string]$find, [string]$repl) {
  if (-not $script:html.Contains($find)) { throw "No se encontró en index.html: $find" }
  $script:html = $script:html.Replace($find, $repl)
}
# Favicon e ícono del login incrustados (no dependen de archivos externos)
Swap '  <link rel="icon" href="/favicon.ico?v=1" sizes="any">' "  <meta http-equiv=`"Content-Security-Policy`" content=`"$csp`">`n  <link rel=`"icon`" type=`"image/png`" sizes=`"64x64`" href=`"$fav64`">"
Swap "  <link rel=`"icon`" type=`"image/png`" sizes=`"32x32`" href=`"/icons/favicon-32.png?v=1`">`n" ''
Swap '<img class="app-icon" src="/img/app-icon-128.png"' "<img class=`"app-icon`" src=`"$icon128`""
# El manifiesto se publica como archivo aparte (necesario para notificaciones en iPhone)
Swap '<link rel="manifest" href="/manifest.webmanifest?v=1">' '<link rel="manifest" href="/manifest.webmanifest">'
Swap '  <link rel="stylesheet" href="/css/app.css?v=1.0.0">' "  <style>`n$css</style>"
Swap '  <script src="/js/theme-init.js"></script>' "  <script>$themeJs</script>"
Swap '  <script src="/js/config.js?v=1.0.0"></script>' "  <script>$configJs</script>"
Swap '  <script type="module" src="/js/app.js?v=1.0.0"></script>' "  <script>$bundleJs</script>"
foreach ($ref in @('/css/', '/js/', '/img/', '/icons/', 'favicon.ico')) {
  if ($html.Contains($ref)) { throw "Quedó una referencia externa a $ref" }
}
$html = "<!-- Servicio Médico · Pet's Table — archivo generado por tools/build-single.ps1. Edita las fuentes en public/ y vuelve a generar. -->`n" + $html
[IO.File]::WriteAllText((Join-Path $Out 'index.html'), $html, $utf8)
Copy-Item (Join-Path $Src 'apple-touch-icon.png') (Join-Path $Out 'apple-touch-icon.png') -Force
# Archivos que no pueden ir dentro del HTML: service worker (avisos push) y manifiesto
Copy-Item (Join-Path $Src 'sw.js') (Join-Path $Out 'sw.js') -Force
Copy-Item (Join-Path $Src 'manifest.webmanifest') (Join-Path $Out 'manifest.webmanifest') -Force
# Íconos de las notificaciones push (insignia monocromática para la barra de estado de Android)
Copy-Item (Join-Path $Src 'img/notif-badge.png') (Join-Path $Out 'notif-badge.png') -Force
Copy-Item (Join-Path $Src 'img/notif-icon.png') (Join-Path $Out 'notif-icon.png') -Force
# Versión publicada: la app la consulta para ofrecer "Actualizar" cuando cambia
if ($configJs -notmatch 'APP_VERSION:\s*["'']([^"'']+)["'']') { throw 'No se encontró APP_VERSION en config.js' }
[IO.File]::WriteAllText((Join-Path $Out 'version.json'), "{`"version`":`"$($Matches[1])`"}`n", $utf8)
Get-Item (@('index.html', 'apple-touch-icon.png', 'sw.js', 'manifest.webmanifest', 'version.json', 'notif-badge.png', 'notif-icon.png') | ForEach-Object { Join-Path $Out $_ }) | ForEach-Object { '{0,-24} {1,10:N0} bytes' -f $_.Name, $_.Length }
