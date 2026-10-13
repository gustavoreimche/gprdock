import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Widgets personalizados: cada pasta de ~/.config/gprdock/widgets/ com um
// manifest.json é um widget, que entra nos perfis como 'custom@<id>'. O guia
// para quem escreve um está em docs/widgets-personalizados.md.
//
// Este arquivo é usado pelo dock e pelas preferências; por isso só depende de
// GLib e Gio.

export const FORMAT = 1;
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const ARCHIVE_SUFFIX = '.gprwidget';
const MAX_FILES = 200;
const MAX_UNPACKED = 20 * 1024 * 1024;

export function customDir() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'gprdock', 'widgets']);
}

export const customName = id => `custom@${id}`;

function readText(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    return ok ? new TextDecoder().decode(bytes) : '';
}

// Lê e confere o manifest de uma pasta. Sempre devolve um objeto; com
// `error` preenchido o widget aparece, mas não roda.
export function loadManifest(dir) {
    const folder = GLib.path_get_basename(dir);
    const info = {
        id: folder, name: folder, description: '', author: '', icon: '',
        size: 'square', kind: null, dir, manifest: {}, wmClasses: [], error: '',
    };
    let manifest = null;
    try {
        manifest = JSON.parse(readText(GLib.build_filenamev([dir, 'manifest.json'])));
    } catch (e) {
        info.error = `manifest.json inválido: ${e.message}`;
        return info;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        info.error = 'manifest.json precisa ser um objeto';
        return info;
    }
    info.manifest = manifest;
    if (typeof manifest.name === 'string' && manifest.name.trim())
        info.name = manifest.name.trim();
    for (const key of ['description', 'author', 'icon']) {
        if (typeof manifest[key] === 'string')
            info[key] = manifest[key];
    }
    if (['square', 'wide'].includes(manifest.size))
        info.size = manifest.size;
    if (Array.isArray(manifest.wmClasses))
        info.wmClasses = manifest.wmClasses.filter(c => typeof c === 'string');

    if (manifest.format !== FORMAT)
        info.error = `"format" precisa ser ${FORMAT}`;
    else if (!ID_RE.test(folder))
        info.error = 'o nome da pasta só pode ter letras minúsculas, números, - e _';
    else if (manifest.id !== folder)
        info.error = `"id" precisa ser igual ao nome da pasta (${folder})`;
    else if (typeof manifest.module === 'string')
        info.kind = 'module';
    else if (manifest.command !== undefined || typeof manifest.script === 'string')
        info.kind = 'command';
    else
        info.error = 'faltou "script", "command" ou "module"';

    if (!info.error && info.kind === 'module' && !inside(dir, manifest.module))
        info.error = '"module" precisa ser um arquivo dentro da pasta do widget';
    if (!info.error && typeof manifest.script === 'string' && !inside(dir, manifest.script))
        info.error = '"script" precisa ser um arquivo dentro da pasta do widget';
    return info;
}

function inside(dir, relative) {
    if (!relative || relative.startsWith('/') || relative.split('/').includes('..'))
        return false;
    return GLib.file_test(GLib.build_filenamev([dir, relative]), GLib.FileTest.IS_REGULAR);
}

// Todos os widgets personalizados instalados, por nome.
export function listCustom() {
    const root = customDir();
    const found = [];
    let dir = null;
    try {
        dir = GLib.Dir.open(root, 0);
    } catch {
        return found;
    }
    for (let entry = dir.read_name(); entry !== null; entry = dir.read_name()) {
        const path = GLib.build_filenamev([root, entry]);
        if (entry.startsWith('.') || !GLib.file_test(path, GLib.FileTest.IS_DIR))
            continue;
        if (GLib.file_test(GLib.build_filenamev([path, 'manifest.json']), GLib.FileTest.EXISTS))
            found.push(loadManifest(path));
    }
    dir.close();
    return found.sort((a, b) => a.name.localeCompare(b.name));
}

export function customInfo(id) {
    if (!id || !ID_RE.test(id))
        return null;
    const dir = GLib.build_filenamev([customDir(), id]);
    if (!GLib.file_test(GLib.build_filenamev([dir, 'manifest.json']), GLib.FileTest.EXISTS))
        return null;
    return loadManifest(dir);
}

// ---------- Criar, compartilhar, instalar ----------

function run(argv) {
    const process = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [, stdout, stderr] = process.communicate_utf8(null, null);
    if (!process.get_successful())
        throw new Error(stderr.trim().split('\n').at(-1) || `${argv[0]} falhou`);
    return stdout;
}

function removeTree(path) {
    const file = Gio.File.new_for_path(path);
    const type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    if (type === Gio.FileType.DIRECTORY) {
        const children = file.enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        for (let child = children.next_file(null); child; child = children.next_file(null))
            removeTree(GLib.build_filenamev([path, child.get_name()]));
        children.close(null);
    }
    if (type !== Gio.FileType.UNKNOWN)
        file.delete(null);
}

