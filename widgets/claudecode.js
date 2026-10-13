import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Widget, readFile} from './base.js';
import {customWidgetFor} from './custom.js';
import {registerClass} from '../registerClass.js';

const REFRESH_SECONDS = 4;
const LISTED = 12;
const STATES = {
    waiting: {mark: '●', label: 'esperando você', order: 0},
    busy: {mark: '◐', label: 'trabalhando', order: 1},
    idle: {mark: '○', label: 'parada', order: 2},
};

function ago(time) {
    const minutes = Math.floor((Date.now() - time) / 60000);
    if (minutes < 1)
        return 'agora';
    if (minutes < 60)
        return `há ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `há ${hours} h` : `há ${Math.floor(hours / 24)} d`;
}

// Processo pai, pelo /proc. O nome do processo vem entre parênteses e pode
// ter espaços: o que interessa está depois do último ')'.
function parentOf(pid) {
    try {
        const [, contents] = GLib.file_get_contents(`/proc/${pid}/stat`);
        const stat = new TextDecoder().decode(contents);
        return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || 0;
    } catch {
        return 0;
    }
}

// As sessões do Claude Code que rodam no terminal: quantas estão trabalhando
// e quais pararam para esperar por você. O clique numa sessão traz o terminal
// dela para a frente. As que pertencem aos clients de IA ficam de fora: esses
// têm o widget deles.
export const ClaudeCodeWidget = registerClass(
class ClaudeCodeWidget extends Widget {
    setup() {
        this._sessions = [];
        this._run = 0;
        this.createPanel({wide: true});
        this._update();
        this.every(REFRESH_SECONDS, () => this._update());
        global.display.connectObject('notify::focus-window', () => this.refresh(), this);
    }

    // Janela de onde a sessão roda: a de um processo acima dela. Sem janela
    // (tmux, ssh, segundo plano), não há o que focar.
    _windowOf(pid, windows) {
        for (let p = pid, hops = 0; p > 1 && hops < 24; p = parentOf(p), hops++) {
            if (windows.has(p))
                return windows.get(p);
        }
        return null;
    }

    async _read() {
        const home = GLib.get_home_dir();
        const sessions = [];
        let configs = [];
        try {
            const dir = GLib.Dir.open(home, 0);
            for (let name = dir.read_name(); name !== null; name = dir.read_name()) {
                if (/^\.claude(-[\w.-]+)?$/.test(name))
                    configs.push(name);
            }
            dir.close();
        } catch {
            configs = ['.claude'];
        }

        for (const config of configs.sort()) {
            const folder = GLib.build_filenamev([home, config, 'sessions']);
            let names = [];
            try {
                const dir = GLib.Dir.open(folder, 0);
                for (let name = dir.read_name(); name !== null; name = dir.read_name())
                    names.push(name);
                dir.close();
            } catch {
                names = [];
            }
            for (const name of names.filter(n => n.endsWith('.json'))) {
                try {
                    const session = JSON.parse(await readFile(
                        GLib.build_filenamev([folder, name]), this.cancellable));
                    if (session?.sessionId && session.kind === 'interactive' &&
                        GLib.file_test(`/proc/${session.pid}`, GLib.FileTest.EXISTS))
                        sessions.push({...session, account: config.replace(/^\.claude-?/, '')});
                } catch {
                    // Arquivo sendo regravado, ou o widget foi destruído.
                }
            }
        }
        return sessions;
    }

    async _update() {
        const run = ++this._run;
        const found = await this._read();
        if (run !== this._run || this.cancellable.is_cancelled())
            return;

        const tracker = Shell.WindowTracker.get_default();
        const windows = new Map();
        for (const actor of global.get_window_actors()) {
            const window = actor.meta_window;
            if (window.get_pid() > 0 && !windows.has(window.get_pid()))
                windows.set(window.get_pid(), window);
        }

        this._sessions = found.map(session => {
            const window = this._windowOf(session.pid, windows);
            const app = window ? tracker.get_window_app(window) : null;
            return {
                id: session.sessionId,
                name: session.name || GLib.path_get_basename(session.cwd ?? '') || 'sessão',
                folder: (session.cwd ?? '').replace(GLib.get_home_dir(), '~'),
                account: session.account,
                state: STATES[session.status] ? session.status : 'idle',
                time: Number(session.statusUpdatedAt) || Number(session.updatedAt) || 0,
                window,
                client: app ? customWidgetFor(app) : null,
            };
        }).filter(session => !session.client)
            .sort((a, b) => STATES[a.state].order - STATES[b.state].order || b.time - a.time);
        this.refresh();
    }

    onMiddleClick() {
        const session = this._sessions.find(s => s.window);
        if (session)
            Main.activateWindow(session.window);
        return Boolean(session);
    }

    refresh() {
        const sessions = this._sessions;
        const focus = global.display.focus_window;
        const working = sessions.filter(s => s.state === 'busy').length;
        const waiting = sessions.filter(s => s.state === 'waiting');
        // Quem espera numa janela que já está na sua frente não precisa chamar.
        const attention = waiting.filter(s => !s.window || s.window !== focus).length;

        this.display({
            icon: 'utilities-terminal-symbolic',
            caption: sessions.length === 1 ? 'Claude Code · 1 sessão'
                : `Claude Code · ${sessions.length} sessões`,
            value: sessions.length === 0 ? 'Nenhuma sessão'
                : waiting.length > 0 ? `${waiting.length} esperando você`
                    : working > 0 ? `${working} trabalhando` : 'Tudo parado',
            short: sessions.length === 0 ? '—'
                : waiting.length > 0 ? `${waiting.length} ●` : `${working || sessions.length}`,
        });
        for (const [name, on] of [['gprdock-ai-off', sessions.length === 0],
            ['gprdock-ai-attention', attention > 0],
            ['gprdock-state-working', attention === 0 && working > 0]]) {
            if (on)
                this.add_style_class_name(name);
            else
                this.remove_style_class_name(name);
        }

        const lines = [['Claude Code no terminal', 'gprdock-panel-title']];
        if (sessions.length === 0)
            lines.push(['Nenhuma sessão aberta']);
        for (const session of sessions.slice(0, LISTED)) {
            const state = STATES[session.state];
            const where = [session.account, session.folder].filter(Boolean).join(' · ');
            lines.push([
                `${state.mark}  ${session.name} · ${state.label}` +
                    `${session.time ? ` ${ago(session.time)}` : ''}\n     ${where}` +
                    `${session.window ? '' : ' · sem janela'}`,
                'gprdock-panel-text',
                session.window ? () => Main.activateWindow(session.window) : null,
            ]);
        }
        if (sessions.length > LISTED)
            lines.push([`… e mais ${sessions.length - LISTED}`]);
        this.setPanelLines(lines);
    }

    onDestroy() {
        global.display.disconnectObject(this);
    }
});
