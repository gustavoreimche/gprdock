import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Apps web instalados pelo navegador (WhatsApp, Teams...): o id do atalho é
// "<navegador>-<id do app>-<perfil>.desktop". Só têm uma janela; pedir outra
// faz o navegador mostrar a que já existe, onde ela estiver.
export const WEB_APP_ID = /^(chrome|chromium|brave|msedge|vivaldi)-([a-z]{32})-(.+)\.desktop$/;
// Cópias com sessão isolada, criadas aqui.
const COPY_PREFIX = 'gprdock-web-';
const DATA_DIRS = {
    'chrome': 'google-chrome',
    'chromium': 'chromium',
    'brave': 'BraveSoftware/Brave-Browser',
    'msedge': 'microsoft-edge',
    'vivaldi': 'vivaldi',
};

export const isWebApp = id => WEB_APP_ID.test(id);
export const isIsolatedCopy = id => id.startsWith(COPY_PREFIX);
// Uma janela só, nos dois casos.
export const isSingleWindowWebApp = id => isWebApp(id) || isIsolatedCopy(id);

const applicationsDir = () =>
    GLib.build_filenamev([GLib.get_user_data_dir(), 'applications']);
const copyDataDir = id => GLib.build_filenamev(
    [GLib.get_user_data_dir(), 'gprdock', 'web', id.replace(/\.desktop$/, '')]);

// Endereço em que o app web abre. O atalho só traz o id do app; o endereço
// está nos dados de sincronização do navegador, logo depois do id, como um
// texto precedido do tamanho dele.
function startUrl(browser, appId, profile) {
    const dir = GLib.build_filenamev([GLib.get_user_config_dir(), DATA_DIRS[browser] ?? '',
        profile, 'Sync Data', 'LevelDB']);
    const needle = new TextEncoder().encode(appId);
    let names = [];
    try {
        const handle = GLib.Dir.open(dir, 0);
        for (let name = handle.read_name(); name !== null; name = handle.read_name())
            names.push(name);
        handle.close();
    } catch {
        return null;
    }

    // Os arquivos mais novos primeiro: são os que têm o endereço atual.
    names = names.filter(name => /\.(ldb|log)$/.test(name)).sort().reverse();
    for (const name of names) {
        let bytes = null;
        try {
            [, bytes] = GLib.file_get_contents(GLib.build_filenamev([dir, name]));
        } catch {
            continue;
        }
        for (let at = indexOf(bytes, needle, 0); at >= 0; at = indexOf(bytes, needle, at + 1)) {
            const end = Math.min(bytes.length, at + needle.length + 64);
            for (let p = at + needle.length; p + 8 < end; p++) {
                // "http" precedido do tamanho do texto
                if (bytes[p] !== 0x68 || bytes[p + 1] !== 0x74 || bytes[p + 2] !== 0x74 || bytes[p + 3] !== 0x70)
                    continue;
                const length = bytes[p - 1];
                const url = new TextDecoder().decode(bytes.slice(p, p + length));
                if (/^https?:\/\/[^\s"'<>\\]+$/.test(url))
                    return url;
            }
        }
    }
    return null;
}

function indexOf(bytes, needle, from) {
    outer: for (let i = from; i <= bytes.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (bytes[i + j] !== needle[j])
                continue outer;
        }
        return i;
    }
    return -1;
}

// Nome que o navegador dá à janela de um endereço aberto como app: o host e
// o caminho, com o que não pode estar num nome de arquivo trocado por '_', e
// no fim a pasta do perfil. É por esse nome que o GNOME liga a janela ao
// atalho, e a pasta do perfil (única por cópia) é o que distingue duas
// cópias do mesmo endereço.
function windowClass(url, profile) {
    const [, host, path] = url.match(/^https?:\/\/([^/?#]+)([^?#]*)/) ?? [];
    return `chrome-${host}_${(path ?? '').replace(/[^A-Za-z0-9._-]/g, '_')}-${profile}`;
}

// A cópia a que pertence uma janela com esta classe, pelo fim do nome.
export function copyOfWindowClass(wmClass) {
    const key = wmClass?.match(new RegExp(`(?:^|-)(${COPY_PREFIX}[a-z0-9-]+)$`))?.[1];
    return key ? `${key}.desktop` : null;
}

// Acerta no atalho a classe que a janela da cópia realmente tem (outro
// navegador, ou o X11, podem dar um nome diferente do previsto). Vale a
// partir da próxima vez que ela abrir.
export function learnWindowClass(id, wmClass) {
    const path = GLib.build_filenamev([applicationsDir(), id]);
    const file = new GLib.KeyFile();
    try {
        file.load_from_file(path, GLib.KeyFileFlags.KEEP_TRANSLATIONS);
        if (file.get_string('Desktop Entry', 'StartupWMClass') === wmClass)
            return;
        file.set_string('Desktop Entry', 'StartupWMClass', wmClass);
        file.save_to_file(path);
    } catch {
        // O atalho foi apagado: nada a acertar.
    }
}

// Cria um segundo atalho do mesmo app web com uma sessão só dele: outro
// diretório de dados do navegador, logo outro login, outros cookies, outra
// janela. Devolve o id do atalho novo; lança Error com o motivo se não der.
export function createIsolatedCopy(app, label) {
    const [, browser, appId, profile] = app.get_id().match(WEB_APP_ID) ?? [];
    const info = app.get_app_info();
    const binary = info?.get_commandline()?.split(' ')[0];
    if (!browser || !binary)
        throw new Error('este não é um app web instalado pelo navegador');
    const url = startUrl(browser, appId, profile);
    if (!url)
        throw new Error('não achei o endereço do app nos dados do navegador');

    const key = `${COPY_PREFIX}${appId.slice(0, 8)}-${GLib.uuid_string_random().slice(0, 6)}`;
    const id = `${key}.desktop`;
    const data = copyDataDir(id);
    GLib.mkdir_with_parents(data, 0o700);
    GLib.mkdir_with_parents(applicationsDir(), 0o755);

    const file = new GLib.KeyFile();
    const group = 'Desktop Entry';
    file.set_string(group, 'Type', 'Application');
    file.set_string(group, 'Name', `${app.get_name()} (${label})`);
    file.set_string(group, 'Exec', `${binary} --user-data-dir=${GLib.shell_quote(data)} ` +
        `--profile-directory=${key} --class=${key} --no-first-run --no-default-browser-check ` +
        `--app=${GLib.shell_quote(url)}`);
    file.set_string(group, 'Icon', info.get_string('Icon') ?? 'web-browser');
    file.set_string(group, 'StartupWMClass', windowClass(url, key));
    file.set_boolean(group, 'Terminal', false);
    file.set_string(group, 'X-GprDock-Source', app.get_id());
    file.save_to_file(GLib.build_filenamev([applicationsDir(), id]));
    return id;
}

// Apaga o atalho da cópia e manda a sessão dela para a lixeira.
export function removeIsolatedCopy(id) {
    if (!isIsolatedCopy(id))
        return;
    try {
        Gio.File.new_for_path(GLib.build_filenamev([applicationsDir(), id])).delete(null);
    } catch {
        // Já não existia.
    }
    try {
        Gio.File.new_for_path(copyDataDir(id)).trash(null);
    } catch {
        // Nunca foi aberta, ou a lixeira não aceita: fica onde está.
    }
}