// Identificador a partir de um nome livre: "Cotação do dólar" -> "cotacao-do-dolar".
export function slug(name) {
    return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

const TEMPLATE_SCRIPT = `#!/bin/bash
# O dock roda este arquivo a cada "interval" segundos (ver manifest.json) e
# mostra o que ele escreve:
#
#   1ª linha  o valor em destaque
#   2ª linha  a legenda (aparece na forma retângulo)
#   demais    linhas do painel que abre ao clicar
#
# Para mais controle (ícone, anel de progresso, alerta, links), escreva um
# JSON em vez de linhas. O guia completo: docs/widgets-personalizados.md

echo "$(date +%H:%M)"
echo "@NAME@"
echo "Edite widget.sh nesta pasta: o dock recarrega ao salvar."
echo "Usuário: $USER"
`;

// Cria a pasta de um widget novo, já funcionando, e devolve o caminho dela.
export function createTemplate(name) {
    const id = slug(name);
    if (!ID_RE.test(id))
        throw new Error('Dê um nome com letras ou números');
    const dir = GLib.build_filenamev([customDir(), id]);
    if (GLib.file_test(dir, GLib.FileTest.EXISTS))
        throw new Error(`Já existe um widget "${id}"`);
    GLib.mkdir_with_parents(dir, 0o755);
    const manifest = {
        format: FORMAT, id, name, description: 'Meu widget',
        icon: 'starred-symbolic', size: 'wide', script: 'widget.sh', interval: 30,
    };
    GLib.file_set_contents(GLib.build_filenamev([dir, 'manifest.json']),
        `${JSON.stringify(manifest, null, 2)}\n`);
    const script = GLib.build_filenamev([dir, 'widget.sh']);
    GLib.file_set_contents(script, TEMPLATE_SCRIPT.replace('@NAME@', name.replace(/["$`\\]/g, '')));
    GLib.chmod(script, 0o755);
    return dir;
}

// Empacota a pasta do widget num arquivo para mandar a outra pessoa.
export function exportWidget(id, target) {
    const info = customInfo(id);
    if (!info)
        throw new Error('Widget não encontrado');
    run(['tar', '-czf', target, '--owner=0', '--group=0', '-C', customDir(), id]);
}

// Abre um pacote sem instalar: confere o conteúdo e devolve o que ele traz,
// para a pessoa decidir. Só arquivos e pastas comuns, todos dentro de <id>/.
export function inspectArchive(path) {
    const listing = run(['tar', '-tvzf', path]).split('\n').filter(Boolean);
    if (listing.length === 0 || listing.length > MAX_FILES)
        throw new Error('O pacote está vazio ou tem arquivos demais');
    const files = [];
    let id = null;
    let total = 0;
    for (const line of listing) {
        // tipo+permissões dono/grupo tamanho data hora nome
        const match = line.match(/^(\S)\S*\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/);
        if (!match)
            throw new Error('Não foi possível ler o conteúdo do pacote');
        const [, type, size, name] = match;
        const parts = name.replace(/\/$/, '').split('/');
        if (name.startsWith('/') || parts.includes('..') || !['-', 'd'].includes(type))
            throw new Error(`O pacote traz um item inesperado: ${name}`);
        id ??= parts[0];
        if (parts[0] !== id)
            throw new Error('O pacote precisa ter uma única pasta');
        total += Number(size);
        if (type === '-')
            files.push(parts.slice(1).join('/'));
    }
    if (!ID_RE.test(id ?? ''))
        throw new Error('O nome da pasta do pacote é inválido');
    if (total > MAX_UNPACKED)
        throw new Error('O pacote é grande demais');
    if (!files.includes('manifest.json'))
        throw new Error('O pacote não tem manifest.json');

    let manifest = null;
    try {
        manifest = JSON.parse(run(['tar', '-xzOf', path, `${id}/manifest.json`]));
    } catch {
        throw new Error('O manifest.json do pacote é inválido');
    }
    if (!manifest || manifest.id !== id || manifest.format !== FORMAT)
        throw new Error('O manifest.json do pacote não confere com a pasta');
    return {
        id,
        name: typeof manifest.name === 'string' ? manifest.name : id,
        author: typeof manifest.author === 'string' ? manifest.author : '',
        description: typeof manifest.description === 'string' ? manifest.description : '',
        files,
        replaces: customInfo(id) !== null,
    };
}

// Instala um pacote já conferido por inspectArchive; substitui o que houver
// com o mesmo id. Devolve o id.
export function installArchive(path) {
    const {id} = inspectArchive(path);
    const root = customDir();
    GLib.mkdir_with_parents(root, 0o755);
    const staging = GLib.build_filenamev([root, `.instalando-${GLib.uuid_string_random().slice(0, 8)}`]);
    GLib.mkdir_with_parents(staging, 0o700);
    try {
        run(['tar', '-xzf', path, '--no-same-owner', '--no-same-permissions', '-C', staging]);
        const unpacked = GLib.build_filenamev([staging, id]);
        const info = loadManifest(unpacked);
        if (info.error)
            throw new Error(`O pacote não é um widget válido: ${info.error}`);
        const target = GLib.build_filenamev([root, id]);
        removeTree(target);
        GLib.rename(unpacked, target);
    } finally {
        removeTree(staging);
    }
    return id;
}

export function removeWidget(id) {
    if (!ID_RE.test(id))
        throw new Error('Id inválido');
    removeTree(GLib.build_filenamev([customDir(), id]));
}
