import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {PickPixel} from 'resource:///org/gnome/shell/ui/screenshot.js';

import {Widget, isCancelled} from './base.js';
import {registerClass} from '../registerClass.js';

const CLIPBOARD_ITEMS = 12;
const LINE_LENGTH = 60;
const COLOR_HISTORY = 6;
const EMOJI_RECENT = 8;
const EMOJI_PER_ROW = 8;
const EMOJIS = [...'😀😂🙂😉😍🤔😎😢😡🙏👍👎👏🙌💪🤝👀🔥✨🎉❤️✅❌⚠️🚀💡📌📎☕🍕🎧🐛'.matchAll(/\p{Extended_Pictographic}️?/gu)]
    .map(match => match[0]);
const RECENT_FILES = 6;

function copy(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}

function oneLine(text) {
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > LINE_LENGTH ? `${text.slice(0, LINE_LENGTH)}…` : text;
}

// Histórico do que foi copiado como texto. Fica só na memória: some ao sair
// da sessão e nunca vai para o disco. Clicar numa linha copia de novo.
export const ClipboardWidget = registerClass(
class ClipboardWidget extends Widget {
    setup() {
        this._history = [];
        this.createPanel();

        this._selection = global.display.get_selection();
        this._selection.connectObject('owner-changed', (_selection, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._read();
        }, this);
        this._read();
    }

    _read() {
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
            if (!text?.trim())
                return;
            this._history = [text, ...this._history.filter(t => t !== text)]
                .slice(0, CLIPBOARD_ITEMS);
            this.refresh();
        });
    }

    refresh() {
        const count = this._history.length;
        this.display({
            icon: 'edit-paste-symbolic',
            caption: 'Área de transferência',
            value: count > 0 ? oneLine(this._history[0]) : 'Nada copiado',
            short: `${count}`,
        });

        const lines = [['Área de transferência', 'gprdock-panel-title']];
        if (count === 0)
            lines.push(['O que você copiar aparece aqui']);
        for (const text of this._history)
            lines.push([oneLine(text), 'gprdock-panel-text', () => copy(text)]);
        if (count > 0) {
            lines.push(['Limpar o histórico', null, () => {
                this._history = [];
                this.refresh();
            }]);
        }
        this.setPanelLines(lines);
    }

    onDestroy() {
        this._selection.disconnectObject(this);
    }
});

// Os emojis mais usados a um clique: clicar copia para a área de transferência.
export const EmojiWidget = registerClass(
class EmojiWidget extends Widget {
    setup() {
        this.createPanel();
        this._settings.connectObject('changed::emoji-recent', () => this.refresh(), this);
    }

    refresh() {
        const recent = this._settings.get_strv('emoji-recent');
        this.display({
            icon: 'face-smile-symbolic',
            caption: 'Emoji',
            value: recent.slice(0, 5).join(' ') || 'Clique para escolher',
            short: recent[0] ?? '',
        });

        // Os recentes vêm primeiro, sem repetir na grade.
        const all = [...recent, ...EMOJIS.filter(e => !recent.includes(e))];
        this._panel.removeAll();
        for (let start = 0; start < all.length; start += EMOJI_PER_ROW) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            const row = new St.BoxLayout({style_class: 'gprdock-emoji-row'});
            for (const emoji of all.slice(start, start + EMOJI_PER_ROW)) {
                const button = new St.Button({
                    style_class: 'gprdock-emoji',
                    label: emoji,
                    can_focus: true,
                });
                button.connect('clicked', () => this._choose(emoji));
                row.add_child(button);
            }
            item.add_child(row);
            this._panel.addMenuItem(item);
        }
    }

    _choose(emoji) {
        copy(emoji);
        this._panel.close();
        const recent = this._settings.get_strv('emoji-recent');
        this._settings.set_strv('emoji-recent',
            [emoji, ...recent.filter(e => e !== emoji)].slice(0, EMOJI_RECENT));
    }

    onDestroy() {
        this._settings.disconnectObject(this);
    }
});

