#!/bin/bash
# Instala a extensão (symlink + schema). Não muda nada na sessão em uso:
# para trocar de fato o dash-to-panel pelo dock, rode ./ativar.sh.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="gprdock@gpr"
TARGET="$HOME/.local/share/gnome-shell/extensions/$UUID"

glib-compile-schemas --strict "$REPO/schemas"

mkdir -p "$(dirname "$TARGET")"
if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
    echo "Já existe algo em $TARGET que não é um symlink; não vou sobrescrever." >&2
    exit 1
fi
ln -sfn "$REPO" "$TARGET"

echo "Instalado em $TARGET"
echo "Próximo passo: ./ativar.sh e depois sair e entrar na sessão."
