import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Widget} from './base.js';
import {registerClass} from '../registerClass.js';

const MAX_ITEMS = 30;
const NAME_LENGTH = 48;
const URI_LIST = 'text/uri-list';
// É assim que o Arquivos (Nautilus) anuncia arquivos copiados.
const COPIED_FILES = 'x-special/gnome-copied-files';

// Lê da seleção (área de transferência ou arrasto em andamento) o conteúdo
// de um tipo, como texto.
function readSelection(type, mimetype) {
    return new Promise((resolve, reject) => {
        const out = Gio.MemoryOutputStream.new_resizable();
        global.display.get_selection().transfer_async(type, mimetype, -1, out, null,
            (selection, result) => {
                try {
                    selection.transfer_finish(result);
                    if (!out.is_closed())
                        out.close(null);
                    resolve(new TextDecoder().decode(out.steal_as_bytes().toArray()));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// Endereços de uma lista 'text/uri-list' ou do formato do Arquivos, que traz
// "copy" ou "cut" na primeira linha.
function parseUris(text) {
    return text.split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^[a-z][a-z0-9+.-]*:\S/i.test(line));
}

async function readUris(type) {
    const offered = global.display.get_selection().get_mimetypes(type);
    const mimetype = [URI_LIST, COPIED_FILES].find(m => offered.includes(m));
    return mimetype ? parseUris(await readSelection(type, mimetype)) : [];
}

function itemName(uri) {
    let name = uri;
    if (uri.startsWith('file:')) {
        name = Gio.File.new_for_uri(uri).get_basename() ?? uri;
    } else {
        name = uri.replace(/^https?:\/\/(www\.)?/, '');
    }
    return name.length > NAME_LENGTH ? `${name.slice(0, NAME_LENGTH)}…` : name;
}

function itemIcon(uri) {
    if (!uri.startsWith('file:'))
        return new Gio.ThemedIcon({name: 'web-browser-symbolic'});
    const path = Gio.File.new_for_uri(uri).get_path();
    if (path && GLib.file_test(path, GLib.FileTest.IS_DIR))
        return new Gio.ThemedIcon({name: 'folder'});
    const [type] = Gio.content_type_guess(path, null);
    return Gio.content_type_get_icon(type);
}

// Um lugar para deixar arquivos "na mão" enquanto se troca de janela ou de
// área de trabalho. Guarda só o endereço: o arquivo continua onde estava.
//
// Entram arrastando de qualquer app até o widget, ou pelo que estiver copiado.
// Saem pela área de transferência (copiar aqui, colar no destino): o GNOME
// Shell não consegue iniciar um arrasto para dentro de um app.
export const ShelfWidget = registerClass(
class ShelfWidget extends Widget {
    setup() {
        this.createPanel();
        this._settings.connectObject('changed::shelf-items', () => this.refresh(), this);

        // Arrasto vindo de um app. O shell não recebe o "soltar", mas sabe
        // onde o cursor está e consegue ler o que está sendo arrastado.
        this._drag = null;
        this._dnd = global.backend.get_dnd();
        this._dnd.connectObject(
            'dnd-enter', () => this._onDragEnter(),
            'dnd-position-change', (_dnd, x, y) => this._onDragMove(x, y),
            'dnd-leave', () => this._onDragLeave(), this);
    }

    _items() {
        return this._settings.get_strv('shelf-items');
    }

    _save(items) {
        this._settings.set_strv('shelf-items', items.slice(0, MAX_ITEMS));
    }

    _add(uris) {
        if (uris.length === 0)
            return;
        const items = this._items().filter(uri => !uris.includes(uri));
        this._save([...new Set(uris), ...items]);
    }

    _remove(uri) {
        this._save(this._items().filter(item => item !== uri));
    }

    // ---------- Arrasto de fora ----------

    _onDragEnter() {
        if (!this.mapped)
            return;
        const drag = {uris: [], over: false};
        this._drag = drag;
        // Lido já no começo: quando o arrasto termina, a origem some.
        readUris(Meta.SelectionType.SELECTION_DND).then(uris => {
            drag.uris = uris;
            if (this._drag === drag && uris.length > 0) {
                this.add_style_class_name('gprdock-shelf-ready');
                this._dock.setExternalDrag(this, true);
            }
        }).catch(() => {});
    }

    _onDragMove(x, y) {
        const drag = this._drag;
        if (!drag)
            return;
        const [left, top] = this.get_transformed_position();
        const [width, height] = this.get_transformed_size();
        const over = drag.uris.length > 0 &&
            x >= left && x < left + width && y >= top && y < top + height;
        if (over === drag.over)
            return;
        drag.over = over;
        if (over)
            this.add_style_class_name('gprdock-shelf-over');
        else
            this.remove_style_class_name('gprdock-shelf-over');
    }

    _onDragLeave() {
        const drag = this._drag;
        if (!drag)
            return;
        this._drag = null;
        this.remove_style_class_name('gprdock-shelf-ready');
        this.remove_style_class_name('gprdock-shelf-over');
        this._dock.setExternalDrag(this, false);
        // O arrasto acabou em cima do widget: foi solto aqui.
        if (drag.over)
            this._add(drag.uris);
    }

    // ---------- Área de transferência ----------

    async _addCopied() {
        let uris = [];
        try {
            uris = await readUris(Meta.SelectionType.SELECTION_CLIPBOARD);
        } catch {
            // Quem copiou já fechou: é como não haver nada copiado.
        }
        if (uris.length > 0)
            this._add(uris);
        else
            Main.notify('Prateleira', 'Não há arquivos copiados. Copie no Arquivos e tente de novo.');
    }

    _copy(uris) {
        const text = `${uris.join('\r\n')}\r\n`;
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, URI_LIST,
            new GLib.Bytes(new TextEncoder().encode(text)));
    }

    _open(uri) {
        try {
            this.openUri(uri);
        } catch (e) {
            Main.notify('Prateleira', `Não foi possível abrir ${itemName(uri)}: ${e.message}`);
        }
    }

    _showInFolder(uri) {
        Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1', 'ShowItems',
            new GLib.Variant('(ass)', [[uri], '']), null,
            Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                try {
                    connection.call_finish(result);
                } catch (e) {
                    Main.notify('Prateleira', `Não foi possível mostrar a pasta: ${e.message}`);
                }
            });
    }

    // ---------- Desenho ----------

    refresh() {
        const items = this._items();
        const count = items.length;

        this.display({
            icon: count > 0 ? null : 'folder-drag-accept-symbolic',
            gicon: count > 0 ? itemIcon(items[0]) : null,
            caption: count > 1 ? `Prateleira · ${count}` : 'Prateleira',
            value: count > 0 ? itemName(items[0]) : 'Arraste arquivos para cá',
            short: count > 0 ? `${count}` : '',
        });

        const panel = this._panel;
        panel.removeAll();
        const note = text => panel.addMenuItem(
            new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false}));

        const title = new PopupMenu.PopupMenuItem('Prateleira', {reactive: false, can_focus: false});
        title.label.add_style_class_name('gprdock-panel-title');
        panel.addMenuItem(title);
        if (count === 0)
            note('Arraste arquivos de qualquer app até aqui');

        for (const uri of items) {
            const item = new PopupMenu.PopupSubMenuMenuItem(itemName(uri), true);
            item.icon.gicon = itemIcon(uri);
            item.menu.addAction('Abrir', () => this._open(uri));
            if (uri.startsWith('file:'))
                item.menu.addAction('Mostrar na pasta', () => this._showInFolder(uri));
            item.menu.addAction('Copiar', () => this._copy([uri]));
            item.menu.addAction('Tirar da prateleira', () => this._remove(uri));
            panel.addMenuItem(item);
        }

        panel.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (count > 1)
            panel.addAction('Copiar tudo', () => this._copy(items));
        panel.addAction('Guardar o que está copiado', () => this._addCopied());
        if (count > 0)
            panel.addAction('Esvaziar', () => this._save([]));
    }

    onDestroy() {
        this._settings.disconnectObject(this);
        this._dnd.disconnectObject(this);
        this._dock.setExternalDrag(this, false);
    }
});