// Pega a cor de qualquer ponto da tela; o código vai para a área de
// transferência e as últimas ficam no painel.
export const ColorPickerWidget = registerClass(
class ColorPickerWidget extends Widget {
    setup() {
        this.createPanel();
        this._settings.connectObject('changed::color-history', () => this.refresh(), this);
    }

    refresh() {
        const history = this._settings.get_strv('color-history');
        this.display({
            icon: 'color-select-symbolic',
            caption: 'Conta-gotas',
            value: history[0] ?? 'Pegar uma cor',
            short: history[0] ?? '',
        });

        const lines = [['Pegar uma cor da tela', null, () => this._pick()]];
        for (const color of history)
            lines.push([color, 'gprdock-panel-text', () => copy(color)]);
        this.setPanelLines(lines);
    }

    async _pick() {
        try {
            const {x, y} = await new PickPixel().pickAsync();
            const [color] = await new Shell.Screenshot().pick_color(x, y);
            const hex = `#${[color.red, color.green, color.blue]
                .map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
            copy(hex);
            const history = this._settings.get_strv('color-history');
            this._settings.set_strv('color-history',
                [hex, ...history.filter(c => c !== hex)].slice(0, COLOR_HISTORY));
        } catch {
            // Escolha cancelada (Esc): nada a fazer.
        }
    }

    onDestroy() {
        this._settings.disconnectObject(this);
    }
});

// Os arquivos mais recentes de uma pasta; clicar num deles abre.
const RecentFilesWidget = registerClass(
class RecentFilesWidget extends Widget {
    onMiddleClick() {
        return this._dir ? this.openUri(this._dir.get_uri()) : false;
    }

    // As subclasses dizem a pasta, o ícone e o nome.
    get folder() {
        return null;
    }

    setup() {
        this._files = [];
        this.createPanel();

        const path = this.folder;
        this._dir = path ? Gio.File.new_for_path(path) : null;
        try {
            this._monitor = this._dir?.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitor?.connectObject('changed', () => this._list(), this);
        } catch {
            // Pasta inexistente: o painel avisa.
        }
        this._list();
    }

    _list() {
        if (!this._dir)
            return;
        this._dir.enumerate_children_async('standard::name,standard::type,time::modified',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this.cancellable,
            (dir, result) => {
                let files = [];
                try {
                    const enumerator = dir.enumerate_children_finish(result);
                    let info = null;
                    while ((info = enumerator.next_file(null)) !== null) {
                        if (info.get_file_type() === Gio.FileType.REGULAR &&
                            !info.get_name().startsWith('.')) {
                            files.push({
                                name: info.get_name(),
                                time: info.get_attribute_uint64('time::modified'),
                            });
                        }
                    }
                    enumerator.close(null);
                } catch (e) {
                    if (isCancelled(e))
                        return;
                    files = null;
                }
                this._files = files;
                this.refresh();
            });
    }

    refresh() {
        const files = this._files;
        const total = files?.length ?? 0;
        const recent = [...files ?? []].sort((a, b) => b.time - a.time).slice(0, RECENT_FILES);

        this.display({
            icon: this.iconName,
            caption: this.label,
            value: recent[0]?.name ?? (files ? 'Pasta vazia' : 'Pasta não encontrada'),
            short: `${total}`,
        });

        const lines = [[this.label, 'gprdock-panel-title']];
        for (const file of recent) {
            lines.push([oneLine(file.name), 'gprdock-panel-text',
                () => this.openUri(this._dir.get_child(file.name).get_uri())]);
        }
        if (this._dir && files)
            lines.push(['Abrir a pasta', null, () => this.openUri(this._dir.get_uri())]);
        this.setPanelLines(lines);
    }

    onDestroy() {
        this._monitor?.disconnectObject(this);
        this._monitor?.cancel();
    }
});

export const ScreenshotsWidget = registerClass(
class ScreenshotsWidget extends RecentFilesWidget {
    get label() {
        return 'Capturas de tela';
    }

    get iconName() {
        return 'camera-photo-symbolic';
    }

    // O GNOME salva em "Capturas de tela" (ou "Screenshots") dentro de Imagens.
    get folder() {
        const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
        if (!pictures)
            return null;
        return ['Capturas de tela', 'Screenshots']
            .map(name => GLib.build_filenamev([pictures, name]))
            .find(path => GLib.file_test(path, GLib.FileTest.IS_DIR)) ?? null;
    }
});

export const FilesWidget = registerClass(
class FilesWidget extends RecentFilesWidget {
    get label() {
        return 'Downloads';
    }

    get iconName() {
        return 'folder-download-symbolic';
    }

    get folder() {
        return GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
    }
});
