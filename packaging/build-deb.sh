#!/bin/bash
# Monta o pacote .deb do gprdock.
#
#   packaging/build-deb.sh [VERSÃO] [PASTA_DE_SAÍDA]
#
# Sem versão, usa a de packaging/VERSION. O pacote instala a extensão para
# todos os usuários; cada um ainda precisa ativá-la.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-$(cat "$REPO/packaging/VERSION")}"
OUT="$(realpath -m "${2:-$REPO/dist}")"
UUID="gprdock@gpr"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
EXT="$STAGE/usr/share/gnome-shell/extensions/$UUID"

mkdir -p "$EXT/schemas" "$EXT/docs" "$STAGE/DEBIAN" "$STAGE/usr/share/doc/gprdock"
cp "$REPO"/metadata.json "$REPO"/stylesheet.css "$REPO"/*.js "$EXT/"
cp -r "$REPO/widgets" "$REPO/icons" "$REPO/previews" "$EXT/"
# O guia é aberto pelas preferências.
cp "$REPO/docs/widgets-personalizados.md" "$EXT/docs/"
cp "$REPO"/schemas/*.gschema.xml "$EXT/schemas/"
glib-compile-schemas --strict "$EXT/schemas"

cat > "$STAGE/usr/share/doc/gprdock/copyright" <<COPYRIGHT
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: gprdock
Source: https://github.com/gustavoreimche/gprdock

Files: *
Copyright: 2026 Gustavo Peters Reimche
License: GPL-3+
 On Debian systems, the full text of the GNU General Public License version 3
 can be found in /usr/share/common-licenses/GPL-3.
COPYRIGHT

find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +

cat > "$STAGE/DEBIAN/control" <<CONTROL
Package: gprdock
Version: $VERSION
Architecture: all
Maintainer: Gustavo Peters Reimche <gustavoprdev@gmail.com>
Installed-Size: $(du -sk "$STAGE/usr" | cut -f1)
Depends: gnome-shell (>= 50~), gir1.2-gtk-4.0, gir1.2-adw-1, gir1.2-soup-3.0, tar
Suggests: gprengine
Section: gnome
Priority: optional
Homepage: https://github.com/gustavoreimche/gprdock
Description: Dock flutuante com widgets vivos para o GNOME Shell
 Barra flutuante com apps fixados, perfis e widgets: música, calendário, clima,
 bateria, Git, Docker, pomodoro e outros. Dá para criar e compartilhar widgets
 próprios.
 .
 Depois de instalar, saia e entre na sessão e ative a extensão "gprdock".
CONTROL

mkdir -p "$OUT"
dpkg-deb --root-owner-group --build "$STAGE" "$OUT/gprdock_${VERSION}_all.deb" >/dev/null
echo "$OUT/gprdock_${VERSION}_all.deb"
