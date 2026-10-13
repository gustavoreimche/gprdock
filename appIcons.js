import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {DashItemContainer} from 'resource:///org/gnome/shell/ui/dash.js';
import {customGicon} from './iconLibrary.js';
import {registerClass} from './registerClass.js';
import {isIsolatedCopy, isSingleWindowWebApp, isWebApp} from './webApps.js';

const HOVER_SCALE = 1.14;
const HOVER_TIME = 120;
const MAX_WINDOW_DOTS = 4;
const BOUNCE_HEIGHT = 9;        // px lógicos
const BOUNCE_TIME = 220;
const BOUNCE_COUNT = 3;
const ELSEWHERE_OPACITY = 110;    // ponto de "aberto em outro perfil"

const DockAppIcon = registerClass(
class DockAppIcon extends AppDisplay.AppIcon {
    _init(app, settings, appSpread, webApps) {
        super._init(app, {
            setSizeManually: true,
            showLabel: false,
            popupMenuSide: St.Side.BOTTOM,
        });
        this._settings = settings;
        this._appSpread = appSpread;
        this._webApps = webApps;
    }

    // O ícone que o usuário escolheu para o app, se houver; senão o dele.
    // (O GNOME pode pedir o ícone antes de o _init acima terminar.)
    _createIcon(iconSize) {
        const gicon = this._settings ? customGicon(this._settings, this.app.get_id()) : null;
        if (!gicon)
            return super._createIcon(iconSize);
        return new St.Icon({gicon, icon_size: iconSize, fallback_gicon: this.app.get_icon()});
    }

    getDragActor() {
        return this._createIcon(Main.overview.dash.iconSize);
    }

    // O menu do GNOME, mais o que o dock oferece: trocar o ícone e, para
    // apps web, uma cópia com sessão isolada (e, numa cópia, apagá-la).
    popupMenu() {
        const created = !this._menu;
        const result = super.popupMenu();
        if (created && this._menu) {
            this._webApps.adoptMenu(this._menu);
            const id = this.app.get_id();
            this._menu.addAction('Trocar ícone…', () => this._webApps.chooseIcon(this.app));
            if (isWebApp(id)) {
                this._menu.addAction('Duplicar com sessão isolada',
                    () => this._webApps.duplicate(this.app));
            } else if (isIsolatedCopy(id)) {
                this._menu.addAction('Apagar esta cópia e a sessão dela',
                    () => this._webApps.remove(this.app));
            }
        }
        return result;
    }

    // O ícone não é alvo de soltura (isso é com o dock) nem some ao ser
    // arrastado: quem mostra o arrasto é o dock.
    scaleAndFade() {
    }

    undoScaleAndFade() {
    }

    handleDragOver() {
        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop() {
        return false;
    }

    // Janelas do app na área de trabalho em uso, sempre na mesma ordem (a de
    // criação), para o rodízio ser previsível. As de outras áreas não contam:
    // cada perfil cuida só do que está aberto nele.
    windows() {
        const workspace = global.workspace_manager.get_active_workspace();
        return this.app.get_windows()
            .filter(w => !w.skip_taskbar && w.located_on_workspace(workspace))
            .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
    }

    // Traz para a frente a janela daqui usada por último.
    _raise(windows) {
        const [latest] = [...windows].sort((a, b) => b.get_user_time() - a.get_user_time());
        if (latest)
            Main.activateWindow(latest);
    }

    // Apps de uma janela só: os apps web e os que não sabem abrir outra.
    get singleWindow() {
        return isSingleWindowWebApp(this.app.get_id()) || !this.app.can_open_new_window();
    }

    // Traz para a área de trabalho em uso a janela usada por último (e as
    // outras do app junto, para não ficarem para trás).
    _bringHere(windows) {
        const workspace = global.workspace_manager.get_active_workspace();
        windows.forEach(window => window.change_workspace(workspace));
        this._raise(windows);
    }

    // O que o clique e o clique do meio fazem num app já aberto é
    // configurável ('click-action' e 'middle-click-action'). App fechado e
    // Ctrl+clique seguem o padrão do GNOME (abrir / nova janela).
    activate(button) {
        const event = Clutter.get_current_event();
        const ctrl = event && (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (this.app.state !== Shell.AppState.RUNNING || ctrl) {
            super.activate(button);
            return;
        }

        const middle = button === Clutter.BUTTON_MIDDLE;
        const action = this._settings.get_string(
            middle ? 'middle-click-action' : 'click-action');
        const windows = this.windows();

        // Aberto só em outra área de trabalho: abre uma janela aqui em vez
        // de levar você para lá. Quem só tem uma janela (os apps web e os
        // que não sabem abrir outra) vem para cá com ela: assim o mesmo app
        // serve a todos os perfis, e fica no que usou por último.
        if (windows.length === 0) {
            const elsewhere = this.app.get_windows().filter(w => !w.skip_taskbar);
            if (this.singleWindow && elsewhere.length > 0)
                this._bringHere(elsewhere);
            else if (this.app.can_open_new_window())
                this.app.open_new_window(-1);
            else
                super.activate(button);
            return;
        }
        const focused = Shell.WindowTracker.get_default().focus_app === this.app;

        // Uma cópia isolada abre outra janela a cada chamada: com uma já
        // aqui, o clique do meio e o "nova janela" só a trazem para a frente.
        if (isIsolatedCopy(this.app.get_id()) && (middle || action === 'new-window')) {
            this._raise(windows);
            return;
        }

        // Clique comum num app que não está em foco só o traz para a frente;
        // a ação escolhida vale a partir do segundo clique. As que servem
        // para escolher entre várias janelas são a exceção.
        const picks = ['smart', 'menu', 'overview'].includes(action) && windows.length > 1;
        if (!middle && !focused && !picks) {
            this._raise(windows);
            return;
        }

        switch (action) {
        case 'smart':
            // Várias janelas: mostra só elas para escolher. Uma só: minimiza
            // se está em foco, senão traz de volta.
            if (windows.length > 1)
                this._appSpread.toggle(this.app, windows);
            else if (focused)
                windows[0]?.minimize();
            else
                this._raise(windows);
            break;
        case 'cycle':
            if (windows.length > 1) {
                const current = windows.indexOf(global.display.focus_window);
                Main.activateWindow(windows[(current + 1) % windows.length]);
            } else {
                this._raise(windows);
            }
            break;
        case 'menu':
            this.popupMenu();
            break;
        case 'minimize':
            windows.forEach(w => w.minimize());
            break;
        case 'overview':
            // Expande as janelas do app, como a tecla Super faz com todas.
            this._appSpread.toggle(this.app, windows);
            break;
        case 'close': {
            // Fecha a janela em foco do app, ou a mais recente dele.
            const target = windows.includes(global.display.focus_window)
                ? global.display.focus_window : this.app.get_windows()[0];
            target?.delete(global.get_current_time());
            break;
        }
        case 'new-window':
            if (this.app.can_open_new_window())
                this.app.open_new_window(-1);
            break;
        default:
            this._raise(windows);
        }
    }
});

// Ícone de app pronto para o dock: tamanho, nome e zoom ao passar o mouse.
export function createAppItem(app, settings, appSpread, webApps) {
    const icon = new DockAppIcon(app, settings, appSpread, webApps);
    icon.icon.setIconSize(settings.get_int('icon-size'));
    // O zoom cresce a partir do centro, para caber no quadrado do destaque.
    icon.icon.set_pivot_point(0.5, 0.5);
    // Sem isto o botão estica até a altura do dock, e o destaque de quando o
    // cursor passa vira uma faixa alta e estreita em vez de um quadrado do
    // tamanho dos widgets.
    icon.y_align = Clutter.ActorAlign.CENTER;

    const item = new DashItemContainer();
    item.pivot_point = new Graphene.Point({x: 0.5, y: 1});
    item.setChild(icon);
    item.setLabelText(app.get_name());
    item.show(false);
    item.appIcon = icon;

    // Um ponto por janela aberta (até 4), no lugar do ponto único do GNOME.
    icon._dot.opacity = 0;
    const dots = new St.BoxLayout({
        style_class: 'gprdock-window-dots',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.END,
        x_expand: true,
        y_expand: true,
    });
    item.add_child(dots);
    let shown = '';
    const syncDots = () => {
        // Só as janelas desta área de trabalho: aberto em outra, sem ponto.
        // A exceção é o app de uma janela só, que o clique traz para cá: ele
        // ganha um ponto apagado, para se ver que já está aberto em outro
        // perfil.
        const here = Math.min(icon.windows().length, MAX_WINDOW_DOTS);
        const elsewhere = here === 0 && icon.singleWindow &&
            app.get_windows().some(w => !w.skip_taskbar);
        const state = elsewhere ? 'elsewhere' : `${here}`;
        if (state === shown)
            return;
        shown = state;
        dots.destroy_all_children();
        for (let i = 0; i < (elsewhere ? 1 : here); i++) {
            dots.add_child(new St.Widget({
                style_class: 'gprdock-window-dot',
                opacity: elsewhere ? ELSEWHERE_OPACITY : 255,
            }));
        }
    };
    // Abrindo: o ícone dá uns pulinhos até a janela aparecer.
    const bounce = () => {
        icon.icon.remove_transition('translation-y');
        icon.icon.translation_y = 0;
        if (app.state !== Shell.AppState.STARTING)
            return;
        icon.icon.ease({
            translation_y: -BOUNCE_HEIGHT * St.ThemeContext.get_for_stage(global.stage).scale_factor,
            duration: BOUNCE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            autoReverse: true,
            repeatCount: BOUNCE_COUNT * 2 - 1,
            onStopped: () => (icon.icon.translation_y = 0),
        });
    };
    app.connectObject('notify::state', bounce, icon);
    item.connect('destroy', () => app.disconnectObject(icon));

    // Uma janela que muda de área de trabalho (ou passa a ficar em todas)
    // não avisa pelo app: cada janela é acompanhada.
    const watched = new Set();
    const watchWindows = () => {
        const current = new Set(app.get_windows());
        for (const window of watched) {
            if (!current.has(window)) {
                window.disconnectObject(item);
                watched.delete(window);
            }
        }
        for (const window of current) {
            if (!watched.has(window)) {
                window.connectObject(
                    'workspace-changed', syncDots,
                    'notify::on-all-workspaces', syncDots, item);
                watched.add(window);
            }
        }
        syncDots();
    };
    app.connectObject(
        'windows-changed', watchWindows,
        'notify::state', syncDots, item);
    global.workspace_manager.connectObject('active-workspace-changed', syncDots, item);
    item.connect('destroy', () => {
        app.disconnectObject(item);
        global.workspace_manager.disconnectObject(item);
        watched.forEach(window => window.disconnectObject(item));
        watched.clear();
    });
    watchWindows();

    // Avisos pendentes do app, no canto de cima do ícone.
    const badge = new St.Label({
        style_class: 'gprdock-badge',
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.START,
        x_expand: true,
        y_expand: true,
        visible: false,
    });
    item.add_child(badge);
    badge.set_pivot_point(0.5, 0.5);
    item.setBadge = count => {
        const appearing = count > 0 && !badge.visible;
        badge.visible = count > 0;
        badge.text = count > 99 ? '99+' : `${count}`;
        if (appearing) {
            badge.set_scale(0.3, 0.3);
            badge.ease({
                scale_x: 1,
                scale_y: 1,
                duration: 320,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        }
    };

    icon.connect('notify::hover', () => {
        const hover = icon.hover;
        if (hover)
            item.showLabel();
        else
            item.hideLabel();

        const scale = hover ? HOVER_SCALE : 1;
        icon.icon.ease({
            scale_x: scale,
            scale_y: scale,
            duration: HOVER_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    });

    return item;
}
