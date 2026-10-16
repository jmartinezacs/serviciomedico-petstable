# Servidor estático mínimo para pruebas locales en Windows (sin Node ni Python).
# Uso: powershell -ExecutionPolicy Bypass -File tools\serve.ps1 [-Port 5173]
param([int]$Port = 5173, [string]$Root = (Join-Path $PSScriptRoot '..\public'))
$Root = (Resolve-Path $Root).Path
$types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8';
  '.png'='image/png'; '.ico'='image/x-icon'; '.webp'='image/webp'; '.svg'='image/svg+xml'; '.json'='application/json';
  '.webmanifest'='application/manifest+json; charset=utf-8' }
$l = New-Object Net.HttpListener
$l.Prefixes.Add("http://localhost:$Port/")
$l.Start()
Write-Host "Sirviendo $Root en http://localhost:$Port/"
while ($l.IsListening) {
  $ctx = $l.GetContext()
  try {
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($path -eq '/') { $path = '/index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $Root $path.TrimStart('/')))
    if (-not $file.StartsWith($Root) -or -not (Test-Path $file -PathType Leaf)) {
      $ctx.Response.StatusCode = 404; $b = [Text.Encoding]::UTF8.GetBytes('404')
    } else {
      $ext = [IO.Path]::GetExtension($file).ToLower()
      $ctx.Response.ContentType = $(if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' })
      $ctx.Response.Headers.Add('Cache-Control', 'no-store')
      $b = [IO.File]::ReadAllBytes($file)
    }
    $ctx.Response.OutputStream.Write($b, 0, $b.Length)
  } catch { } finally { $ctx.Response.Close() }
}
