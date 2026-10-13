import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Widget, isCancelled, runCommand} from './base.js';
import {registerClass} from '../registerClass.js';

const note = (menu, text) => menu.addMenuItem(
    new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false}));

function title(menu, text) {
    const item = new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false});
    item.label.add_style_class_name('gprdock-panel-title');
    menu.addMenuItem(item);
}

// ---------- Atalhos do sistema ----------

const RFKILL_NAME = 'org.gnome.SettingsDaemon.Rfkill';
const RFKILL_PATH = '/org/gnome/SettingsDaemon/Rfkill';
const AWAKE_FLAGS = 4 | 8;      // não suspender e não deixar a sessão ociosa

// Os interruptores que mais se usa, a um clique: estilo escuro, luz noturna,
// Wi-Fi, Bluetooth e manter a tela acordada.
export const TogglesWidget = registerClass(
class TogglesWidget extends Widget {
    setup() {
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._color = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
        this._interface.connectObject('changed::color-scheme', () => this.refresh(), this);
        this._color.connectObject('changed::night-light-enabled', () => this.refresh(), this);
        this._wifi = null;          // null enquanto não se sabe
        this._bluetooth = null;
        this._awakeCookie = 0;

        this._rfkillId = Gio.DBus.session.signal_subscribe(RFKILL_NAME,
            'org.freedesktop.DBus.Properties', 'PropertiesChanged', RFKILL_PATH, null,
            Gio.DBusSignalFlags.NONE, () => this._readRadios());
        this.createPanel();
        this._readRadios();
        this.every(30, () => this._readRadios());
    }

    async _rfkill(property) {
        const reply = await Gio.DBus.session.call(RFKILL_NAME, RFKILL_PATH,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [RFKILL_NAME, property]), null,
            Gio.DBusCallFlags.NONE, -1, this.cancellable);
        return reply.recursiveUnpack()[0];
    }

    async _readRadios() {
        try {
            // "Modo avião do Bluetooth" ligado é Bluetooth desligado.
            this._bluetooth = await this._rfkill('BluetoothHasAirplaneMode')
                ? !await this._rfkill('BluetoothAirplaneMode') : null;
        } catch (e) {
            if (isCancelled(e))
                return;
            this._bluetooth = null;
        }
        try {
            const state = await runCommand(['nmcli', 'radio', 'wifi'], this.cancellable);
            this._wifi = state.trim() === 'enabled';
        } catch (e) {
            if (isCancelled(e))
                return;
            this._wifi = null;
        }
        this.refresh();
    }

    async _setWifi(on) {
        try {
            await runCommand(['nmcli', 'radio', 'wifi', on ? 'on' : 'off'], this.cancellable);
        } catch (e) {
            if (!isCancelled(e))
                Main.notify('Atalhos', `Não foi possível mudar o Wi-Fi: ${e.message}`);
        }
        this._readRadios();
    }

    async _setBluetooth(on) {
        try {
            await Gio.DBus.session.call(RFKILL_NAME, RFKILL_PATH,
                'org.freedesktop.DBus.Properties', 'Set',
                new GLib.Variant('(ssv)',
                    [RFKILL_NAME, 'BluetoothAirplaneMode', new GLib.Variant('b', !on)]),
                null, Gio.DBusCallFlags.NONE, -1, this.cancellable);
        } catch (e) {
            if (!isCancelled(e))
                Main.notify('Atalhos', `Não foi possível mudar o Bluetooth: ${e.message}`);
        }
        this._readRadios();
    }

    // Enquanto ligado, a tela não apaga nem o computador suspende sozinho.
    async _setAwake(on) {
        try {
            if (on && !this._awakeCookie) {
                const reply = await Gio.DBus.session.call('org.gnome.SessionManager',
                    '/org/gnome/SessionManager', 'org.gnome.SessionManager', 'Inhibit',
                    new GLib.Variant('(susu)', ['gprdock', 0, 'Manter acordado (dock)', AWAKE_FLAGS]),
                    null, Gio.DBusCallFlags.NONE, -1, this.cancellable);
                [this._awakeCookie] = reply.recursiveUnpack();
            } else if (!on && this._awakeCookie) {
                const cookie = this._awakeCookie;
                this._awakeCookie = 0;
                await Gio.DBus.session.call('org.gnome.SessionManager',
                    '/org/gnome/SessionManager', 'org.gnome.SessionManager', 'Uninhibit',
                    new GLib.Variant('(u)', [cookie]), null,
                    Gio.DBusCallFlags.NONE, -1, null);
            }
        } catch (e) {
            if (isCancelled(e))
                return;
            Main.notify('Atalhos', `Não foi possível mudar "manter acordado": ${e.message}`);
        }
        this.refresh();
    }

    _toggles() {
        const dark = this._interface.get_string('color-scheme') === 'prefer-dark';
        return [
            {label: 'Estilo escuro', on: dark,
                set: on => this._interface.set_string('color-scheme', on ? 'prefer-dark' : 'default')},
            {label: 'Luz noturna', on: this._color.get_boolean('night-light-enabled'),
                set: on => this._color.set_boolean('night-light-enabled', on)},
            {label: 'Wi-Fi', on: this._wifi, set: on => this._setWifi(on)},
            {label: 'Bluetooth', on: this._bluetooth, set: on => this._setBluetooth(on)},
            {label: 'Manter acordado', on: this._awakeCookie !== 0, set: on => this._setAwake(on)},
        ].filter(toggle => toggle.on !== null);
    }

    refresh() {
        const toggles = this._toggles();
        const on = toggles.filter(t => t.on);
        this.display({
            icon: 'preferences-system-symbolic',
            caption: 'Atalhos',
            value: on.length === 0 ? 'Tudo desligado' : on.map(t => t.label).join(' · '),
            short: `${on.length}/${toggles.length}`,
        });
        if (this._awakeCookie)
            this.add_style_class_name('gprdock-state-warn');
        else
            this.remove_style_class_name('gprdock-state-warn');

        const panel = this._panel;
        if (!panel || panel.isOpen)
            return;
        panel.removeAll();
        title(panel, 'Atalhos do sistema');
        for (const toggle of toggles) {
            const item = new PopupMenu.PopupSwitchMenuItem(toggle.label, toggle.on);
            item.connect('toggled', (_item, state) => toggle.set(state));
            panel.addMenuItem(item);
        }
    }

    onDestroy() {
        this._interface.disconnectObject(this);
        this._color.disconnectObject(this);
        Gio.DBus.session.signal_unsubscribe(this._rfkillId);
        // O "manter acordado" não sobrevive ao widget.
        if (this._awakeCookie) {
            Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
                'org.gnome.SessionManager', 'Uninhibit',
                new GLib.Variant('(u)', [this._awakeCookie]), null,
                Gio.DBusCallFlags.NONE, -1, null, null);
            this._awakeCookie = 0;
        }
    }
});

