#!/bin/bash
# Troca o dash-to-panel pelo gprdock. O dash-to-panel some na hora; o dock
# só aparece depois de sair e entrar na sessão (no Wayland o GNOME Shell não
# carrega extensão nova com a sessão aberta).
set -euo pipefail

UUID="gprdock@gpr"
OLD="dash-to-panel@jderose9.github.com"

if [ ! -e "$HOME/.local/share/gnome-shell/extensions/$UUID/metadata.json" ]; then
    echo "Extensão não instalada. Rode ./install.sh antes." >&2
    exit 1
fi

current="$(gsettings get org.gnome.shell enabled-extensions)"
case "$current" in
    *"'$UUID'"*) ;;
    "@as []") gsettings set org.gnome.shell enabled-extensions "['$UUID']" ;;
    *) gsettings set org.gnome.shell enabled-extensions "${current%]}, '$UUID']" ;;
esac

gnome-extensions disable "$OLD" 2>/dev/null || true

# Nome antigo da extensão (primodock@gpr): sai da lista, se ainda estiver lá.
current="$(gsettings get org.gnome.shell enabled-extensions)"
cleaned="$(printf '%s' "$current" | sed -e "s/, 'primodock@gpr'//" -e "s/'primodock@gpr', //")"
[ "$cleaned" = "$current" ] || gsettings set org.gnome.shell enabled-extensions "$cleaned"
# Com o dash-to-panel desligado o Ubuntu Dock voltaria a aparecer.
gnome-extensions disable "ubuntu-dock@ubuntu.com" 2>/dev/null || true

echo "Pronto. Salve o que estiver aberto e saia e entre na sessão para o dock aparecer."
echo "Para voltar ao que era: ./uninstall.sh"
