import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Este arquivo só carrega o resto. O GNOME Shell lê o código de uma extensão
// uma vez e o guarda em memória pelo endereço do arquivo, então normalmente
// só sair da sessão faz valer uma mudança. Para recarregar sem isso, o
// ./reload.sh grava uma "versão" nova nas configurações e religa a extensão;
// aqui o código é importado por um link simbólico com essa versão no nome, e
// o endereço novo faz o shell ler tudo de novo.
//
// Só o que está neste arquivo continua exigindo sair da sessão para mudar.
export default class GprDockExtension extends Extension {
    enable() {
        this._enabled = true;

        // Sem isso a sessão abre na visão geral, com o dock escondido.
        if (Main.layoutManager._startingUp && Main.sessionMode.hasOverview) {
            Main.sessionMode.hasOverview = false;
            this._startupId = Main.layoutManager.connect('startup-complete', () => {
                Main.sessionMode.hasOverview = true;
                Main.layoutManager.disconnect(this._startupId);
                this._startupId = 0;
            });
        }

        const version = this._version();
        this._import(version).then(module => {
            // A extensão pode ter sido desligada enquanto o código carregava.
            if (!this._enabled)
                return;
            this._app = new module.GprDock(this, version);
            this._app.enable();
        }).catch(e => console.error('gprdock: o código não carregou', e));
    }

    _version() {
        const version = this.getSettings().get_string('code-version');
        return /^[0-9A-Za-z_-]+$/.test(version) ? version : '';
    }

    _import(version) {
        if (!version)
            return import('./main.js');

        const cache = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gprdock']);
        GLib.mkdir_with_parents(cache, 0o700);
        const name = `v-${version}`;

        // Links de versões anteriores não servem mais para nada.
        const dir = GLib.Dir.open(cache, 0);
        for (let entry = dir.read_name(); entry !== null; entry = dir.read_name()) {
            if (entry.startsWith('v-') && entry !== name)
                GLib.unlink(GLib.build_filenamev([cache, entry]));
        }
        dir.close();

        const link = GLib.build_filenamev([cache, name]);
        if (!GLib.file_test(link, GLib.FileTest.EXISTS))
            Gio.File.new_for_path(link).make_symbolic_link(this.path, null);
        return import(`file://${link}/main.js`);
    }

    disable() {
        this._enabled = false;
        if (this._startupId) {
            Main.layoutManager.disconnect(this._startupId);
            Main.sessionMode.hasOverview = true;
            this._startupId = 0;
        }

        this._app?.disable();
        this._app = null;
    }
}
