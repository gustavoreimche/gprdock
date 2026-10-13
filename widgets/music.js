import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Widget, isCancelled} from './base.js';
import {registerClass} from '../registerClass.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const ROOT_IFACE = 'org.mpris.MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
// O playerctld só espelha outro player; mostrá-lo duplicaria a faixa.
const IGNORED = ['org.mpris.MediaPlayer2.playerctld'];
const FALLBACK_ICON = 'audio-x-generic-symbolic';

// Retângulo: capa, faixa e controles; clique traz a janela do player.
// Quadrado: só a capa; clique toca ou pausa.
export const MusicWidget = registerClass(
class MusicWidget extends Widget {
    onMiddleClick() {
        this._raise();
        return true;
    }

    setup() {
        this._players = new Map();
        this._activity = 0;
        this._ui = null;

        this._bus = Gio.DBus.session;
        this._nameWatchId = this._bus.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', ROOT_IFACE,
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_c, _sender, _path, _iface, _signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            });

        this._bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, null,
            Gio.DBusCallFlags.NONE, -1, this.cancellable, (bus, result) => {
                try {
                    const [names] = bus.call_finish(result).deepUnpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX))
                        .forEach(n => this._addPlayer(n));
                } catch (e) {
                    if (!isCancelled(e))
                        console.warn(`gprdock: não listou players: ${e.message}`);
                }
            });
    }

    build(size) {
        const art = new St.Icon({
            style_class: 'gprdock-music-art',
            fallback_icon_name: FALLBACK_ICON,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._ui = {art, artUrl: undefined, buttons: []};
        if (size === 'square') {
            art.x_expand = true;
            art.y_expand = true;
            return art;
        }

        const box = new St.BoxLayout({style_class: 'gprdock-music'});
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: size === 'large'
                ? 'gprdock-music-text gprdock-music-text-large' : 'gprdock-music-text',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._ui.title = new St.Label({style_class: 'gprdock-tile-value'});
        this._ui.artist = new St.Label({style_class: 'gprdock-tile-caption'});
        text.add_child(this._ui.title);
        text.add_child(this._ui.artist);

        box.add_child(art);
        box.add_child(text);
        this._addControl(box, 'media-skip-backward-symbolic', 'Previous');
        this._ui.play = this._addControl(box, 'media-playback-start-symbolic', 'PlayPause');
        this._addControl(box, 'media-skip-forward-symbolic', 'Next');
        return box;
    }

    _addControl(box, iconName, method) {
        const button = new St.Button({
            style_class: 'gprdock-music-button',
            child: new St.Icon({icon_name: iconName}),
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
        });
        button.connect('clicked', () => this._call(method));
        box.add_child(button);
        this._ui.buttons.push(button);
        return button;
    }

    _call(method) {
        this._current()?.proxy.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    _addPlayer(name) {
        if (IGNORED.includes(name) || this._players.has(name))
            return;

        const player = {name, proxy: null, activity: 0};
        this._players.set(name, player);

        Gio.DBusProxy.new(this._bus, Gio.DBusProxyFlags.NONE, null,
            name, MPRIS_PATH, PLAYER_IFACE, this.cancellable, (_source, result) => {
                try {
                    player.proxy = Gio.DBusProxy.new_finish(result);
                } catch (e) {
                    if (!isCancelled(e))
                        this._players.delete(name);
                    return;
                }
                // O player pode ter saído enquanto o proxy era criado.
                if (this._players.get(name) !== player)
                    return;

                player.proxy.connectObject('g-properties-changed', () => {
                    player.activity = ++this._activity;
                    this.refresh();
                }, this);
                this.refresh();
            });
    }

    _removePlayer(name) {
        const player = this._players.get(name);
        if (!player)
            return;
        player.proxy?.disconnectObject(this);
        this._players.delete(name);
        this.refresh();
    }

    _status(player) {
        return player.proxy.get_cached_property('PlaybackStatus')?.unpack();
    }

    _metadata(player) {
        return player.proxy.get_cached_property('Metadata')?.recursiveUnpack() ?? {};
    }

    // Quem está tocando vence; no empate, quem mudou por último.
    _current() {
        const ready = [...this._players.values()].filter(p => p.proxy);
        const rank = p => [
            this._status(p) === 'Playing' ? 1 : 0,
            this._metadata(p)['xesam:title'] ? 1 : 0,
            p.activity,
        ];
        ready.sort((a, b) => {
            const [ra, rb] = [rank(a), rank(b)];
            return rb[0] - ra[0] || rb[1] - ra[1] || rb[2] - ra[2];
        });
        return ready[0] ?? null;
    }

    refresh() {
        const ui = this._ui;
        if (!ui)
            return;

        const player = this._current();
        const metadata = player ? this._metadata(player) : {};
        const title = metadata['xesam:title'];
        const hasTrack = Boolean(title);
        const playing = player && this._status(player) === 'Playing';

        const artUrl = metadata['mpris:artUrl'] || null;
        if (artUrl !== ui.artUrl) {
            ui.artUrl = artUrl;
            if (artUrl) {
                ui.art.gicon = new Gio.FileIcon({file: Gio.File.new_for_uri(artUrl)});
            } else {
                ui.art.gicon = null;
                ui.art.icon_name = FALLBACK_ICON;
            }
        }
        ui.art.opacity = hasTrack && !playing && !this.wide ? 130 : 255;

        if (!this.wide)
            return;

        const artist = metadata['xesam:artist'];
        ui.title.text = title || 'Nada tocando';
        ui.artist.text = (Array.isArray(artist) ? artist.join(', ') : artist) || '';
        ui.artist.visible = ui.artist.text !== '';
        ui.play.child.icon_name = playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        for (const button of ui.buttons) {
            button.reactive = hasTrack;
            button.opacity = hasTrack ? 255 : 90;
        }
    }

    onClick() {
        if (this.wide)
            this._raise();
        else
            this._call('PlayPause');
    }

    // Traz a janela do player: pelo app quando ele se identifica, senão
    // pedindo ao próprio player.
    _raise() {
        const player = this._current();
        if (!player)
            return;

        this._bus.call(player.name, MPRIS_PATH, 'org.freedesktop.DBus.Properties',
            'Get', new GLib.Variant('(ss)', [ROOT_IFACE, 'DesktopEntry']),
            null, Gio.DBusCallFlags.NONE, -1, this.cancellable, (bus, result) => {
                let app = null;
                try {
                    const [entry] = bus.call_finish(result).recursiveUnpack();
                    app = Shell.AppSystem.get_default().lookup_app(`${entry}.desktop`);
                } catch (e) {
                    if (isCancelled(e))
                        return;
                }

                if (app) {
                    app.activate();
                } else {
                    bus.call(player.name, MPRIS_PATH, ROOT_IFACE, 'Raise',
                        null, null, Gio.DBusCallFlags.NONE, -1, null, null);
                }
            });
    }

    onDestroy() {
        this._bus.signal_unsubscribe(this._nameWatchId);
        this._players.forEach(p => p.proxy?.disconnectObject(this));
        this._players.clear();
    }
});
