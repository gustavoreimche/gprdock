import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Widget, readFile} from './base.js';
import {Bar} from './gauges.js';
import {registerClass} from '../registerClass.js';

const INTERVAL_SECONDS = 2;
const MONITOR_APPS = [
    'net.nokyan.Resources.desktop',
    'org.gnome.SystemMonitor.desktop',
    'gnome-system-monitor.desktop',
];

export const ActivityWidget = registerClass(
class ActivityWidget extends Widget {
    onMiddleClick() {
        this.onClick();
        return true;
    }

    setup() {
        this._cpu = null;
        this._memory = null;
        this._lastCpu = null;
        this._update();
        this.every(INTERVAL_SECONDS, () => this._update());
    }

    // Retângulo: barras de CPU e memória. Quadrado: anel só com a CPU.
    build(size) {
        this._rows = null;
        if (size === 'square')
            return super.build(size);

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'gprdock-activity',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._rows = {cpu: this._addRow(box, 'CPU'), memory: this._addRow(box, 'RAM')};
        return box;
    }

    _addRow(box, name) {
        const row = new St.BoxLayout({style_class: 'gprdock-activity-row'});
        const bar = this.trackGauge(new Bar({y_align: Clutter.ActorAlign.CENTER}));
        const value = new St.Label({
            style_class: 'gprdock-activity-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(new St.Label({
            style_class: 'gprdock-activity-name',
            text: name,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        row.add_child(bar);
        row.add_child(value);
        box.add_child(row);
        return {bar, value};
    }

    refresh() {
        const percent = n => n === null ? '—' : `${Math.round(n * 100)}%`;
        if (this._rows) {
            this._rows.cpu.bar.show(this._cpu ?? 0);
            this._rows.cpu.value.text = percent(this._cpu);
            this._rows.memory.bar.show(this._memory ?? 0);
            this._rows.memory.value.text = percent(this._memory);
        } else {
            this.display({ring: this._cpu ?? 0, ringText: percent(this._cpu)});
        }
    }

    async _update() {
        try {
            const [stat, meminfo] = await Promise.all([
                readFile('/proc/stat', this.cancellable),
                readFile('/proc/meminfo', this.cancellable),
            ]);
            this._readCpu(stat);
            this._readMemory(meminfo);
            this.refresh();
        } catch {
            // Leitura cancelada ou falha pontual: a próxima rodada corrige.
        }
    }

    _readCpu(stat) {
        const fields = stat.split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
        const idle = fields[3] + (fields[4] ?? 0);
        const total = fields.reduce((sum, n) => sum + n, 0);

        if (this._lastCpu && total > this._lastCpu.total) {
            this._cpu = 1 - (idle - this._lastCpu.idle) / (total - this._lastCpu.total);
        }
        this._lastCpu = {idle, total};
    }

    _readMemory(meminfo) {
        const read = key => Number(meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1]);
        const total = read('MemTotal');
        const available = read('MemAvailable');
        if (total && !Number.isNaN(available))
            this._memory = 1 - available / total;
    }

    onClick() {
        const appSystem = Shell.AppSystem.get_default();
        for (const id of MONITOR_APPS) {
            const app = appSystem.lookup_app(id);
            if (app) {
                app.activate();
                return;
            }
        }
    }
});
