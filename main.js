import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AutoProfile} from './autoProfile.js';
import {Dock} from './dock.js';
import {LinkBridge} from './linkBridge.js';
import {Profiles} from './profiles.js';
import {WorkspaceSync} from './workspaces.js';

// O dock em si. Quem cria e destrói isto é o extension.js, que só carrega o
// código (ver lá por quê).
export class GprDock {
    constructor(extension, version) {
        this._extension = extension;
        this._version = version;
    }

    enable() {
        this._settings = this._extension.getSettings();
        this._profiles = new Profiles(this._settings);
        this._docks = [];
        this._settings.connectObject('changed::all-monitors', () => this._syncDocks(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._syncDocks(), this);
        this._syncDocks();

        this._autoProfile = new AutoProfile(this._settings, this._profiles);
        this._links = new LinkBridge();

        this._settings.connectObject('changed::bind-workspaces',
            () => this._syncWorkspaceBinding(), this);
        this._syncWorkspaceBinding();
    }

    // Um dock no monitor principal ou, com "em todos os monitores", um em
    // cada. Refeitos quando os monitores mudam.
    _syncDocks() {
        const monitors = Main.layoutManager.monitors;
        const wanted = this._settings.get_boolean('all-monitors')
            ? monitors.map((_m, index) => index) : [null];
        const key = wanted.join(',');
        if (key === this._docksKey)
            return;
        this._docksKey = key;
        this._docks.forEach(dock => dock.destroy());
        this._docks = wanted.map(index => new Dock(this._settings, this._profiles,
            this._extension.path, () => this._extension.openPreferences(), index));
    }

    _syncWorkspaceBinding() {
        const wanted = this._settings.get_boolean('bind-workspaces');
        if (wanted && !this._workspaces) {
            this._workspaces = new WorkspaceSync(this._settings, this._profiles);
        } else if (!wanted && this._workspaces) {
            this._workspaces.destroy(true);
            this._workspaces = null;
        }
    }

    disable() {
        // Ao bloquear a tela ou ao recarregar o código (./reload.sh), a
        // extensão volta em seguida: as áreas de trabalho ficam como estão.
        const reloading = this._settings.get_string('code-version') !== this._version;
        const comingBack = Main.sessionMode.isLocked || reloading;

        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._workspaces?.destroy(!comingBack);
        this._workspaces = null;
        this._autoProfile?.destroy();
        this._autoProfile = null;
        this._links?.destroy();
        this._links = null;
        this._docks?.forEach(dock => dock.destroy());
        this._docks = [];
        this._docksKey = null;
        this._profiles?.destroy();
        this._profiles = null;
        this._settings = null;
    }
}
