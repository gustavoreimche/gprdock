import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const POLL_SECONDS = 3;

// Quantos avisos cada app tem pendentes, para o número no ícone. Junta três
// fontes, porque cada app avisa de um jeito:
//   - as notificações dele que ainda estão na lista do GNOME;
//   - o contador que o próprio app publica (Telegram, Thunderbird e outros
//     usam a interface de lançador do Unity);
//   - o "(3)" que apps web põem no título da janela (WhatsApp, Teams).
export class Badges {
    constructor(onChange) {
        this._onChange = onChange;
        this._counts = new Map();       // id do app -> número
        this._launcher = new Map();     // id do app -> número publicado pelo app
        this._tracker = Shell.WindowTracker.get_default();

        Main.messageTray.connectObject(
            'source-added', (_tray, source) => this._watch(source),
            'source-removed', () => this._update(), this);
        Main.messageTray.getSources().forEach(source => this._watch(source));

        this._launcherId = Gio.DBus.session.signal_subscribe(null,
            'com.canonical.Unity.LauncherEntry', 'Update', null, null,
            Gio.DBusSignalFlags.NONE, (_c, _sender, _path, _iface, _signal, params) => {
                const [uri, props] = params.recursiveUnpack();
                const id = `${uri}`.replace(/^application:\/\//, '');
                if ('count' in props || 'count-visible' in props) {
                    const previous = this._launcher.get(id) ?? {count: 0, visible: false};
                    this._launcher.set(id, {
                        count: Number(props.count ?? previous.count),
                        visible: props['count-visible'] ?? previous.visible,
                    });
                    this._update();
                }
            });

        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
        this._update();
    }

    count(app) {
        return this._counts.get(app.get_id()) ?? 0;
    }

    _watch(source) {
        source.connectObject('notify::count', () => this._update(), this);
        this._update();
    }

    _sourceApp(source) {
        const app = source.app ?? source._app;
        if (app?.get_id)
            return app.get_id();
        // 'generic' é a política de quem não tem app: avisos do próprio shell.
        const id = source.policy?.id;
        return id && id !== 'generic' ? `${id}.desktop` : null;
    }

    _update() {
        const counts = new Map();
        const add = (id, n) => {
            if (id && n > 0)
                counts.set(id, Math.max(counts.get(id) ?? 0, n));
        };

        for (const source of Main.messageTray.getSources())
            add(this._sourceApp(source), source.count);
        for (const [id, entry] of this._launcher)
            add(id, entry.visible ? entry.count : 0);

        // Títulos: soma das janelas de cada app.
        const titles = new Map();
        for (const actor of global.get_window_actors()) {
            const window = actor.meta_window;
            const n = Number(window.get_title()?.match(/^\((\d+)\+?\)/)?.[1] ?? 0);
            const id = n > 0 ? this._tracker.get_window_app(window)?.get_id() : null;
            if (id)
                titles.set(id, (titles.get(id) ?? 0) + n);
        }
        titles.forEach((n, id) => add(id, n));

        const before = [...this._counts].sort().join();
        this._counts = counts;
        if ([...counts].sort().join() !== before)
            this._onChange();
    }

    destroy() {
        Main.messageTray.disconnectObject(this);
        Main.messageTray.getSources().forEach(source => source.disconnectObject(this));
        Gio.DBus.session.signal_unsubscribe(this._launcherId);
        GLib.source_remove(this._pollId);
    }
}
