import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Widget} from './base.js';
import {registerClass} from '../registerClass.js';

// Listas guardadas em GSettings como JSON; devolve [] se o valor não servir.
export function readList(settings, key) {
    try {
        const list = JSON.parse(settings.get_string(key));
        return Array.isArray(list) ? list.filter(item => item && typeof item === 'object') : [];
    } catch {
        return [];
    }
}

function copy(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}

// ---------- Favoritos: sites a um clique ----------

export const BookmarksWidget = registerClass(
class BookmarksWidget extends Widget {
    setup() {
        this.createPanel();
        this._settings.connectObject('changed::bookmarks', () => this.refresh(), this);
    }

    refresh() {
        const bookmarks = readList(this._settings, 'bookmarks').filter(b => b.url);
        this.display({
            icon: 'user-bookmarks-symbolic',
            caption: 'Favoritos',
            value: bookmarks.length > 0
                ? bookmarks.map(b => b.name || b.url).join(' · ') : 'Nenhum site',
            short: `${bookmarks.length}`,
        });

        const lines = [['Favoritos', 'gprdock-panel-title']];
        if (bookmarks.length === 0)
            lines.push(['Adicione sites em Configurações › Conteúdo']);
        for (const bookmark of bookmarks) {
            const url = /^[a-z]+:\/\//i.test(bookmark.url) ? bookmark.url : `https://${bookmark.url}`;
            lines.push([bookmark.name || bookmark.url, 'gprdock-panel-text', () => this.openUri(url)]);
        }
        this.setPanelLines(lines);
    }

    onDestroy() {
        this._settings.disconnectObject(this);
    }
});

// ---------- Atalho: roda um comando seu ----------

// Com um atalho só, o clique já o dispara; com vários, abre a lista.
export const ShortcutsWidget = registerClass(
class ShortcutsWidget extends Widget {
    setup() {
        this.createPanel();
        this._settings.connectObject('changed::shortcuts', () => this.refresh(), this);
    }

    _shortcuts() {
        return readList(this._settings, 'shortcuts').filter(s => s.command);
    }

    refresh() {
        const shortcuts = this._shortcuts();
        this.display({
            icon: 'utilities-terminal-symbolic',
            caption: shortcuts.length === 1 ? 'Atalho' : 'Atalhos',
            value: shortcuts.length > 0
                ? shortcuts.map(s => s.name || s.command).join(' · ') : 'Nenhum atalho',
            short: shortcuts.length === 1 ? '' : `${shortcuts.length}`,
        });

        const lines = [['Atalhos', 'gprdock-panel-title']];
        if (shortcuts.length === 0)
            lines.push(['Crie atalhos em Configurações › Conteúdo']);
        for (const shortcut of shortcuts) {
            lines.push([shortcut.name || shortcut.command, 'gprdock-panel-text',
                () => this._run(shortcut)]);
        }
        this.setPanelLines(lines);
    }

    _run(shortcut) {
        try {
            Gio.Subprocess.new(['/bin/sh', '-c', shortcut.command], Gio.SubprocessFlags.NONE);
        } catch (e) {
            Main.notify('Atalho não rodou', `${shortcut.name || shortcut.command}: ${e.message}`);
        }
    }

    onClick() {
        const shortcuts = this._shortcuts();
        if (shortcuts.length === 1)
            this._run(shortcuts[0]);
        else
            this._panel.toggle();
    }

    onDestroy() {
        this._settings.disconnectObject(this);
    }
});

// ---------- Coleção: um ícone que guarda um grupo de apps ----------

