import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Widget, isCancelled} from './base.js';
import {registerClass} from '../registerClass.js';

const REFRESH_SECONDS = 10;
const LISTED = 24;
const FORMAT = ['.ID', '.Names', '.State', '.Status', '.Image',
    '.Label "com.docker.compose.project"'].map(field => `{{${field}}}`).join('\t');

// Roda o docker e devolve a saída; rejeita com a mensagem de erro dele.
function docker(args, cancellable) {
    return new Promise((resolve, reject) => {
        let process = null;
        try {
            process = Gio.Subprocess.new(['docker', ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            reject(new Error('O comando docker não foi encontrado'));
            return;
        }
        process.communicate_utf8_async(null, cancellable, (source, result) => {
            try {
                const [, stdout, stderr] = source.communicate_utf8_finish(result);
                if (source.get_successful())
                    resolve(stdout);
                else
                    reject(new Error(stderr.trim().split('\n').at(-1) || 'O docker falhou'));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Contêineres do Docker: quantos estão rodando e, no painel, a lista por
// projeto do Compose, com iniciar, parar e reiniciar.
export const DockerWidget = registerClass(
class DockerWidget extends Widget {
    onMiddleClick() {
        return this.launchApp('docker-desktop.desktop');
    }

    setup() {
        this._containers = [];
        this._error = null;
        this._busy = new Set();     // contêineres com uma ação em curso
        const panel = this.createPanel();
        // Com o painel aberto a lista não é refeita (fecharia o submenu em
        // que o cursor está); ao fechar, ela é atualizada.
        panel.connect('open-state-changed', (_menu, open) => {
            if (!open)
                this._buildPanel();
        });

        this._fetch();
        this.every(REFRESH_SECONDS, () => this._fetch());
    }

    async _fetch() {
        try {
            const output = await docker(['ps', '-a', '--format', FORMAT], this.cancellable);
            this._containers = output.split('\n').filter(Boolean).map(line => {
                const [id, name, state, status, image, project] = line.split('\t');
                return {id, name, state, status, image, project: project || ''};
            });
            this._error = null;
        } catch (e) {
            if (isCancelled(e))
                return;
            this._containers = [];
            this._error = e.message;
        }
        this.refresh();
    }

    refresh() {
        const running = this._containers.filter(c => c.state === 'running').length;
        const total = this._containers.length;
        this.display({
            icon: 'package-x-generic-symbolic',
            caption: 'Docker',
            value: this._error ? 'Indisponível' : `${running} rodando · ${total} no total`,
            short: this._error ? '—' : `${running}`,
        });
        if (!this._panel.isOpen)
            this._buildPanel();
    }

    _buildPanel() {
        const panel = this._panel;
        panel.removeAll();
        const note = text => panel.addMenuItem(
            new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false}));

        if (this._error) {
            note(`Docker indisponível: ${this._error}`);
            return;
        }
        if (this._containers.length === 0) {
            note('Nenhum contêiner');
            return;
        }

        // Por projeto do Compose; dentro de cada um, os que rodam primeiro.
        const projects = new Map();
        for (const container of this._containers.slice(0, LISTED)) {
            if (!projects.has(container.project))
                projects.set(container.project, []);
            projects.get(container.project).push(container);
        }

        for (const [project, containers] of projects) {
            containers.sort((a, b) =>
                (b.state === 'running') - (a.state === 'running') || a.name.localeCompare(b.name));
            panel.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(project || 'Sem projeto'));

            for (const container of containers) {
                const up = container.state === 'running';
                const item = new PopupMenu.PopupSubMenuMenuItem(
                    `${up ? '●' : '○'}  ${container.name}`);
                item.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                    `${container.status} · ${container.image}`, {reactive: false, can_focus: false}));
                if (up) {
                    item.menu.addAction('Parar', () => this._act('stop', [container]));
                    item.menu.addAction('Reiniciar', () => this._act('restart', [container]));
                } else {
                    item.menu.addAction('Iniciar', () => this._act('start', [container]));
                }
                panel.addMenuItem(item);
            }

            // Só faz sentido para um grupo de verdade.
            if (project && containers.length > 1) {
                const stopped = containers.filter(c => c.state !== 'running');
                const up = containers.filter(c => c.state === 'running');
                if (stopped.length > 0)
                    panel.addAction(`Iniciar todos de ${project}`, () => this._act('start', stopped));
                if (up.length > 0)
                    panel.addAction(`Parar todos de ${project}`, () => this._act('stop', up));
            }
        }

        if (this._containers.length > LISTED)
            note(`… e mais ${this._containers.length - LISTED}`);
    }

    async _act(action, containers) {
        const targets = containers.filter(c => !this._busy.has(c.id));
        if (targets.length === 0)
            return;
        targets.forEach(c => this._busy.add(c.id));
        try {
            await docker([action, ...targets.map(c => c.id)], this.cancellable);
        } catch (e) {
            if (!isCancelled(e)) {
                Main.notify('Docker',
                    `Não foi possível ${{start: 'iniciar', stop: 'parar', restart: 'reiniciar'}[action]}` +
                    ` ${targets.map(c => c.name).join(', ')}: ${e.message}`);
            }
        } finally {
            targets.forEach(c => this._busy.delete(c.id));
        }
        this._fetch();
    }
});
