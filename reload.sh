#!/bin/bash
# Recarrega o código do dock sem sair da sessão: compila o schema, grava uma
# versão nova (é ela que faz o GNOME Shell ler os arquivos de novo) e religa
# a extensão. O dock some por um instante e volta com o código desta pasta.
#
# Não vale para mudanças no extension.js: essas ainda pedem sair da sessão.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="gprdock@gpr"
export GSETTINGS_SCHEMA_DIR="$REPO/schemas"

# Estado da extensão segundo o GNOME Shell: 1 = ativa, 2 = inativa.
state() {
    gdbus call --session --dest org.gnome.Shell.Extensions \
        --object-path /org/gnome/Shell/Extensions \
        --method org.gnome.Shell.Extensions.GetExtensionInfo "$UUID" \
        | grep -o "'state': <[0-9]*" | grep -o '[0-9]*$'
}

# Espera a extensão chegar ao estado pedido (até 15 s).
wait_for() {
    for _ in $(seq 1 30); do
        [ "$(state)" = "$1" ] && return 0
        sleep 0.5
    done
    return 1
}

glib-compile-schemas --strict "$REPO/schemas"
gsettings set org.gnome.shell.extensions.gprdock code-version "$(date +%s)"

# O GNOME desliga e religa em segundo plano (e, junto, as extensões que vêm
# depois desta na lista). Mandar ligar antes de o desligar terminar faz o
# pedido ser ignorado e o dock ficar fora, então cada passo espera o anterior.
gnome-extensions disable "$UUID"
wait_for 2 || { echo "A extensão não desligou; estado: $(state)" >&2; exit 1; }
sleep 0.5
gnome-extensions enable "$UUID"

if wait_for 1; then
    echo "Recarregado."
else
    echo "O dock não voltou (estado: $(state)). Veja o erro com:" >&2
    echo "    journalctl --user -b -g gprdock | tail -20" >&2
    echo "e, para religar à mão: gnome-extensions disable $UUID; sleep 3; gnome-extensions enable $UUID" >&2
    exit 1
fi
