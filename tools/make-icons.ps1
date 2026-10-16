# Genera los recursos de ícono y logotipo a partir de los archivos oficiales.
# Uso (Windows PowerShell 5.1):
#   powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1 -Src ruta\icono.png -Logo ruta\logo.webp -Out public
param([Parameter(Mandatory)][string]$Src, [Parameter(Mandatory)][string]$Logo, [Parameter(Mandatory)][string]$Out)
Add-Type -AssemblyName PresentationCore, WindowsBase, System.Drawing

function Load-Frame($path) {
  $s = [IO.File]::OpenRead($path)
  $dec = [Windows.Media.Imaging.BitmapDecoder]::Create($s, [Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat, [Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
  $f = $dec.Frames[0]; $s.Close(); return $f
}
function Save-Png($bmpSrc, $path) {
  $enc = New-Object Windows.Media.Imaging.PngBitmapEncoder
  $enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bmpSrc))
  $fs = [IO.File]::Create($path); $enc.Save($fs); $fs.Close()
}
# Redimensiona con bicúbica de alta calidad. $pad = margen relativo; $bg = color de fondo opcional.
function Resize-Png($inPng, $size, $outPng, [double]$pad = 0, $bg = $null) {
  $img = [Drawing.Image]::FromFile($inPng)
  $bmp = New-Object Drawing.Bitmap $size, $size, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
  if ($bg) { $g.Clear([Drawing.ColorTranslator]::FromHtml($bg)) } else { $g.Clear([Drawing.Color]::Transparent) }
  $inner = [int][Math]::Round($size * (1 - 2 * $pad)); $off = [int][Math]::Round(($size - $inner) / 2)
  $attr = New-Object Drawing.Imaging.ImageAttributes
  $attr.SetWrapMode([Drawing.Drawing2D.WrapMode]::TileFlipXY)
  $g.DrawImage($img, (New-Object Drawing.Rectangle $off, $off, $inner, $inner), 0, 0, $img.Width, $img.Height, [Drawing.GraphicsUnit]::Pixel, $attr)
  $g.Dispose(); $img.Dispose()
  $bmp.Save($outPng, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}

New-Item -ItemType Directory -Force "$Out\icons", "$Out\img" | Out-Null
$tmp = Join-Path $env:TEMP "med-icon-src.png"
Save-Png (Load-Frame $Src) $tmp

# iOS rellena la transparencia con negro: se aplana sobre el naranja del borde del ícono (sin modificar el arte)
Resize-Png $tmp 180 "$Out\apple-touch-icon.png" 0 '#F47414'
Resize-Png $tmp 192 "$Out\icons\icon-192.png"
Resize-Png $tmp 512 "$Out\icons\icon-512.png"
# Maskable: arte dentro de la zona segura (80 %) sobre naranja corporativo para que Android no lo recorte
Resize-Png $tmp 512 "$Out\icons\icon-maskable-512.png" 0.1 '#F58020'
Resize-Png $tmp 32 "$Out\icons\favicon-32.png"
Resize-Png $tmp 16 "$Out\icons\favicon-16.png"
Resize-Png $tmp 48 "$Out\icons\favicon-48.png"

# favicon.ico con PNG incrustados (16, 32, 48)
$sizes = 16, 32, 48
$pngs = $sizes | ForEach-Object { , [IO.File]::ReadAllBytes("$Out\icons\favicon-$_.png") }
$ms = New-Object IO.MemoryStream; $bw = New-Object IO.BinaryWriter $ms
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
for ($i = 0; $i -lt $pngs.Count; $i++) {
  $bw.Write([byte]$sizes[$i]); $bw.Write([byte]$sizes[$i]); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32); $bw.Write([UInt32]$pngs[$i].Length); $bw.Write([UInt32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Flush(); [IO.File]::WriteAllBytes("$Out\favicon.ico", $ms.ToArray()); $bw.Close()
Remove-Item "$Out\icons\favicon-16.png", "$Out\icons\favicon-48.png"

# Logotipo: copia íntegra del original (WebP con transparencia; WIC pierde el canal alfa al convertir)
Copy-Item $Logo "$Out\img\logo-petstable.webp" -Force
Remove-Item $tmp
Get-ChildItem $Out -Recurse -File | Select-Object FullName, Length
