import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Ring} from './gauges.js';
import {registerClass} from '../registerClass.js';

// Navegadores que aceitam "--new-window <endereço>".
const NEW_WINDOW_BROWSERS = /chrom|brave|edge|vivaldi|opera|firefox|librewolf|zen/i;
// ms entre dar o foco à janela do navegador e entregar o endereço a ele: o
// tempo de o navegador saber que aquela é a janela em uso.
const BROWSER_FOCUS_TIME = 200;
const HOVER_LIFT = 2;           // px lógicos que o widget sobe com o cursor
const HOVER_TIME = 140;
const VALUE_TIME = 240;         // ms da troca de um valor no tile
const PULSE_TIME = 900;         // ms de cada "respirada" do estado de alerta
// Classes de estado que fazem o widget pulsar, e a cor do brilho de cada uma.
const PULSING = ['gprdock-state-alert', 'gprdock-ai-attention', 'gprdock-state-warn'];

// Base dos tiles do dock. Todo widget existe nas formas 'square' e 'wide', e
// alguns também em 'large' (3 espaços); a forma pode mudar a qualquer momento.
//
// O caso comum não desenha nada: chama display({...}) com o que quer mostrar
// e a base monta as duas formas. Quem precisa de um desenho próprio
// sobrescreve build(size) e refresh().
//
// Ciclo de vida para as subclasses: setup() (uma vez), build()/refresh() (a
// cada troca de forma), onClick()/onSecondaryClick(), onDestroy().
export const Widget = registerClass(
class Widget extends St.Button {
    _init(dock, name) {
        // 'git@<conta>' é o widget 'git' com um parâmetro (ver profiles.js).
        const [base] = name.split('@');
        super._init({
            style_class: `gprdock-widget gprdock-w-${base}`,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.widgetName = name;
        this.widgetParam = name.includes('@') ? name.slice(name.indexOf('@') + 1) : null;
        this._dock = dock;
        this._settings = dock.settings;
        this._timers = new Set();
        this._gauges = [];
        this._size = null;
        this._view = {};
        this._tile = null;
        this.cancellable = new Gio.Cancellable();

        this.connect('clicked', () => this.onClick());
        // Com o cursor em cima o widget sobe um pouco.
        this.track_hover = true;
        this.connect('notify::hover', () => this._onHover());
        // Estados de alerta (ver PULSING) fazem o brilho atrás do tile respirar.
        this.connect('notify::style-class', () => this._syncPulse());
        // O clique direito é tratado já no pressionar e não segue adiante:
        // se chegasse ao dock, abriria o menu dele por cima do widget.
        // O do meio abre o programa ou a página a que o widget se refere.
        this.connect('button-press-event', (_actor, event) => {
            const button = event.get_button();
            if (button === Clutter.BUTTON_MIDDLE)
                return this.onMiddleClick() ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
            if (button !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this.onSecondaryClick();
            return Clutter.EVENT_STOP;
        });
        this.connect('destroy', () => this._cleanup());

        this.setup();
    }

    setup() {
    }

    get size() {
        return this._size;
    }

    // Verdadeiro nas formas horizontais ('wide' e 'large').
    get wide() {
        return this._size !== 'square';
    }

    get large() {
        return this._size === 'large';
    }

    setSize(size) {
        if (size === this._size)
            return;
        if (this._size)
            this.remove_style_class_name(`gprdock-widget-${this._size}`);
        this._size = size;
        this.add_style_class_name(`gprdock-widget-${size}`);

        const tile = this._dock.tileSize;
        this.style = this.wide
            ? `height: ${tile}px;`
            : `height: ${tile}px; width: ${tile}px;`;

        this._gauges = [];
        this._tile = null;
        this._shown = null;

        // O conteúdo vai por cima de uma camada de brilho, que só aparece
        // nos estados de alerta.
        const wrap = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._glow = new St.Widget({
            style_class: 'gprdock-glow',
            x_expand: true,
            y_expand: true,
            opacity: 0,
        });
        wrap.add_child(this._glow);
        wrap.add_child(this.build(size));
        this.set_child(wrap);
        this.refresh();
        this._syncPulse();
    }

    _onHover() {
        if (this.hover)
            this._dock.showHoverLabel?.(this);
        else
            this._dock.hideHoverLabel?.();

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.remove_transition('translation-y');
        this.ease({
            translation_y: this.hover ? -HOVER_LIFT * scale : 0,
            duration: HOVER_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            // O vidro atrás do widget acompanha o lugar novo.
            onComplete: () => this._dock.onWidgetMoved?.(),
        });
    }

    _syncPulse() {
        const glow = this._glow;
        if (!glow)
            return;
        const state = PULSING.find(name => this.has_style_class_name(name));
        if (state === this._pulsing)
            return;
        this._pulsing = state;
        glow.remove_all_transitions();
        for (const name of PULSING)
            glow.remove_style_class_name(`${name}-glow`);
        if (!state) {
            glow.ease({opacity: 0, duration: 300});
            return;
        }
        glow.add_style_class_name(`${state}-glow`);
        glow.opacity = 60;
        glow.ease({
            opacity: 255,
            duration: PULSE_TIME,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            autoReverse: true,
            repeatCount: -1,
        });
    }

    // ---------- Desenho padrão ----------
    //
    // display() aceita:
    //   icon / gicon  ícone (quando não há anel)
    //   ring          fração 0..1; desenha um anel no lugar do ícone
    //   ringText      texto dentro do anel
    //   value         texto principal
    //   short         versão curta do texto, para a forma quadrada
    //   caption       linha menor acima do texto principal (só na forma larga)

    build(size) {
        const wide = size !== 'square';
        const tile = this._dock.tileSize;

        const icon = new St.Icon({
            style_class: 'gprdock-tile-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const ring = this.trackGauge(new Ring({x_expand: true, y_expand: true}));
        const ringLabel = new St.Label({
            style_class: 'gprdock-tile-ring-text',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        const ringBox = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        ringBox.add_child(ring);
        ringBox.add_child(ringLabel);

        const caption = new St.Label({style_class: 'gprdock-tile-caption'});
        const value = new St.Label({
            style_class: 'gprdock-tile-value',
            x_align: wide ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
        });

        const box = new St.BoxLayout({
            style_class: `gprdock-tile gprdock-tile-${wide ? 'wide' : 'square'}`,
            orientation: wide ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        box.add_child(icon);
        box.add_child(ringBox);

        if (wide) {
            const side = tile - 16;
            ringBox.style = `width: ${side}px; height: ${side}px;`;
            const text = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'gprdock-tile-text',
                y_align: Clutter.ActorAlign.CENTER,
            });
            text.add_child(caption);
            text.add_child(value);
            box.add_child(text);

            // Na forma grande o texto principal ganha uma segunda linha.
            if (size === 'large') {
                text.add_style_class_name('gprdock-tile-text-large');
                value.add_style_class_name('gprdock-tile-value-large');
                value.clutter_text.line_wrap = true;
                value.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                // Com reticências o texto só pede a altura de uma linha; sem
                // elas ele quebra, e o que passar da altura máxima é cortado.
                value.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                value.clip_to_allocation = true;
            }
        } else {
            const side = tile - 10;
            ringBox.style = `width: ${side}px; height: ${side}px;`;
            box.add_child(value);
        }

        this._tile = {wide, icon, ring, ringBox, ringLabel, caption, value};
        return box;
    }

    display(view) {
        this._view = view;
        this._renderTile();
    }

    refresh() {
        this._renderTile();
    }

    _renderTile() {
        const t = this._tile;
        if (!t)
            return;
        const v = this._view;
        const hasRing = v.ring !== undefined && v.ring !== null;
        const text = t.wide ? v.value ?? '' : v.short ?? v.value ?? '';

        t.ringBox.visible = hasRing;
        if (hasRing) {
            t.ring.show(v.ring);
            // No quadrado o anel ocupa o tile todo: o texto vai dentro dele.
            t.ringLabel.text = v.ringText ?? (t.wide ? '' : text);
        }

        t.icon.visible = !hasRing && Boolean(v.icon || v.gicon);
        if (t.icon.visible) {
            if (v.gicon)
                t.icon.gicon = v.gicon;
            else
                t.icon.icon_name = v.icon;
        }

        // Um valor que mudou entra deslizando de baixo; o primeiro só aparece.
        const changed = this._shown !== null && this._shown !== text && text !== '';
        this._shown = text;
        t.value.text = text;
        t.value.visible = text !== '' && (t.wide || !hasRing);
        if (changed && this.get_stage())
            this._animateValue(t.wide || !hasRing ? t.value : t.ringLabel);
        t.caption.text = v.caption ?? '';
        t.caption.visible = t.wide && Boolean(v.caption);

        // Sem ícone nem anel, o texto do quadrado pode ser maior.
        if (!t.wide && !hasRing && !t.icon.visible)
            t.value.add_style_class_name('gprdock-tile-value-alone');
        else
            t.value.remove_style_class_name('gprdock-tile-value-alone');
    }

    _animateValue(label) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        label.remove_all_transitions();
        label.translation_y = 6 * scale;
        label.opacity = 90;
        label.ease({
            translation_y: 0,
            opacity: 255,
            duration: VALUE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    // ---------- Cliques ----------

    onClick() {
        this._panel?.toggle();
    }

    onSecondaryClick() {
        this._dock.openMenu(this);
    }

    // Devolve verdadeiro se abriu alguma coisa.
    onMiddleClick() {
        return false;
    }

    // ---------- Utilidades ----------

    // Ativa o primeiro destes apps (ids de .desktop) que estiver instalado.
    launchApp(...ids) {
        const appSystem = Shell.AppSystem.get_default();
        const app = ids.map(id => appSystem.lookup_app(id)).find(Boolean);
        app?.activate();
        return Boolean(app);
    }

    // Repete fn a cada `seconds`; o timer morre junto com o widget.
    every(seconds, fn) {
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            fn();
            return GLib.SOURCE_CONTINUE;
        });
        this._timers.add(id);
        return id;
    }

    // Roda fn uma vez, daqui a `seconds`; chamar de novo adia. Serve para
    // tentar de novo logo depois de uma falha, em vez de esperar o ciclo.
    retryIn(seconds, fn) {
        if (this._retryId)
            this.cancelTimer(this._retryId);
        this._retryId = this.every(seconds, () => {
            this.cancelTimer(this._retryId);
            this._retryId = 0;
            fn();
        });
    }

    cancelTimer(id) {
        if (this._timers.delete(id))
            GLib.source_remove(id);
    }

    trackGauge(gauge) {
        this._gauges.push(gauge);
        return gauge;
    }

    queue_redraw_all() {
        this._gauges.forEach(g => g.queue_repaint());
    }

    // Painel que abre acima do tile. `wide` para listas de títulos compridos.
    createPanel({wide = false} = {}) {
        this._panel = new PopupMenu.PopupMenu(this, 0.5, St.Side.BOTTOM);
        this._dock.registerMenu(this._panel);
        if (wide)
            this._panel.actor.add_style_class_name('gprdock-panel-wide');
        return this._panel;
    }

    // Cada linha é [texto, classe CSS opcional, ação opcional ao clicar].
    setPanelLines(lines) {
        if (!this._panel)
            return;
        this._panel.removeAll();
        for (const [text, styleClass, onActivate] of lines) {
            const item = new PopupMenu.PopupMenuItem(text, {
                reactive: Boolean(onActivate),
                can_focus: Boolean(onActivate),
            });
            item.label.clutter_text.line_wrap = true;
            item.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            if (styleClass)
                item.label.add_style_class_name(styleClass);
            if (onActivate)
                item.connect('activate', onActivate);
            this._panel.addMenuItem(item);
        }
    }

    // Abre um endereço. Os da web vão para o navegador que já está aberto
    // neste perfil (nesta área de trabalho), numa aba nova; janela nova só
    // se aqui não houver nenhuma.
    //
    // O navegador põe a aba na janela que esteve em foco por último, que
    // pode ser de outra área de trabalho, ou de outro usuário do navegador,
    // sem o login que o endereço pede. Por isso a janela daqui ganha o foco
    // antes de o endereço ser entregue.
    openUri(uri) {
        const context = global.create_app_launch_context(0, -1);
        const browser = /^https?:/i.test(uri) ? Gio.AppInfo.get_default_for_uri_scheme('https') : null;
        const app = browser ? Shell.AppSystem.get_default().lookup_app(browser.get_id()) : null;
        const windows = (app?.get_windows() ?? []).filter(w => !w.skip_taskbar);
        if (windows.length === 0) {
            Gio.AppInfo.launch_default_for_uri(uri, context);
            return true;
        }

        const workspace = global.workspace_manager.get_active_workspace();
        const [here] = windows.filter(w => w.located_on_workspace(workspace))
            .sort((a, b) => b.get_user_time() - a.get_user_time());
        if (!here) {
            // Aberto só em outros perfis: janela nova aqui, se o navegador
            // souber abrir uma com o endereço.
            const command = browser.get_commandline() ?? '';
            if (NEW_WINDOW_BROWSERS.test(browser.get_id()) && /%[uU]/.test(command)) {
                Gio.AppInfo.create_from_commandline(
                    command.replace(/%[uU]/, `--new-window ${GLib.shell_quote(uri)}`),
                    browser.get_name(), Gio.AppInfoCreateFlags.NONE).launch([], context);
            } else {
                Gio.AppInfo.launch_default_for_uri(uri, context);
            }
            return true;
        }

        Main.activateWindow(here);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BROWSER_FOCUS_TIME, () => {
            this._timers.delete(id);
            try {
                Gio.AppInfo.launch_default_for_uri(uri, context);
            } catch (e) {
                console.warn(`gprdock: não abriu ${uri}`, e);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return true;
    }

    _cleanup() {
        if (this.hover)
            this._dock.hideHoverLabel?.();
        this.cancellable.cancel();
        this._timers.forEach(id => GLib.source_remove(id));
        this._timers.clear();
        this._panel?.destroy();
        this._panel = null;
        this.onDestroy();
    }

    onDestroy() {
    }
});

export function isCancelled(error) {
    return error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
}

export function readFile(path, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(cancellable, (file, result) => {
            try {
                const [, contents] = file.load_contents_finish(result);
                resolve(new TextDecoder().decode(contents));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Roda um comando e devolve a saída dele; rejeita com a última linha de erro.
export function runCommand(argv, cancellable) {
    return new Promise((resolve, reject) => {
        let process = null;
        try {
            process = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            reject(new Error(`O comando ${argv[0]} não foi encontrado`));
            return;
        }
        process.communicate_utf8_async(null, cancellable, (source, result) => {
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

// GET que devolve {status, text, headers}; rejeita só em falha de rede.
export function httpGet(session, url, headers, cancellable) {
    return httpRequest(session, 'GET', url, headers, null, cancellable);
}

// Com `json`, envia-o como corpo da requisição.
export function httpRequest(session, method, url, headers, json, cancellable) {
    return new Promise((resolve, reject) => {
        const message = Soup.Message.new(method, url);
        if (!message) {
            reject(new Error('Endereço inválido'));
            return;
        }
        for (const [name, value] of Object.entries(headers ?? {}))
            message.get_request_headers().append(name, value);
        if (json !== null) {
            message.set_request_body_from_bytes('application/json',
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify(json))));
        }

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable,
            (source, result) => {
                try {
                    let bytes = null;
                    try {
                        bytes = source.send_and_read_finish(result);
                    } catch (e) {
                        // Uma conexão guardada pode ter morrido (VPN que caiu
                        // e voltou): as próximas tentativas começam do zero.
                        if (!isCancelled(e)) {
                            source.abort();
                            console.warn(`gprdock: falha de rede em ${GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host()}: ${e.message}`);
                        }
                        throw e;
                    }
                    resolve({
                        // status_code, e não get_status(): este lança exceção
                        // para códigos fora do enum, como o 429.
                        status: message.status_code,
                        text: new TextDecoder().decode(bytes.get_data()),
                        headers: message.get_response_headers(),
                    });
                } catch (e) {
                    reject(e);
                }
            });
    });
}