// O widget é 'collection@<id>': cada coleção criada nas configurações vira um
// item próprio do dock.
export const CollectionWidget = registerClass(
class CollectionWidget extends Widget {
    setup() {
        this.createPanel();
        this._grid = null;
        this._settings.connectObject('changed::collections', () => this.refresh(), this);
        Shell.AppSystem.get_default().connectObject(
            'installed-changed', () => this.refresh(), this);
    }

    get title() {
        return `Coleção: ${this._collection()?.name || 'sem nome'}`;
    }

    _collection() {
        return readList(this._settings, 'collections').find(c => c.id === this.widgetParam);
    }

    _apps() {
        const appSystem = Shell.AppSystem.get_default();
        return (this._collection()?.apps ?? [])
            .map(id => appSystem.lookup_app(id)).filter(Boolean);
    }

    // Quadrado: miniaturas dos quatro primeiros apps. Retângulo: as
    // miniaturas e o nome da coleção.
    build(size) {
        const tile = this._dock.tileSize;
        this._grid = new St.Widget({
            style_class: 'gprdock-collection-grid',
            layout_manager: new Clutter.GridLayout({
                column_spacing: 2,
                row_spacing: 2,
                column_homogeneous: true,
                row_homogeneous: true,
            }),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._grid.style = `width: ${tile - 14}px; height: ${tile - 14}px;`;
        this._name = null;
        if (size === 'square')
            return this._grid;

        const box = new St.BoxLayout({style_class: 'gprdock-tile gprdock-tile-wide'});
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'gprdock-tile-text',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._name = {
            caption: new St.Label({style_class: 'gprdock-tile-caption'}),
            value: new St.Label({style_class: 'gprdock-tile-value'}),
        };
        text.add_child(this._name.caption);
        text.add_child(this._name.value);
        box.add_child(this._grid);
        box.add_child(text);
        return box;
    }

    refresh() {
        const collection = this._collection();
        const apps = this._apps();

        if (this._grid) {
            this._grid.destroy_all_children();
            const side = Math.floor((this._dock.tileSize - 16) / 2);
            apps.slice(0, 4).forEach((app, i) => {
                this._grid.layout_manager.attach(
                    app.create_icon_texture(side), i % 2, Math.floor(i / 2), 1, 1);
            });
            if (apps.length === 0) {
                this._grid.layout_manager.attach(new St.Icon({
                    icon_name: 'folder-symbolic',
                    icon_size: side * 2,
                }), 0, 0, 2, 2);
            }
        }
        if (this._name) {
            this._name.caption.text = 'Coleção';
            this._name.value.text = collection?.name || 'Sem nome';
        }

        this._panel.removeAll();
        if (!collection) {
            this.setPanelLines([['Esta coleção foi removida']]);
            return;
        }
        this._panel.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(collection.name || 'Coleção'));
        for (const app of apps) {
            const item = new PopupMenu.PopupImageMenuItem(app.get_name(), app.get_icon());
            item.connect('activate', () => app.activate());
            this._panel.addMenuItem(item);
        }
        if (apps.length === 0) {
            this._panel.addMenuItem(new PopupMenu.PopupMenuItem(
                'Adicione apps em Configurações › Conteúdo', {reactive: false}));
        }
    }

    onDestroy() {
        this._settings.disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
    }
});

// ---------- Lembretes: uma lista curta, guardada no próprio dock ----------

// Não sincroniza com nenhum serviço. Clicar num lembrete o conclui.
export const RemindersWidget = registerClass(
class RemindersWidget extends Widget {
    setup() {
        const panel = this.createPanel();
        this._settings.connectObject('changed::reminders', () => this.refresh(), this);
        panel.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._newEntry?.grab_key_focus();
        });
    }

    _list() {
        return readList(this._settings, 'reminders').filter(r => r.text);
    }

    _save(list) {
        this._settings.set_string('reminders', JSON.stringify(list));
    }

    refresh() {
        const reminders = this._list();
        this.display({
            icon: 'checkbox-checked-symbolic',
            caption: reminders.length === 1 ? '1 lembrete' : `${reminders.length} lembretes`,
            value: reminders[0]?.text ?? 'Nada pendente',
            short: `${reminders.length}`,
        });

        this._panel.removeAll();
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._newEntry = new St.Entry({
            style_class: 'gprdock-note-entry',
            hint_text: 'Novo lembrete e Enter',
            can_focus: true,
            x_expand: true,
        });
        this._newEntry.clutter_text.connect('activate', () => {
            const text = this._newEntry.text.trim();
            if (text)
                this._save([...this._list(), {text}]);
        });
        item.add_child(this._newEntry);
        this._panel.addMenuItem(item);

        reminders.forEach((reminder, index) => {
            const row = new PopupMenu.PopupMenuItem(reminder.text);
            row.label.add_style_class_name('gprdock-panel-text');
            // Concluir tira da lista.
            row.connect('activate', () => this._save(this._list().filter((_r, i) => i !== index)));
            this._panel.addMenuItem(row);
        });
        // Refeito com o painel aberto (acabou de adicionar): o foco volta
        // ao campo, para digitar o próximo.
        if (this._panel.isOpen)
            this._newEntry.grab_key_focus();
    }

    onDestroy() {
        this._settings.disconnectObject(this);
    }
});

// ---------- Conversor de unidades ----------

