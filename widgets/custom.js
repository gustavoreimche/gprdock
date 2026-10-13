import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    Widget, httpGet, httpRequest, isCancelled, readFile, runCommand,
} from './base.js';
import {registerClass} from '../registerClass.js';
import {customDir, customInfo, listCustom} from '../custom.js';

const MIN_INTERVAL = 1;
const DEFAULT_INTERVAL = 60;
const RELOAD_DELAY = 400;       // ms depois de salvar um arquivo do widget
const STATES = {warn: 'gprdock-state-warn', alert: 'gprdock-state-alert'};
// O que um módulo pode trocar no widget; o resto que ele definir é dele.
const HOOKS = ['setup', 'build', 'refresh', 'onClick', 'onSecondaryClick',
    'onMiddleClick', 'onDestroy', 'title'];

// O widget (nome) personalizado que representa este app, se houver: os que
// declaram "wmClasses" no manifest tomam o lugar do ícone do app aberto.
export function customWidgetFor(app) {
    const owners = listCustom().filter(info => !info.error && info.wmClasses.length > 0);
    if (owners.length === 0)
        return null;
    const classes = app.get_windows().flatMap(window =>
        [window.get_wm_class(), window.get_wm_class_instance()])
        .filter(Boolean).map(name => name.toLowerCase());
    const owner = owners.find(info =>
        info.wmClasses.some(wanted => classes.includes(wanted.toLowerCase())));
    return owner ? `custom@${owner.id}` : null;
}

// Um clique configurado no manifest ou devolvido pelo script:
//   "panel" | {"open": "<endereço>"} | {"run": ["comando", ...]} | {"app": "x.desktop"}
function isAction(action) {
    return action === 'panel' ||
        (action && typeof action === 'object' &&
            (typeof action.open === 'string' || Array.isArray(action.run) ||
                typeof action.app === 'string'));
}

