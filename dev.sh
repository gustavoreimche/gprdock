#!/bin/bash
# Modo dev: abre um GNOME Shell separado, numa janela, com o gprdock
# carregado a partir desta pasta. Nada toca a sessão em uso: as configurações
# ficam em .dev/ (apague a pasta para começar do zero).
#
# Depois de mudar o código, feche a janela e rode de novo: o GNOME Shell só
# lê os arquivos da extensão ao iniciar.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="gprdock@gpr"
DEV="$REPO/.dev"

if ! gnome-shell --help | grep -q -- '--devkit' || [ -z "$(command -v mutter-devkit || ls /usr/libexec/mutter-devkit 2>/dev/null)" ]; then
    echo "Falta o visualizador do modo dev. Instale com:" >&2
    echo "    sudo apt install mutter-dev-bin" >&2
    exit 1
fi

glib-compile-schemas --strict "$REPO/schemas"
mkdir -p "$DEV/config" "$DEV/data/gnome-shell/extensions"
ln -sfn "$REPO" "$DEV/data/gnome-shell/extensions/$UUID"

# Lido antes de trocar o XDG_CONFIG_HOME, senão viriam os padrões do Ubuntu.
export GPRDOCK_FAVORITES="$(gsettings get org.gnome.shell favorite-apps 2>/dev/null || echo '@as []')"
export XDG_CONFIG_HOME="$DEV/config"
export XDG_DATA_HOME="$DEV/data"
export XDG_DATA_DIRS="$HOME/.local/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
export GPRDOCK_UUID="$UUID"

export GPRDOCK_KEYRING="$DEV/keyring"
mkdir -p "$GPRDOCK_KEYRING"

exec dbus-run-session -- bash -c '
    # Chaveiro próprio do modo dev (em .dev/): o chaveiro real fica no D-Bus
    # da sessão em uso e não é alcançável daqui. Sem isto, guardar um token
    # nas configurações falha por tempo esgotado.
    printf "gprdock-dev" | gnome-keyring-daemon --unlock --daemonize \
        --components=secrets --control-directory="$GPRDOCK_KEYRING" >/dev/null 2>&1 || true

    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell enabled-extensions "[\"$GPRDOCK_UUID\"]"
    # Só na primeira vez: começa com os mesmos apps fixados da sessão real.
    if [ ! -e "$XDG_CONFIG_HOME/.seeded" ]; then
        gsettings set org.gnome.shell favorite-apps "$GPRDOCK_FAVORITES"
        touch "$XDG_CONFIG_HOME/.seeded"
    fi
    gsettings set org.gnome.desktop.interface color-scheme prefer-dark
    # Sem --virtual-monitor: ele criaria um segundo monitor, o painel e o
    # dock iriam para lá e a janela mostraria só o papel de parede.
    exec gnome-shell --devkit
'