// [fator para a unidade base, nomes aceitos...]; a primeira é a que aparece.
const UNITS = {
    Comprimento: [
        [0.001, 'mm'], [0.01, 'cm'], [1, 'm'], [1000, 'km'],
        [0.0254, 'pol', 'in', '"'], [0.3048, 'pés', 'ft', 'pé'], [1609.344, 'mi', 'milhas'],
    ],
    Peso: [
        [0.001, 'g'], [1, 'kg'], [1000, 't'], [0.45359237, 'lb', 'lbs'], [0.028349523, 'oz'],
    ],
    Dados: [
        [1, 'B'], [1e3, 'kB'], [1e6, 'MB'], [1e9, 'GB'], [1e12, 'TB'],
        [1024, 'KiB'], [1048576, 'MiB'], [1073741824, 'GiB'],
    ],
};
const TEMPERATURES = {
    c: ['°C', v => v, v => v],
    f: ['°F', v => (v - 32) * 5 / 9, v => v * 9 / 5 + 32],
    k: ['K', v => v - 273.15, v => v + 273.15],
};

function formatNumber(value) {
    if (!Number.isFinite(value))
        return '—';
    const abs = Math.abs(value);
    const digits = abs !== 0 && abs < 0.01 ? 6 : abs < 100 ? 3 : 1;
    return Number(value.toFixed(digits)).toLocaleString('pt-BR', {maximumFractionDigits: digits});
}

// "10 km" -> [['Comprimento'], ['10 000 m'], ...]; null se não entendeu.
export function convert(input) {
    const match = input.trim().replace(',', '.').match(/^(-?\d+(?:\.\d+)?)\s*(.+)$/);
    if (!match)
        return null;
    const value = Number(match[1]);
    const unit = match[2].trim().toLowerCase().replace(/^°/, '');

    const temperature = TEMPERATURES[unit[0]];
    if (temperature && ['c', 'f', 'k', 'celsius', 'fahrenheit', 'kelvin'].includes(unit)) {
        const celsius = temperature[1](value);
        return {
            kind: 'Temperatura',
            results: Object.values(TEMPERATURES)
                .filter(t => t !== temperature)
                .map(([symbol, , fromCelsius]) => `${formatNumber(fromCelsius(celsius))} ${symbol}`),
        };
    }

    for (const [kind, units] of Object.entries(UNITS)) {
        // Dados diferenciam maiúsculas (MB e Mb não são a mesma coisa, mas
        // aqui só há bytes): compara sem caixa, exceto se houver empate.
        const source = units.find(([, ...names]) => names.some(n => n.toLowerCase() === unit));
        if (!source)
            continue;
        const base = value * source[0];
        return {
            kind,
            results: units.filter(u => u !== source)
                .map(([factor, name]) => `${formatNumber(base / factor)} ${name}`),
        };
    }
    return null;
}

// Digite um valor com a unidade ("10 km", "72 f", "1,5 GB") e veja nas outras.
// Clicar num resultado copia.
export const ConverterWidget = registerClass(
class ConverterWidget extends Widget {
    setup() {
        this._input = '';
        const panel = this.createPanel();
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._inputEntry = new St.Entry({
            style_class: 'gprdock-note-entry',
            hint_text: 'Ex.: 10 km, 72 f, 1,5 GB',
            can_focus: true,
            x_expand: true,
        });
        item.add_child(this._inputEntry);
        panel.addMenuItem(item);
        this._results = new PopupMenu.PopupMenuSection();
        panel.addMenuItem(this._results);

        this._inputEntry.clutter_text.connect('text-changed', () => {
            this._input = this._inputEntry.text;
            this._showResults();
        });
        panel.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._inputEntry.grab_key_focus();
        });
        this._showResults();
    }

    _showResults() {
        this._results.removeAll();
        const conversion = this._input.trim() ? convert(this._input) : null;
        const add = (text, onActivate) => {
            const row = new PopupMenu.PopupMenuItem(text, {
                reactive: Boolean(onActivate),
                can_focus: Boolean(onActivate),
            });
            if (onActivate)
                row.connect('activate', onActivate);
            this._results.addMenuItem(row);
        };

        if (!this._input.trim()) {
            add('Comprimento, peso, temperatura e dados');
        } else if (!conversion) {
            add('Não entendi. Tente um número e a unidade.');
        } else {
            this._results.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(conversion.kind));
            for (const result of conversion.results)
                add(result, () => copy(result));
        }
        this._last = conversion?.results[0] ?? null;
        this.refresh();
    }

    refresh() {
        this.display({
            icon: 'accessories-calculator-symbolic',
            caption: 'Conversor',
            value: this._last ? `${this._input.trim()} = ${this._last}` : 'Clique para converter',
            short: '',
        });
    }
});
