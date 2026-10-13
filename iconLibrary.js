import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Ícones trocados pelo usuário e a biblioteca de onde eles saem. Usado pelo
// dock e pela tela de configurações, por isso só depende de Gio e GLib.
//
// 'app-icons' guarda {id do app: ícone}; o ícone é o caminho de um arquivo
// de imagem (os da biblioteca) ou o nome de um ícone do tema do sistema.

const IMAGE_SUFFIX = /\.(png|svg|jpe?g|webp|ico|bmp|gif)$/i;

// Pasta da biblioteca: as imagens que o usuário importou.
export const libraryDir = () =>
    GLib.build_filenamev([GLib.get_user_data_dir(), 'gprdock', 'icons']);

export const isIconFile = icon => icon.startsWith('/');

export function readAppIcons(settings) {
    try {
        const map = JSON.parse(settings.get_string('app-icons'));
        return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    } catch {
        return {};
    }
}

// Troca o ícone de um app; sem ícone, volta ao original.
export function setAppIcon(settings, appId, icon) {
    const map = readAppIcons(settings);
    if (icon)
        map[appId] = icon;
    else
        delete map[appId];
    settings.set_string('app-icons', JSON.stringify(map));
}

// O ícone escolhido para o app, ou null se vale o original (nada escolhido,
// ou o arquivo escolhido não existe mais).
export function customGicon(settings, appId) {
    const icon = readAppIcons(settings)[appId];
    if (typeof icon !== 'string' || icon === '')
        return null;
    if (!isIconFile(icon))
        return new Gio.ThemedIcon({name: icon});
    return GLib.file_test(icon, GLib.FileTest.IS_REGULAR)
        ? new Gio.FileIcon({file: Gio.File.new_for_path(icon)}) : null;
}

// Caminhos das imagens da biblioteca, em ordem alfabética.
export function listLibrary() {
    const dir = libraryDir();
    const paths = [];
    try {
        const handle = GLib.Dir.open(dir, 0);
        for (let name = handle.read_name(); name !== null; name = handle.read_name()) {
            if (IMAGE_SUFFIX.test(name))
                paths.push(GLib.build_filenamev([dir, name]));
        }
        handle.close();
    } catch {
        // A pasta ainda não existe: biblioteca vazia.
    }
    return paths.sort((a, b) => a.localeCompare(b));
}

// Copia uma imagem para a biblioteca e devolve o caminho da cópia. Com o
// nome já em uso, a cópia ganha um número. Lança Error se não der.
export function importToLibrary(path) {
    const dir = libraryDir();
    if (GLib.path_get_dirname(path) === dir)
        return path;
    const name = GLib.path_get_basename(path);
    if (!IMAGE_SUFFIX.test(name))
        throw new Error(`${name} não é uma imagem (PNG, SVG, JPG, WebP ou ICO)`);
    const target = freePath(name);
    Gio.File.new_for_path(path).copy(
        Gio.File.new_for_path(target), Gio.FileCopyFlags.NONE, null, null);
    return target;
}

// Caminho livre na biblioteca para um arquivo com este nome: com o nome já
// em uso, ganha um número.
function freePath(name) {
    const dir = libraryDir();
    GLib.mkdir_with_parents(dir, 0o755);
    const [, stem, suffix] = name.match(/^(.*)(\.[^.]+)$/);
    let target = GLib.build_filenamev([dir, name]);
    for (let n = 2; GLib.file_test(target, GLib.FileTest.EXISTS); n++)
        target = GLib.build_filenamev([dir, `${stem}-${n}${suffix}`]);
    return target;
}

// Grava na biblioteca uma imagem que veio da internet (os bytes dela) e
// devolve o caminho. Lança Error se não der.
export function saveToLibrary(name, bytes) {
    const target = freePath(name.replace(/[^A-Za-z0-9._-]/g, '-'));
    GLib.file_set_contents(target, bytes);
    return target;
}

// Tira uma imagem da biblioteca; os apps que a usavam voltam ao original.
export function removeFromLibrary(settings, path) {
    if (GLib.path_get_dirname(path) !== libraryDir())
        return;
    try {
        Gio.File.new_for_path(path).delete(null);
    } catch {
        // Já não existia.
    }
    const map = readAppIcons(settings);
    const kept = Object.fromEntries(Object.entries(map).filter(([, icon]) => icon !== path));
    if (Object.keys(kept).length !== Object.keys(map).length)
        settings.set_string('app-icons', JSON.stringify(kept));
}
