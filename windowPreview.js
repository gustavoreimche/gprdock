import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SHOW_DELAY = 350;     // ms com o cursor parado no ícone
const HIDE_DELAY = 220;     // ms para ir do ícone até a prévia sem ela sumir
const THUMB_WIDTH = 210;    // px lógicos
const THUMB_HEIGHT = 130;
const GAP = 6;

// Miniaturas das janelas de um app, acima do ícone dele, quando há mais de
// uma para escolher. Clicar numa traz a janela; o X fecha.
export class WindowPreview {
    constructor(dock) {
        this._dock = dock;
        this._item = null;
        this._showId = 0;
        this._hideId = 0;

        // As classes de painel dão à prévia o mesmo visual dos menus do tema.
        this.actor = new St.Widget({
            style_class: 'gprdock-panel gprdock-preview',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            visible: false,
        });
        this._box = new St.BoxLayout({style_class: 'gprdock-panel-content gprdock-preview-box'});
        this.actor.add_child(this._box);
        this.actor.connect('notify::hover', () => this._onHover());
        // Sem acompanhar a tela cheia: quem acompanha tem a visibilidade
        // mexida pelo GNOME, e aqui "visível" tem de ser só "aberta".
        Main.layoutManager.addChrome(this.actor);
        this._dock.themeActor(this.actor);

        // Nos temas de vidro a prévia tem o mesmo fundo dos painéis.
        const self = this;
        this._glass = this._dock.createGlass({
            actor: this.actor,
            box: this._box,
            get sourceActor() {
                return self._item ?? self._dock.actor;
            },
            isOpen: false,
            connectObject() {},
            disconnectObject() {},
        });
    }

    get visible() {
        return this.actor.visible;
    }

    get _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    _clear(name) {
        if (this[name]) {
            GLib.source_remove(this[name]);
            this[name] = 0;
        }
    }

    // O cursor entrou num ícone (ou saiu dele).
    enter(item) {
        this._clear('_hideId');
        if (this._item === item && this.visible)
            return;
        this._clear('_showId');
        if (item.appIcon.windows().length < 2) {
            this.hide();
            return;
        }
        // Já há uma prévia na tela: passar para o ícone ao lado troca na hora.
        if (this.visible) {
            this._show(item);
            return;
        }
        this._showId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHOW_DELAY, () => {
            this._showId = 0;
            this._show(item);
            return GLib.SOURCE_REMOVE;
        });
    }

    leave(item) {
        this._clear('_showId');
        if (this._item === item)
            this._onHover();
    }

    _onHover() {
        this._clear('_hideId');
        if (!this.visible || this.actor.hover)
            return;
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY, () => {
            this._hideId = 0;
            if (!this.actor.hover && !this._item?.appIcon.hover)
                this.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _show(item) {
        const windows = item.appIcon.windows();
        if (windows.length < 2 || !item.get_stage() || item.appIcon._menu?.isOpen) {
            this.hide();
            return;
        }

        this._release();
        this._item = item;
        // Janela aberta ou fechada com a prévia na tela: ela se refaz.
        item.appIcon.app.connectObject('windows-changed', () => this._show(item), this);
        item.connectObject('destroy', () => this.hide(), this);
        item.hideLabel();

        this._box.destroy_all_children();
        for (const window of windows)
            this._box.add_child(this._thumbnail(window));

        const glass = this._dock.glass;
        this._glass.enabled = glass;
        if (glass)
            this._box.add_style_class_name('gprdock-panel-glass');
        else
            this._box.remove_style_class_name('gprdock-panel-glass');
        // A foto do fundo é tirada com a prévia ainda transparente, para ela
        // não sair na própria foto.
        const fresh = !this.actor.visible;
        if (fresh)
            this.actor.opacity = 0;
        this.actor.show();
        if (fresh) {
            this._glass.show();
            this.actor.opacity = 255;
        }
        const monitor = this._dock.monitor;
        const [, width] = this.actor.get_preferred_width(-1);
        const [, height] = this.actor.get_preferred_height(-1);
        const [x] = item.get_transformed_position();
        const [itemWidth] = item.get_transformed_size();
        const left = Math.round(x + itemWidth / 2 - width / 2);
        this.actor.set_position(
            Math.max(monitor.x + GAP, Math.min(left, monitor.x + monitor.width - width - GAP)),
            Math.round(this._dock.container.y - height - GAP * this._scale));
        this._dock.onPreviewChanged();
    }

    _thumbnail(window) {
        const scale = this._scale;
        const source = window.get_compositor_private();
        const fit = Math.min(THUMB_WIDTH * scale / Math.max(1, source.width),
            THUMB_HEIGHT * scale / Math.max(1, source.height));

        const button = new St.Button({
            style_class: 'gprdock-preview-item',
            can_focus: true,
        });
        // Largura fixa: um título comprido encolhe com reticências em vez de
        // alargar a prévia.
        const column = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            width: THUMB_WIDTH * scale,
        });
        const header = new St.BoxLayout({style_class: 'gprdock-preview-header'});
        const label = new St.Label({
            text: window.get_title() ?? '',
            style_class: 'gprdock-preview-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const close = new St.Button({
            style_class: 'gprdock-preview-close',
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
            accessible_name: 'Fechar a janela',
        });
        close.connect('clicked', () => window.delete(global.get_current_time()));
        header.add_child(label);
        header.add_child(close);

        // A largura de todas é a mesma; a miniatura fica centrada nela.
        const frame = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: THUMB_WIDTH * scale,
            height: THUMB_HEIGHT * scale,
        });
        frame.add_child(new Clutter.Clone({
            source,
            width: Math.round(source.width * fit),
            height: Math.round(source.height * fit),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        }));
        column.add_child(header);
        column.add_child(frame);
        button.set_child(column);
        button.connect('clicked', () => {
            this.hide();
            Main.activateWindow(window);
        });
        return button;
    }

    _release() {
        this._item?.appIcon.app.disconnectObject(this);
        this._item?.disconnectObject(this);
        this._item = null;
    }

    hide() {
        this._clear('_showId');
        this._clear('_hideId');
        this._release();
        if (!this.visible)
            return;
        this.actor.hide();
        this._box.destroy_all_children();
        this._dock.onPreviewChanged();
    }

    destroy() {
        this.hide();
        this._glass.destroy();
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }
}
