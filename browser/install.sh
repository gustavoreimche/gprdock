#!/bin/bash
# Registra nos navegadores o programa com que a extensão "gprdock: links no
# perfil em uso" fala com o dock. A extensão em si é carregada à mão: veja o
# fim deste script (ou o README).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="io.github.gustavoreimche.gprdock"
ID="$(cat "$HERE/extension-id")"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"

found=0
for browser in google-chrome chromium BraveSoftware/Brave-Browser microsoft-edge vivaldi; do
    [ -d "$CONFIG/$browser" ] || continue
    mkdir -p "$CONFIG/$browser/NativeMessagingHosts"
    cat > "$CONFIG/$browser/NativeMessagingHosts/$NAME.json" <<JSON
{
  "name": "$NAME",
  "description": "gprdock: links no perfil em uso",
  "path": "$HERE/gprdock-links-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
JSON
    echo "Registrado em $CONFIG/$browser"
    found=1
done
[ "$found" = 1 ] || { echo "Nenhum navegador da família do Chrome encontrado em $CONFIG." >&2; exit 1; }

cat <<TEXT

Falta carregar a extensão, em cada usuário do navegador que tiver apps web:
  1. abra chrome://extensions
  2. ligue o "Modo do desenvolvedor"
  3. "Carregar sem compactação" e escolha a pasta:
     $HERE/extension
TEXT
