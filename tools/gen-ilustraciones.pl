# Genera public/emoji/*.svg a partir de fuentes/ilustraciones.src (ilustraciones propias del sistema)
# Uso (Git Bash): perl tools/gen-ilustraciones.pl fuentes/ilustraciones.src public/emoji
# Macros: %V(id,c1,c2) degradado vertical · %D(id,c1,c2) diagonal · %R(id,c1,c2) radial · %S sombra · %H brillo
use strict; use utf8;
my ($src, $out) = @ARGV;
open my $f, '<:encoding(UTF-8)', $src or die $!; local $/; my $t = <$f>; close $f;
my $SOMBRA = "<filter id='sh' x='-30%' y='-30%' width='160%' height='160%'><feDropShadow dx='0' dy='1.6' stdDeviation='1.5' flood-color='#0F172A' flood-opacity='.24'/></filter>";
my $n = 0;
for my $b (split /^@@/m, $t) {
  next unless $b =~ /\S/;
  my ($name, $body) = $b =~ /^(\w+)\s*\n(.*)$/s or next;
  $body =~ s/%V\((\w+),([#\w]+),([#\w]+)\)/<linearGradient id='$1' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='$2'\/><stop offset='1' stop-color='$3'\/><\/linearGradient>/g;
  $body =~ s/%D\((\w+),([#\w]+),([#\w]+)\)/<linearGradient id='$1' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='$2'\/><stop offset='1' stop-color='$3'\/><\/linearGradient>/g;
  $body =~ s/%R\((\w+),([#\w]+),([#\w]+)\)/<radialGradient id='$1' cx='.35' cy='.3' r='.75'><stop offset='0' stop-color='$2'\/><stop offset='1' stop-color='$3'\/><\/radialGradient>/g;
  $body =~ s/%S/filter='url(#sh)'/g;
  $body =~ s/%H/fill='#FFF' opacity='.55'/g;
  $body =~ s/\s*\n\s*//g;
  open my $o, '>:encoding(UTF-8)', "$out/$name.svg" or die $!;
  print $o "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs>$SOMBRA</defs>$body</svg>\n";
  close $o; $n++;
}
print "$n ilustraciones\n";
