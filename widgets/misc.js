import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Widget, readFile} from './base.js';
import {registerClass} from '../registerClass.js';

const NETWORK_INTERVAL = 2;

function rate(bytesPerSecond) {
    const units = ['B/s', 'kB/s', 'MB/s', 'GB/s'];
    let value = bytesPerSecond;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    const digits = unit > 0 && value < 10 ? 1 : 0;
    return `${value.toFixed(digits).replace('.', ',')} ${units[unit]}`;
}

// O que está descendo e subindo agora, somando as interfaces reais.
// Uma linha vertical para separar grupos no dock. Entra pelo menu do ícone
// de apps; arrasta-se e tira-se como qualquer widget.
export const SeparatorWidget = registerClass(
class SeparatorWidget extends Widget {
    get title() {
        return 'Separador';
    }

    setSize(size) {
        super.setSize(size);
        const tile = this._dock.tileSize;
        // Estreito, mas com folga dos lados para dar onde clicar e arrastar.
        this.style = `height: ${tile}px; width: 15px;`;
    }

    build() {
        return new St.Widget({
            style_class: 'gprdock-separator',
            style: `height: ${Math.round(this._dock.tileSize * 0.6)}px;`,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
    }

    refresh() {
    }

    onClick() {
    }
});

export const NetworkWidget = registerClass(
class NetworkWidget extends Widget {
    onMiddleClick() {
        return this.launchApp('gnome-wifi-panel.desktop', 'gnome-network-panel.desktop');
    }

    setup() {
        this._last = null;
        this._down = 0;
        this._up = 0;
        this._update();
        this.every(NETWORK_INTERVAL, () => this._update());
    }

    async _update() {
        let text = '';
        try {
            text = await readFile('/proc/net/dev', this.cancellable);
        } catch {
            return;
        }

        let received = 0;
        let sent = 0;
        for (const line of text.split('\n').slice(2)) {
            const [name, rest] = line.split(':');
            if (!rest || name.trim() === 'lo')
                continue;
            const fields = rest.trim().split(/\s+/).map(Number);
            received += fields[0];
            sent += fields[8];
        }

        const time = Date.now();
        if (this._last) {
            const seconds = (time - this._last.time) / 1000;
            this._down = Math.max(0, (received - this._last.received) / seconds);
            this._up = Math.max(0, (sent - this._last.sent) / seconds);
        }
        this._last = {time, received, sent};
        this.refresh();
    }

    refresh() {
        this.display({
            icon: 'network-transmit-receive-symbolic',
            caption: `↑ ${rate(this._up)}`,
            value: `↓ ${rate(this._down)}`,
            short: rate(this._down).replace(' ', '').replace('/s', ''),
        });
    }
});

// Um recado que fica no dock. Clicar abre um campo para editar ali mesmo:
// Enter salva, Esc desiste.
export const NoteWidget = registerClass(
class NoteWidget extends Widget {
    setup() {
        const panel = this.createPanel();
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        // Não pode se chamar _entry: o dock usa esse nome em todo item.
        this._noteEntry = new St.Entry({
            style_class: 'gprdock-note-entry',
            hint_text: 'Escreva a nota e tecle Enter',
            can_focus: true,
            x_expand: true,
        });
        item.add_child(this._noteEntry);
        panel.addMenuItem(item);

        this._noteEntry.clutter_text.connect('activate', () => {
            this._settings.set_string('note-text', this._noteEntry.text.trim());
            panel.close();
        });
        panel.connect('open-state-changed', (_menu, open) => {
            if (!open)
                return;
            this._noteEntry.text = this._settings.get_string('note-text');
            this._noteEntry.grab_key_focus();
        });

        this._settings.connectObject('changed::note-text', () => this.refresh(), this);
    }

    refresh() {
        const text = this._settings.get_string('note-text').trim();
        this.display({
            icon: 'document-edit-symbolic',
            caption: 'Nota',
            value: text || 'Clique para escrever',
            short: '',
        });
    }

    onDestroy() {
        this._settings.disconnectObject(this);
    }
});

// Copos de água do dia. Clique soma um; clique direito tira um.
export const WaterWidget = registerClass(
class WaterWidget extends Widget {
    setup() {
        this._settings.connectObject(
            'changed::water-goal', () => this.refresh(),
            'changed::water-state', () => this.refresh(), this);
        this.every(60, () => this.refresh());
    }

    _count() {
        try {
            const state = JSON.parse(this._settings.get_string('water-state'));
            return state.day === new Date().toDateString() ? Number(state.count) || 0 : 0;
        } catch {
            return 0;
        }
    }

    _set(count) {
        this._settings.set_string('water-state', JSON.stringify({
            day: new Date().toDateString(),
            count: Math.max(0, count),
        }));
    }

    refresh() {
        const count = this._count();
        const goal = this._settings.get_int('water-goal');
        this.display({
            ring: Math.min(1, count / goal),
            ringText: `${count}`,
            caption: 'Água',
            value: `${count} de ${goal} copos`,
        });
    }

    onClick() {
        this._set(this._count() + 1);
    }

    onSecondaryClick() {
        this._set(this._count() - 1);
    }

    onDestroy() {
        this._settings.disconnectObject(this);
    }
});