// ---------- Armazenamento ----------

const STORAGE_FULL = 0.9;

function size(bytes) {
    const gb = bytes / 1e9;
    return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1).replace('.', ',')} GB`;
}

function usage(path, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).query_filesystem_info_async(
            'filesystem::size,filesystem::free', GLib.PRIORITY_DEFAULT, cancellable,
            (file, result) => {
                try {
                    const info = file.query_filesystem_info_finish(result);
                    const total = info.get_attribute_uint64('filesystem::size');
                    const free = info.get_attribute_uint64('filesystem::free');
                    resolve({total, free});
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// Quanto do disco já foi: o da pasta pessoal no tile; no painel, também o do
// sistema e os discos removíveis montados.
export const StorageWidget = registerClass(
class StorageWidget extends Widget {
    onMiddleClick() {
        return this.launchApp('org.gnome.baobab.desktop', 'org.gnome.Nautilus.desktop');
    }

    setup() {
        this._disks = [];
        this._monitor = Gio.VolumeMonitor.get();
        this._monitor.connectObject(
            'mount-added', () => this._fetch(),
            'mount-removed', () => this._fetch(), this);
        this.createPanel();
        this._fetch();
        this.every(120, () => this._fetch());
    }

    async _fetch() {
        const places = [['Pasta pessoal', GLib.get_home_dir()], ['Sistema', '/']];
        for (const mount of this._monitor.get_mounts()) {
            const path = mount.get_root()?.get_path();
            if (path && !mount.is_shadowed())
                places.push([mount.get_name(), path]);
        }

        const disks = [];
        const seen = new Set();
        for (const [name, path] of places) {
            try {
                const {total, free} = await usage(path, this.cancellable);
                // Dois lugares no mesmo disco contam uma vez só.
                const key = `${total}/${free}`;
                if (total > 0 && !seen.has(key)) {
                    seen.add(key);
                    disks.push({name, path, total, free, used: 1 - free / total});
                }
            } catch (e) {
                if (isCancelled(e))
                    return;
            }
        }
        this._disks = disks;
        this.refresh();
    }

    refresh() {
        const [main] = this._disks;
        const full = this._disks.some(disk => disk.used >= STORAGE_FULL);
        this.display({
            ring: main?.used ?? 0,
            ringText: main ? `${Math.round(main.used * 100)}%` : '—',
            caption: 'Armazenamento',
            value: main ? `${size(main.free)} livres` : 'Indisponível',
        });
        if (full)
            this.add_style_class_name('gprdock-state-alert');
        else
            this.remove_style_class_name('gprdock-state-alert');

        const lines = [['Armazenamento', 'gprdock-panel-title']];
        for (const disk of this._disks) {
            lines.push([`${disk.name}: ${Math.round(disk.used * 100)}% em uso\n` +
                `${size(disk.free)} livres de ${size(disk.total)}`,
                'gprdock-panel-text',
                () => this.openUri(Gio.File.new_for_path(disk.path).get_uri())]);
        }
        if (this._disks.length === 0)
            lines.push(['Não foi possível consultar os discos']);
        this.setPanelLines(lines);
    }

    onDestroy() {
        this._monitor.disconnectObject(this);
    }
});

// ---------- Relógio mundial ----------

// 'America/Sao_Paulo' -> 'Sao Paulo'
const zoneName = id => id.split('/').at(-1).replaceAll('_', ' ');

// A hora em outras cidades. Os fusos vêm das configurações, como
// "Região/Cidade" (o nome que o sistema usa: Europe/Lisbon, Asia/Tokyo...).
export const WorldClockWidget = registerClass(
class WorldClockWidget extends Widget {
    onMiddleClick() {
        return this.launchApp('org.gnome.clocks.desktop');
    }

    setup() {
        this.createPanel();
        this._settings.connectObject('changed::world-clocks', () => this.refresh(), this);
        this.every(10, () => this.refresh());
    }

    _clocks() {
        const here = GLib.DateTime.new_now_local();
        return this._settings.get_strv('world-clocks').map(id => {
            const zone = GLib.TimeZone.new_identifier(id);
            if (!zone)
                return null;
            const now = GLib.DateTime.new_now(zone);
            const hours = (now.get_utc_offset() - here.get_utc_offset()) / 3.6e9;
            const days = now.get_day_of_year() - here.get_day_of_year() +
                (now.get_year() - here.get_year()) * 365;
            return {
                name: zoneName(id),
                time: now.format('%H:%M'),
                offset: hours === 0 ? 'mesma hora'
                    : `${hours > 0 ? '+' : '−'}${Math.abs(hours).toString().replace('.', ',')} h`,
                day: days > 0 ? ' · amanhã' : days < 0 ? ' · ontem' : '',
            };
        }).filter(Boolean);
    }

    refresh() {
        const clocks = this._clocks();
        const [first] = clocks;
        this.display({
            icon: first ? null : 'preferences-system-time-symbolic',
            caption: first ? `${first.name} · ${first.offset}` : 'Relógio mundial',
            value: first ? first.time : 'Sem cidades',
            short: first ? first.time : '—',
        });

        const lines = [['Relógio mundial', 'gprdock-panel-title']];
        if (clocks.length === 0)
            lines.push(['Adicione cidades em Configurações › Ajustes › Relógio mundial']);
        for (const clock of clocks)
            lines.push([`${clock.time}  ${clock.name}\n${clock.offset}${clock.day}`, 'gprdock-panel-text']);
        this.setPanelLines(lines);
    }

    onDestroy() {
        this._settings.disconnectObject(this);
    }
});

// ---------- Gravador de voz ----------

const MEMO_FOLDER = 'Gravações de voz';
const MEMOS_LISTED = 6;

const elapsed = seconds =>
    `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

