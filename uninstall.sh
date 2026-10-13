#!/bin/bash
# Desliga o gprdock e religa o dash-to-panel, que volta como estava (as
# configurações dele nunca são alteradas). Com --remove, apaga também o symlink.
set -euo pipefail

UUID="gprdock@gpr"
OLD="dash-to-panel@jderose9.github.com"
TARGET="$HOME/.local/share/gnome-shell/extensions/$UUID"

if ! gnome-extensions disable "$UUID" 2>/dev/null; then
    # A sessão ainda não conhece a extensão: tira direto da lista.
    current="$(gsettings get org.gnome.shell enabled-extensions)"
    updated="$(printf '%s' "$current" | sed -e "s/, '$UUID'//" -e "s/'$UUID', //" -e "s/'$UUID'//")"
    gsettings set org.gnome.shell enabled-extensions "$updated"
fi

# Volta ao estado original: Ubuntu Dock habilitado, mas suprimido pelo dash-to-panel.
gnome-extensions enable "ubuntu-dock@ubuntu.com" 2>/dev/null || true
gnome-extensions enable "$OLD"

if [ "${1:-}" = "--remove" ] && [ -L "$TARGET" ]; then
    rm "$TARGET"
    echo "Symlink removido."
fi

echo "gprdock desligado; dash-to-panel religado."