// Hospeda um widget de ~/.config/gprdock/widgets/<id>/. Há dois tipos:
//
//   comando  roda um script a cada tantos segundos e mostra a saída dele;
//   módulo   importa um arquivo .js cujas funções passam a ser as do widget.
export const CustomWidget = registerClass(
class CustomWidget extends Widget {
    setup() {
        this._hostRun = 0;
        this._hostTimer = 0;
        this._hostReloadId = 0;
        this._hostMonitors = [];
        this._hostCustomDestroy = null;
        this.connect('destroy', () => this._hostStop());
        this._hostLoad();
    }

    // "color" no manifest tinge o ícone, como nos widgets que vêm com o dock.
    build(size) {
        const box = super.build(size);
        const color = this._hostInfo?.manifest.color;
        if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
            const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
            this._tile.icon.style = `color: ${color};` +
                (size !== 'square' ? ` background-color: rgba(${r}, ${g}, ${b}, 0.16);` : '');
        }
        return box;
    }

    get title() {
        return this._hostInfo?.name ?? 'Widget personalizado';
    }

    _hostLoad() {
        this._hostInfo = customInfo(this.widgetParam);
        this._hostClicks = {};
        if (!this._panel)
            this.createPanel({wide: true});
        this._hostSetState(null);
        if (!this._hostInfo) {
            // Vigia a pasta dos widgets: se ele (re)aparecer, carrega.
            this._hostWatch(customDir());
            this._hostFail('Widget não encontrado', 'A pasta dele foi removida.');
            return;
        }
        this.add_style_class_name(`gprdock-c-${this._hostInfo.id}`);
        this._hostWatch(this._hostInfo.dir);
        if (this._hostInfo.error) {
            this._hostFail(this._hostInfo.name, this._hostInfo.error);
            return;
        }
        this.display({
            icon: this._hostInfo.icon || 'application-x-addon-symbolic',
            caption: this._hostInfo.name,
        });
        if (this._hostInfo.kind === 'module')
            this._hostLoadModule().catch(e => this._hostFail(this._hostInfo.name, e.message ?? String(e)));
        else
            this._hostStartCommand();
    }

    _hostFail(name, message) {
        this._hostSetState('warn');
        this.display({icon: 'dialog-warning-symbolic', value: 'Erro', short: '!', caption: name});
        this.setPanelLines([[name, 'gprdock-panel-title'], [message]]);
    }

    _hostSetState(state) {
        Object.values(STATES).forEach(c => this.remove_style_class_name(c));
        if (STATES[state])
            this.add_style_class_name(STATES[state]);
    }

    // Salvar qualquer arquivo da pasta recarrega o widget: dá para ir
    // ajustando com o dock aberto.
    _hostWatch(dir) {
        if (this._hostWatched === dir)
            return;
        this._hostMonitors.forEach(m => m.cancel());
        this._hostMonitors = [];
        this._hostWatched = dir;
        try {
            GLib.mkdir_with_parents(dir, 0o755);
            const monitor = Gio.File.new_for_path(dir)
                .monitor_directory(Gio.FileMonitorFlags.NONE, null);
            monitor.connect('changed', () => this._hostQueueReload());
            this._hostMonitors.push(monitor);
        } catch (e) {
            console.warn(`gprdock: não deu para vigiar ${dir}: ${e.message}`);
        }
    }

    _hostQueueReload() {
        if (this._hostReloadId)
            return;
        this._hostReloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RELOAD_DELAY, () => {
            this._hostReloadId = 0;
            this._hostStopWork();
            this._hostLoad();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hostStopWork() {
        this._hostRun++;
        this._hostBusy = false;
        this._hostTimer = 0;
        // Todos os timers, inclusive os que um módulo criou com every().
        this._timers.forEach(id => GLib.source_remove(id));
        this._timers.clear();
        if (this._hostCustomDestroy) {
            try {
                this._hostCustomDestroy();
            } catch (e) {
                console.error(`gprdock: ${this.widgetName}: onDestroy falhou`, e);
            }
            this._hostCustomDestroy = null;
        }
        // Tira o que o módulo tinha trocado; as funções da classe voltam.
        for (const key of this._hostMixed ?? [])
            delete this[key];
        this._hostMixed = null;
    }

    _hostStop() {
        this._hostStopWork();
        if (this._hostReloadId)
            GLib.source_remove(this._hostReloadId);
        this._hostReloadId = 0;
        this._hostMonitors.forEach(m => m.cancel());
        this._hostMonitors = [];
        this._hostWatched = null;
    }

    // ---------- Tipo comando ----------

    _hostArgv() {
        const {manifest, dir} = this._hostInfo;
        if (typeof manifest.script === 'string')
            return [GLib.build_filenamev([dir, manifest.script])];
        if (Array.isArray(manifest.command))
            return manifest.command.map(String);
        return ['bash', '-c', String(manifest.command)];
    }

    _hostStartCommand() {
        const {manifest} = this._hostInfo;
        for (const key of ['click', 'middleClick']) {
            if (isAction(manifest[key]))
                this._hostClicks[key] = manifest[key];
        }
        const interval = Math.max(MIN_INTERVAL,
            Number.isFinite(manifest.interval) ? Math.round(manifest.interval) : DEFAULT_INTERVAL);
        this._hostTimer = this.every(interval, () => this._hostRunCommand());
        this._hostRunCommand();
    }

    _hostSpawn(argv) {
        return new Promise((resolve, reject) => {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            launcher.set_cwd(this._hostInfo.dir);
            launcher.setenv('GPRDOCK_WIDGET_DIR', this._hostInfo.dir, true);
            launcher.setenv('GPRDOCK_WIDGET_ID', this._hostInfo.id, true);
            launcher.setenv('GPRDOCK_WIDGET_SIZE', this.size ?? 'square', true);
            let process = null;
            try {
                process = launcher.spawnv(argv);
            } catch (e) {
                reject(new Error(`Não foi possível rodar ${argv[0]}: ${e.message}`));
                return;
            }
            process.communicate_utf8_async(null, this.cancellable, (source, result) => {
                try {
                    const [, stdout, stderr] = source.communicate_utf8_finish(result);
                    if (source.get_successful())
                        resolve(stdout);
                    else
                        reject(new Error(stderr.trim().split('\n').at(-1) || `${argv[0]} falhou`));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async _hostRunCommand() {
        if (this._hostBusy)
            return;
        const run = this._hostRun;
        this._hostBusy = true;
        let output = null;
        let error = null;
        try {
            output = await this._hostSpawn(this._hostArgv());
        } catch (e) {
            error = e;
        }
        this._hostBusy = false;
        if (run !== this._hostRun || isCancelled(error))
            return;
        if (error)
            this._hostFail(this._hostInfo.name, error.message);
        else
            this._hostShow(this._hostParse(output));
    }

    // Saída do script: um JSON, ou linhas (valor, legenda, painel).
    _hostParse(output) {
        const text = output.trim();
        if (text.startsWith('{')) {
            try {
                const data = JSON.parse(text);
                if (data && typeof data === 'object')
                    return data;
            } catch {
                // Não era JSON: segue como texto.
            }
        }
        const [value = '', caption, ...lines] = text.split('\n');
        return {value, caption, lines};
    }

    _hostShow(data) {
        const text = value => value === undefined || value === null ? undefined : String(value);
        const ring = Number(data.ring);
        this._hostSetState(data.state);
        this.display({
            icon: text(data.icon) ?? (this._hostInfo.icon || 'application-x-addon-symbolic'),
            value: text(data.value) ?? '',
            short: text(data.short),
            caption: text(data.caption) ?? this._hostInfo.name,
            ring: data.ring === undefined || data.ring === null || !Number.isFinite(ring)
                ? undefined : Math.min(Math.max(ring, 0), 1),
            ringText: text(data.ringText),
        });
        if (isAction(data.click))
            this._hostClicks.click = data.click;

        const lines = [[this._hostInfo.name, 'gprdock-panel-title']];
        for (const line of Array.isArray(data.lines) ? data.lines : []) {
            if (typeof line === 'string') {
                if (line.trim())
                    lines.push([line]);
            } else if (line && typeof line === 'object' && line.text !== undefined) {
                lines.push([String(line.text), line.title ? 'gprdock-panel-title' : null,
                    isAction(line) ? () => this._hostAct(line) : null]);
            }
        }
        this.setPanelLines(lines);
    }

    _hostAct(action) {
        if (!action || action === 'panel') {
            this._panel?.toggle();
            return true;
        }
        try {
            if (typeof action.open === 'string')
                return this.openUri(action.open);
            if (typeof action.app === 'string')
                return this.launchApp(action.app);
            if (Array.isArray(action.run)) {
                this._hostSpawn(action.run.map(String))
                    .then(() => this._hostInfo?.kind === 'command' && this._hostRunCommand())
                    .catch(e => !isCancelled(e) &&
                        Main.notify(this._hostInfo.name, e.message));
                return true;
            }
        } catch (e) {
            Main.notify(this._hostInfo.name, e.message);
        }
        return false;
    }

    onClick() {
        this._hostAct(this._hostClicks.click ?? 'panel');
    }

    onMiddleClick() {
        return this._hostClicks.middleClick ? this._hostAct(this._hostClicks.middleClick) : false;
    }

    // ---------- Tipo módulo ----------

    // O GNOME Shell guarda cada módulo pelo endereço e não o lê de novo. Para
    // uma edição valer na hora, a pasta é importada por um link com a data da
    // última mudança no nome: endereço novo, leitura nova.
    _hostModuleUri() {
        const {dir, manifest, id} = this._hostInfo;
        const file = GLib.build_filenamev([dir, manifest.module]);
        const modified = Gio.File.new_for_path(file).query_info(
            'time::modified,time::modified-usec', Gio.FileQueryInfoFlags.NONE, null);
        const stamp = `${modified.get_attribute_uint64('time::modified')}` +
            `${modified.get_attribute_uint32('time::modified-usec')}`.padStart(6, '0');
        const cache = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gprdock', 'custom']);
        GLib.mkdir_with_parents(cache, 0o700);
        const prefix = `${id}-`;
        const name = `${prefix}${stamp}`;
        const listing = GLib.Dir.open(cache, 0);
        for (let entry = listing.read_name(); entry !== null; entry = listing.read_name()) {
            if (entry.startsWith(prefix) && entry !== name && /^\d+$/.test(entry.slice(prefix.length)))
                GLib.unlink(GLib.build_filenamev([cache, entry]));
        }
        listing.close();
        const link = GLib.build_filenamev([cache, name]);
        if (!GLib.file_test(link, GLib.FileTest.EXISTS))
            Gio.File.new_for_path(link).make_symbolic_link(dir, null);
        return `file://${link}/${manifest.module}`;
    }

    async _hostLoadModule() {
        const run = this._hostRun;
        const module = await import(this._hostModuleUri());
        if (run !== this._hostRun)
            return;
        const api = {
            manifest: this._hostInfo.manifest,
            dir: this._hostInfo.dir,
            runCommand: argv => runCommand(argv, this.cancellable),
            readFile: path => readFile(path, this.cancellable),
            httpGet: (session, url, headers) => httpGet(session, url, headers, this.cancellable),
            httpRequest: (session, method, url, headers, json) =>
                httpRequest(session, method, url, headers, json, this.cancellable),
            isCancelled,
            Clutter, Gio, GLib, GObject, Shell, St, Main,
        };
        // O módulo cria o próprio painel, se quiser um.
        this._panel?.destroy();
        this._panel = null;
        // O padrão exportado é uma função que recebe `api` e devolve uma
        // classe (ou um objeto) com as funções do widget.
        const exported = typeof module.default === 'function' && !module.default.prototype?.setup
            ? module.default(api) : module.default;
        const mixin = typeof exported === 'function' ? exported.prototype : exported;
        if (!mixin || typeof mixin !== 'object')
            throw new Error('O módulo precisa exportar por padrão uma função que devolve uma classe');

        // As funções do módulo viram funções deste widget: `this` dentro
        // delas é o widget, com display(), every(), createPanel() etc.
        this._hostMixed = [];
        for (const [key, value] of Object.entries(Object.getOwnPropertyDescriptors(mixin))) {
            if (key === 'constructor')
                continue;
            if (key === 'onDestroy') {
                this._hostCustomDestroy = () => value.value.call(this);
                continue;
            }
            // Só os ganchos podem ser trocados; o resto que já existe no
            // widget (display, every, o que é interno) fica como está.
            if (!HOOKS.includes(key) && key in this) {
                console.warn(`gprdock: ${this.widgetName}: "${key}" já existe no widget e foi ignorado`);
                continue;
            }
            Object.defineProperty(this, key, {...value, configurable: true});
            this._hostMixed.push(key);
        }
        if (typeof mixin.setup === 'function')
            this.setup();
        // Remonta o tile: o módulo pode ter trocado build() ou refresh().
        const size = this._size;
        if (size) {
            this._size = null;
            this.setSize(size);
        }
    }
});
