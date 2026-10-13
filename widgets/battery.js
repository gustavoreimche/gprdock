import Gio from 'gi://Gio';

import {Widget, isCancelled} from './base.js';
import {registerClass} from '../registerClass.js';

const UPOWER_NAME = 'org.freedesktop.UPower';
const DISPLAY_DEVICE = '/org/freedesktop/UPower/devices/DisplayDevice';
const DEVICE_IFACE = 'org.freedesktop.UPower.Device';

const STATES = {
    1: 'Carregando',
    2: 'Na bateria',
    3: 'Vazia',
    4: 'Carregada',
    5: 'Aguardando carga',
    6: 'Aguardando descarga',
};

function formatDuration(seconds) {
    const minutes = Math.round(seconds / 60);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}` : `${m} min`;
}

export const BatteryWidget = registerClass(
class BatteryWidget extends Widget {
    onMiddleClick() {
        return this.launchApp('gnome-power-panel.desktop');
    }

    setup() {
        this.display({icon: 'battery-missing-symbolic', value: '—', caption: 'Bateria'});
        this.createPanel();
        this.setPanelLines([['Bateria indisponível']]);

        Gio.DBusProxy.new(Gio.DBus.system, Gio.DBusProxyFlags.NONE, null,
            UPOWER_NAME, DISPLAY_DEVICE, DEVICE_IFACE, this.cancellable,
            (_source, result) => {
                try {
                    this._proxy = Gio.DBusProxy.new_finish(result);
                } catch (e) {
                    if (!isCancelled(e))
                        console.warn(`gprdock: UPower indisponível: ${e.message}`);
                    return;
                }
                this._proxy.connectObject('g-properties-changed',
                    () => this._update(), this);
                this._update();
            });
    }

    _prop(name) {
        return this._proxy.get_cached_property(name)?.unpack();
    }

    _update() {
        if (!this._prop('IsPresent')) {
            this.display({icon: 'battery-missing-symbolic', value: '—', caption: 'Bateria'});
            this.setPanelLines([['Sem bateria']]);
            return;
        }

        const percent = Math.round(this._prop('Percentage') ?? 0);
        const state = this._prop('State');
        const stateText = STATES[state] ?? 'Estado desconhecido';
        const toEmpty = Number(this._prop('TimeToEmpty') ?? 0);
        const toFull = Number(this._prop('TimeToFull') ?? 0);

        let remaining = '';
        if (state === 2 && toEmpty > 0)
            remaining = `Restam ${formatDuration(toEmpty)}`;
        else if (state === 1 && toFull > 0)
            remaining = `Carga completa em ${formatDuration(toFull)}`;

        this.display({
            icon: this._prop('IconName') || 'battery-symbolic',
            value: `${percent}%`,
            caption: remaining || stateText,
        });

        const lines = [
            ['Bateria', 'gprdock-panel-title'],
            [`${stateText} · ${percent}%`],
        ];
        if (remaining)
            lines.push([remaining]);
        this.setPanelLines(lines);
    }

    onDestroy() {
        this._proxy?.disconnectObject(this);
        this._proxy = null;
    }
});
