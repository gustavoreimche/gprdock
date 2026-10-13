import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {isWebApp} from './webApps.js';

const PATH = '/io/github/gustavoreimche/gprdock';
const INTERFACE = `<node>
  <interface name="io.github.gustavoreimche.gprdock.Links">
    <method name="Query"><arg type="s" direction="out"/></method>
    <method name="Settle"><arg type="t" direction="in"/><arg type="b" direction="out"/></method>
  </interface>
</node>`;
// ms depois de o foco sair de um app web em que uma aba nova ainda é tida
// como aberta por ele.
const CLICK_TIME = 2000;
// ms que a extensão tem, depois de perguntar, para dizer onde a aba ficou.
const SETTLE_TIME = 5000;

const now = () => GLib.get_monotonic_time() / 1000;

// O lado do dock da extensão do navegador (browser/extension). Um link
// clicado num app web abre numa aba da janela do navegador usada por último,
// e o GNOME vai atrás dela, mesmo que esteja em outro perfil. A extensão
// pergunta aqui de que área de trabalho o clique partiu e que janelas do
// navegador há nela (Query), e pede a volta para lá, com uma dessas janelas
// na frente (Settle).
export class LinkBridge {
    constructor() {
        this._focus = null;         // {webApp, pid, workspace} da janela em foco
        this._previous = null;      // o mesmo, da que estava em foco antes
        this._changedAt = 0;
        this._origin = null;        // {workspace, at} da última pergunta
        global.display.connectObject('notify::focus-window', () => this._onFocus(), this);
        this._onFocus();

        this._dbus = Gio.DBusExportedObject.wrapJSObject(INTERFACE, this);
        try {
            this._dbus.export(Gio.DBus.session, PATH);
        } catch (e) {
            console.warn('gprdock: a ponte com o navegador não subiu', e);
            this._dbus = null;
        }
    }

    _onFocus() {
        const window = global.display.focus_window;
        // O foco passa por "nenhuma janela" no meio de uma troca: não conta.
        if (!window || window.get_id() === this._focus?.id)
            return;
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        this._previous = this._focus;
        this._focus = {
            id: window.get_id(),
            webApp: isWebApp(app?.get_id() ?? ''),
            pid: window.get_pid(),
            workspace: window.get_workspace()?.index() ?? -1,
        };
        this._changedAt = now();
    }

    // De onde partiu o clique: o app web em foco ou, se o navegador acabou
    // de tomar o foco, o que estava em foco até então.
    _clickedFrom() {
        if (this._focus?.webApp)
            return this._focus;
        if (this._previous?.webApp && now() - this._changedAt < CLICK_TIME)
            return this._previous;
        return null;
    }

    Query() {
        const from = this._clickedFrom();
        if (!from || from.workspace < 0) {
            this._origin = null;
            return JSON.stringify({origin: null});
        }
        this._origin = {workspace: from.workspace, at: now()};
        const workspace = global.workspace_manager.get_workspace_by_index(from.workspace);
        const tracker = Shell.WindowTracker.get_default();
        // Janelas do mesmo navegador (o processo é um só) naquela área de
        // trabalho, fora os apps web; a usada por último primeiro.
        const windows = global.get_window_actors().map(actor => actor.meta_window)
            .filter(w => w.get_pid() === from.pid && !w.skip_taskbar &&
                w.get_window_type() === Meta.WindowType.NORMAL &&
                workspace && w.located_on_workspace(workspace) &&
                !isWebApp(tracker.get_window_app(w)?.get_id() ?? ''))
            .sort((a, b) => b.get_user_time() - a.get_user_time())
            .map(w => ({id: w.get_id(), title: w.get_title() ?? ''}));
        // Onde a aba caiu, pelo foco (o navegador traz para a frente a
        // janela que a recebeu): 'here', numa janela desta área de trabalho;
        // 'away', em outra; 'app', o foco ainda não saiu do app web.
        const landed = this._focus === from ? 'app'
            : windows.some(w => w.id === this._focus?.id) ? 'here' : 'away';
        return JSON.stringify({origin: from.workspace, landed, windows});
    }

    // Volta para a área de trabalho do clique; com uma janela (o id que a
    // Query deu), ela vem para a frente.
    Settle(id) {
        // A extensão pode chamar mais de uma vez (ver lá): vale enquanto o
        // prazo da pergunta não vencer.
        const origin = this._origin;
        if (!origin || now() - origin.at > SETTLE_TIME)
            return false;
        const window = id ? global.get_window_actors().map(actor => actor.meta_window)
            .find(w => w.get_id() === id) : null;
        if (window)
            Main.activateWindow(window);
        else
            global.workspace_manager.get_workspace_by_index(origin.workspace)
                ?.activate(global.get_current_time());
        return true;
    }

    destroy() {
        global.display.disconnectObject(this);
        this._dbus?.unexport();
        this._dbus = null;
    }
}