// Um clique começa a gravar o microfone; outro para e guarda o arquivo em
// Música/Gravações de voz. O painel traz as últimas gravações.
export const VoiceMemoWidget = registerClass(
class VoiceMemoWidget extends Widget {
    setup() {
        this._process = null;
        this._started = 0;
        this._ticker = 0;
        this._recent = [];
        this._folder = GLib.build_filenamev([
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_MUSIC) ?? GLib.get_home_dir(),
            MEMO_FOLDER]);
        this.createPanel();
        this._listRecent();
    }

    get _recording() {
        return this._process !== null;
    }

    onClick() {
        if (this._recording)
            this._stop();
        else
            this._start();
    }

    onSecondaryClick() {
        // Gravando, o clique direito também só para: o menu ficaria por cima.
        if (this._recording)
            this._stop();
        else
            this._dock.openMenu(this);
    }

    buildMenu(menu) {
        menu.addAction('Ver as gravações', () => this._panel.open());
        menu.addAction('Abrir a pasta', () => this._openFolder());
    }

    _openFolder() {
        GLib.mkdir_with_parents(this._folder, 0o755);
        this.openUri(Gio.File.new_for_path(this._folder).get_uri());
    }

    _start() {
        GLib.mkdir_with_parents(this._folder, 0o755);
        const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d %Hh%Mm%S');
        const path = GLib.build_filenamev([this._folder, `Gravação ${stamp}.flac`]);
        try {
            this._process = Gio.Subprocess.new(['pw-record', path],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            Main.notify('Gravador', 'Não foi possível gravar: o pw-record não foi encontrado.');
            return;
        }
        const process = this._process;
        this._started = Date.now();
        this._ticker = this.every(1, () => this.refresh());
        process.communicate_utf8_async(null, null, (source, result) => {
            let error = '';
            try {
                [, , error] = source.communicate_utf8_finish(result);
            } catch {
                // O dock foi desligado no meio.
            }
            // Parou sozinho (sem microfone, disco cheio): avisa.
            if (this._process === process) {
                this._finish();
                Main.notify('Gravador',
                    `A gravação parou: ${error.trim().split('\n').at(-1) || 'motivo desconhecido'}`);
            }
        });
        this.refresh();
    }

    // O sinal de interrupção faz o pw-record fechar o arquivo direito.
    _stop() {
        const process = this._process;
        this._finish();
        process?.send_signal(2);
    }

    _finish() {
        this._process = null;
        if (this._ticker) {
            this.cancelTimer(this._ticker);
            this._ticker = 0;
        }
        // O arquivo leva um instante para ser fechado.
        const id = this.every(1, () => {
            this.cancelTimer(id);
            this._listRecent();
        });
        this.refresh();
    }

    _listRecent() {
        const found = [];
        try {
            const dir = GLib.Dir.open(this._folder, 0);
            for (let name = dir.read_name(); name !== null; name = dir.read_name()) {
                if (/\.(flac|wav|ogg|mp3)$/i.test(name))
                    found.push(name);
            }
            dir.close();
        } catch {
            // Ainda não há gravações.
        }
        // O nome traz a data: a ordem alfabética é a do tempo.
        this._recent = found.sort().reverse().slice(0, MEMOS_LISTED);
        this.refresh();
    }

    refresh() {
        const seconds = this._recording ? Math.floor((Date.now() - this._started) / 1000) : 0;
        this.display({
            icon: this._recording ? 'media-playback-stop-symbolic' : 'audio-input-microphone-symbolic',
            caption: this._recording ? 'Gravando' : 'Gravador',
            value: this._recording ? elapsed(seconds)
                : this._recent.length > 0 ? `${this._recent.length} gravações` : 'Clique para gravar',
            short: this._recording ? elapsed(seconds) : 'rec',
        });
        if (this._recording)
            this.add_style_class_name('gprdock-state-alert');
        else
            this.remove_style_class_name('gprdock-state-alert');

        const panel = this._panel;
        if (!panel || panel.isOpen)
            return;
        panel.removeAll();
        title(panel, 'Gravações de voz');
        if (this._recent.length === 0)
            note(panel, 'Nenhuma gravação ainda');
        for (const name of this._recent) {
            panel.addAction(name.replace(/^Gravação /, '').replace(/\.\w+$/, ''), () => this.openUri(
                Gio.File.new_for_path(GLib.build_filenamev([this._folder, name])).get_uri()));
        }
        panel.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        panel.addAction('Abrir a pasta', () => this._openFolder());
    }

    onDestroy() {
        // Desligar o dock no meio de uma gravação a encerra, sem perder o arquivo.
        this._process?.send_signal(2);
        this._process = null;
    }
});
