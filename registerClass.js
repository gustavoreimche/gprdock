import GObject from 'gi://GObject';

// Toda classe gráfica do dock é registrada por aqui, e não direto por
// GObject.registerClass. O GNOME identifica essas classes por um nome global
// que não pode se repetir; como o ./reload.sh carrega o código de novo na
// mesma sessão (ver extension.js), cada carga precisa de nomes próprios. O
// sufixo vem do endereço de onde este arquivo foi importado, que traz a
// versão da carga.
const version = import.meta.url.match(/\/v-([0-9A-Za-z_-]+)\//)?.[1] ?? '';
const suffix = version ? `_${version.replace(/-/g, '_')}` : '';

export function registerClass(...args) {
    const klass = args.at(-1);
    const metadata = args.length > 1 ? args[0] : {};
    return GObject.registerClass(
        {GTypeName: `GprDock_${klass.name}${suffix}`, ...metadata}, klass);
}
