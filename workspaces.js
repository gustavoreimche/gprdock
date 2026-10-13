import Gio from 'gi://Gio';

// Liga cada perfil a uma área de trabalho: perfil N <-> área N. Trocar um
// troca o outro, então as janelas de um perfil saem da frente ao mudar.
//
// Isso exige áreas de trabalho fixas: com as dinâmicas o GNOME apaga as que
// ficam vazias e as demais mudariam de número. Os valores originais ficam
// guardados e voltam quando a extensão é desligada.
export class WorkspaceSync {
    constructor(settings, profiles) {
        this._settings = settings;
        this._profiles = profiles;
        this._mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        this._manager = global.workspace_manager;

        if (!this._settings.get_string('saved-workspace-settings')) {
            this._settings.set_string('saved-workspace-settings', JSON.stringify({
                dynamic: this._mutter.get_boolean('dynamic-workspaces'),
                count: this._wm.get_int('num-workspaces'),
            }));
        }
        this._mutter.set_boolean('dynamic-workspaces', false);
        this._ensureCount();

        this._listener = this._profiles.connect(
            (event, data) => this._onProfileEvent(event, data));
        this._manager.connectObject('active-workspace-changed',
            () => this._followWorkspace(), this);

        // Na entrada, quem manda é a área de trabalho que já está na tela.
        this._followWorkspace();
    }

    // Cria as áreas na hora (a chave do GSettings só é aplicada depois, e a
    // troca de perfil que vem em seguida precisa da área já existindo).
    _ensureCount() {
        while (this._manager.get_n_workspaces() < this._profiles.count)
            this._manager.append_new_workspace(false, global.get_current_time());

        const count = this._manager.get_n_workspaces();
        if (this._wm.get_int('num-workspaces') !== count)
            this._wm.set_int('num-workspaces', count);
    }

    _activate(index) {
        const workspace = this._manager.get_workspace_by_index(index);
        if (workspace && workspace !== this._manager.get_active_workspace())
            workspace.activate(global.get_current_time());
    }

    _followWorkspace() {
        if (this._reordering)
            return;
        const index = this._manager.get_active_workspace_index();
        // Áreas além do último perfil ficam com o perfil que já estava ativo.
        if (index < this._profiles.count)
            this._profiles.switchTo(index);
    }

    _onProfileEvent(event, data) {
        if (event === 'added') {
            this._ensureCount();
        } else if (event === 'switched') {
            this._activate(this._profiles.index);
        } else if (event === 'removed') {
            this._closeGap(data.index);
            this._activate(this._profiles.index);
        } else if (event === 'reordered') {
            this._reorder(data.order);
        }
    }

    // Os perfis mudaram de ordem: cada área de trabalho vai junto com o seu,
    // com as janelas. A que está na tela continua na tela.
    _reorder(order) {
        const workspaces = order.map(from => this._manager.get_workspace_by_index(from));
        this._reordering = true;
        workspaces.forEach((workspace, to) => {
            if (workspace)
                this._manager.reorder_workspace(workspace, to);
        });
        this._reordering = false;
    }

    // O perfil saiu: suas janelas vão para o perfil que ficou ativo e as das
    // áreas seguintes descem uma posição, para continuar com o mesmo perfil.
    _closeGap(removed) {
        for (const actor of global.get_window_actors()) {
            const window = actor.meta_window;
            if (window.is_on_all_workspaces())
                continue;

            const index = window.get_workspace().index();
            if (index === removed)
                window.change_workspace_by_index(this._profiles.index, false);
            else if (index > removed)
                window.change_workspace_by_index(index - 1, false);
        }

        const count = this._wm.get_int('num-workspaces');
        this._wm.set_int('num-workspaces', Math.max(this._profiles.count, count - 1));
    }

    // restore=false ao bloquear a tela: a extensão é religada no desbloqueio
    // e as áreas precisam continuar onde estavam.
    destroy(restore) {
        this._profiles.disconnect(this._listener);
        this._manager.disconnectObject(this);

        if (!restore)
            return;

        try {
            const saved = JSON.parse(this._settings.get_string('saved-workspace-settings'));
            this._wm.set_int('num-workspaces', saved.count);
            this._mutter.set_boolean('dynamic-workspaces', saved.dynamic);
        } catch {
            // Sem valores guardados: não há o que devolver.
        }
        this._settings.set_string('saved-workspace-settings', '');
    }
}
