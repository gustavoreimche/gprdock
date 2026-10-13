import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

// Abre a visão geral (a da tecla Super) mostrando só as janelas de um app,
// para escolher uma delas. O filtro é uma troca temporária da função que a
// visão geral usa para decidir quais janelas mostrar; ao sair dela, volta
// tudo ao normal.
export class AppSpread {
    constructor() {
        this._injections = new InjectionManager();
        this._app = null;
        this._windows = [];
    }

    // Segundo clique no mesmo app fecha a visão.
    toggle(app, windows) {
        const same = this._app === app;
        if (Main.overview.visible)
            Main.overview.hide();
        if (!same)
            this._show(app, windows);
    }

    _show(app, windows) {
        this._end();
        this._app = app;
        this._windows = windows;

        const spread = this;
        this._injections.overrideMethod(Workspace.Workspace.prototype, '_isOverviewWindow',
            original => function (window) {
                return original.call(this, window) && spread._windows.includes(window);
            });
        this._injections.overrideMethod(
            WorkspaceThumbnail.WorkspaceThumbnail.prototype, '_isOverviewWindow',
            original => function (actor) {
                return original.call(this, actor) && spread._windows.includes(actor.metaWindow);
            });

        Main.overview.connectObject('hidden', () => this._end(), this);
        // Fechou janelas dentro da visão e sobrou uma só: não há o que escolher.
        app.connectObject('windows-changed', () => {
            const open = app.get_windows();
            this._windows = this._windows.filter(w => open.includes(w));
            if (this._windows.length <= 1)
                Main.overview.hide();
        }, this);

        Main.overview.show();
    }

    _end() {
        if (!this._app)
            return;
        this._injections.clear();
        Main.overview.disconnectObject(this);
        this._app.disconnectObject(this);
        this._app = null;
        this._windows = [];
    }

    destroy() {
        this._end();
    }
}
