import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Widget, isCancelled, readFile, runCommand} from './base.js';
import {Bar} from './gauges.js';
import {registerClass} from '../registerClass.js';

const INTERVAL_SECONDS = 2;
const MONITOR_APPS = [
    'net.nokyan.Resources.desktop',
    'org.gnome.SystemMonitor.desktop',
    'gnome-system-monitor.desktop',
];
// Sensores de temperatura do processador, na ordem de preferência.
const CPU_SENSORS = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal'];
// Discos de verdade em /proc/diskstats (sem partições, loop, zram...).
const PHYSICAL_DISK = /^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|mmcblk\d+)$/;
const TOP_PROCESSES = 5;
// Do mais vazio ao mais cheio, para o uso de cada núcleo numa linha só.
const LEVELS = '▁▂▃▄▅▆▇█';

function decimal(value, digits = 1) {
    return value.toFixed(digits).replace('.', ',');
}

function gigabytes(kib) {
    return `${decimal(kib / 1024 / 1024)} GB`;
}

function rate(bytesPerSecond) {
    const units = ['B/s', 'kB/s', 'MB/s', 'GB/s'];
    let value = bytesPerSecond;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    return `${decimal(value, unit > 0 && value < 10 ? 1 : 0)} ${units[unit]}`;
}

function duration(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor(seconds % 86400 / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    if (days > 0)
        return `${days} d ${hours} h`;
    return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

// Clique direito: o painel com os detalhes de cada recurso (núcleos,
// memória, GPU, disco, rede e os processos que mais gastam), atualizado
// enquanto fica aberto. Clique esquerdo: o monitor do sistema.
export const ActivityWidget = registerClass(
class ActivityWidget extends Widget {
    onMiddleClick() {
        return this.launchApp(...MONITOR_APPS);
    }

    setup() {
        this._cpu = null;
        this._memory = null;
        this._lastCpu = null;
        // Só com o painel aberto: leituras anteriores para calcular taxas.
        this._last = null;
        this._sensor = undefined;     // caminho do sensor; null se não houver
        this._lines = [];
        const panel = this.createPanel({wide: true});
        // Vazio, o painel não abre; o conteúdo vem na primeira leitura.
        this.setPanelLines([['Lendo…', 'gprdock-panel-text']]);
        panel.connect('open-state-changed', (_menu, open) => {
            this._last = null;
            if (open)
                this._update();
        });
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
            if (this._panel?.isOpen)
                await this._updateDetails(stat, meminfo);
        } catch (e) {
            // Leitura cancelada ou falha pontual: a próxima rodada corrige.
            if (!isCancelled(e) && this._panel?.isOpen)
                logError(e, 'gprdock: atividade');
        }
    }

    // ---------- Painel de detalhes ----------

    async _updateDetails(stat, meminfo) {
        const optional = promise => promise.catch(e => {
            if (isCancelled(e))
                throw e;
            return null;
        });
        if (this._sensor === undefined)
            this._sensor = await optional(this._findSensor());
        const [loadavg, uptime, cpuinfo, diskstats, netdev, procs, temp, gpu] = await Promise.all([
            readFile('/proc/loadavg', this.cancellable),
            readFile('/proc/uptime', this.cancellable),
            optional(readFile('/proc/cpuinfo', this.cancellable)),
            optional(readFile('/proc/diskstats', this.cancellable)),
            optional(readFile('/proc/net/dev', this.cancellable)),
            // Some processo some no meio da leitura: o cat sai com erro, mas
            // o que leu serve.
            optional(runCommand(['sh', '-c', 'cat /proc/[0-9]*/stat 2>/dev/null; true'], this.cancellable)),
            this._sensor ? optional(readFile(this._sensor, this.cancellable)) : null,
            GLib.find_program_in_path('nvidia-smi')
                ? optional(runCommand(['nvidia-smi', '--format=csv,noheader,nounits',
                    '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu'],
                this.cancellable))
                : null,
        ]);
        if (!this._panel?.isOpen)
            return;

        const now = GLib.get_monotonic_time() / 1e6;
        const current = {
            time: now,
            cores: this._readCores(stat),
            disk: diskstats ? this._readDisks(diskstats) : null,
            net: netdev ? this._readNet(netdev) : null,
            procs: procs ? this._readProcesses(procs) : null,
            cpuTotal: this._lastCpu?.total ?? 0,
        };
        const last = this._last;
        this._last = current;
        const seconds = last ? current.time - last.time : 0;

        const lines = [];
        const title = text => lines.push([text, 'gprdock-panel-title']);
        const text = value => lines.push([value, 'gprdock-panel-text']);

        // Processador
        const mhz = [...(cpuinfo ?? '').matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map(m => Number(m[1]));
        const cpuHead = [`${this._cpu === null ? '—' : Math.round(this._cpu * 100)}%`];
        if (mhz.length > 0)
            cpuHead.push(`${decimal(mhz.reduce((a, b) => a + b, 0) / mhz.length / 1000)} GHz`);
        if (temp)
            cpuHead.push(`${Math.round(Number(temp) / 1000)} °C`);
        title(`Processador · ${cpuHead.join(' · ')}`);
        if (last) {
            const usage = current.cores.map((core, i) => {
                const before = last.cores[i];
                if (!before || core.total <= before.total)
                    return 0;
                return 1 - (core.idle - before.idle) / (core.total - before.total);
            });
            text(usage.map(u => LEVELS[Math.min(LEVELS.length - 1, Math.floor(u * LEVELS.length))]).join(''));
            const busiest = usage.indexOf(Math.max(...usage));
            text(`${usage.length} núcleos · o mais ocupado (${busiest}) em ${Math.round(usage[busiest] * 100)}%`);
        } else {
            // As mesmas linhas de quando já há medida, para o painel não
            // mudar de tamanho na leitura seguinte.
            text(LEVELS[0].repeat(current.cores.length));
            text(`${current.cores.length} núcleos · medindo…`);
        }
        const [l1, l5, l15] = loadavg.split(/\s+/);
        text(`Carga ${l1.replace('.', ',')} · ${l5.replace('.', ',')} · ${l15.replace('.', ',')} (1, 5 e 15 min)`);
        text(`Ligado há ${duration(Number(uptime.split(/\s+/)[0]))}`);

        // Memória
        const read = key => Number(meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
        const total = read('MemTotal');
        const available = read('MemAvailable');
        title(`Memória · ${this._memory === null ? '—' : Math.round(this._memory * 100)}%`);
        text(`Em uso ${gigabytes(total - available)} de ${gigabytes(total)}`);
        text(`Cache ${gigabytes(read('Cached') + read('Buffers'))} · disponível ${gigabytes(available)}`);
        const swapTotal = read('SwapTotal');
        if (swapTotal > 0)
            text(`Swap ${gigabytes(swapTotal - read('SwapFree'))} de ${gigabytes(swapTotal)}`);

        // Placa de vídeo
        for (const row of (gpu ?? '').trim().split('\n').filter(Boolean)) {
            const [name, util, used, size, gpuTemp] = row.split(',').map(field => field.trim());
            title(`GPU · ${util}%${gpuTemp ? ` · ${gpuTemp} °C` : ''}`);
            text(name);
            text(`Memória ${decimal(Number(used) / 1024)} de ${decimal(Number(size) / 1024)} GB`);
        }

        // Disco e rede
        if (current.disk && current.net) {
            title('Disco e rede');
            if (last?.disk && seconds > 0) {
                text(`Disco: lendo ${rate((current.disk.read - last.disk.read) / seconds)}` +
                    ` · gravando ${rate((current.disk.write - last.disk.write) / seconds)}`);
                text(`Rede: ↓ ${rate((current.net.rx - last.net.rx) / seconds)}` +
                    ` · ↑ ${rate((current.net.tx - last.net.tx) / seconds)}`);
            } else {
                text('Disco: medindo…');
                text('Rede: medindo…');
            }
        }

        // Processos: os que mais gastam processador e os que mais ocupam
        // memória. Cada um abre as opções para encerrá-lo.
        if (current.procs) {
            const ticks = current.cpuTotal - (last?.cpuTotal ?? 0);
            const all = [...current.procs.entries()].map(([pid, proc]) => ({
                ...proc,
                pid,
                cpu: last?.procs?.has(pid) && ticks > 0
                    ? (proc.ticks - last.procs.get(pid).ticks) / ticks : 0,
            }));
            const label = proc => `${proc.name} · ${Math.round(proc.cpu * 100)}% · ${gigabytes(proc.rss)}`;
            title(`Mais processador · ${all.length} processos`);
            for (const proc of [...all].sort((a, b) => b.cpu - a.cpu || b.rss - a.rss).slice(0, TOP_PROCESSES))
                lines.push([label(proc), 'process', null, proc]);
            title('Mais memória');
            for (const proc of [...all].sort((a, b) => b.rss - a.rss || b.cpu - a.cpu).slice(0, TOP_PROCESSES))
                lines.push([label(proc), 'process', null, proc]);
        }

        lines.push(['Abrir o monitor do sistema', null, () => this.onMiddleClick()]);
        this._setLines(lines);
    }

    // Aberto, o painel só troca os textos: refazer os itens a cada leitura
    // o faria piscar e mudar de tamanho. Com as opções de um processo
    // abertas, nada muda: a lista não pode trocar de lugar embaixo do
    // clique em "Encerrar".
    _setLines(lines) {
        if (this._lines.some(item => item.menu?.isOpen))
            return;
        const same = this._lines.length === lines.length &&
            this._lines.every((item, i) => item._styleClass === lines[i][1]);
        if (!same) {
            this._panel.removeAll();
            this._lines = lines.map(([text, styleClass, onActivate, proc]) => {
                if (proc)
                    return this._addProcessItem(text, proc);
                const item = new PopupMenu.PopupMenuItem(text, {
                    reactive: Boolean(onActivate),
                    can_focus: Boolean(onActivate),
                });
                item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                item._styleClass = styleClass;
                if (styleClass)
                    item.label.add_style_class_name(styleClass);
                if (onActivate)
                    item.connect('activate', onActivate);
                this._panel.addMenuItem(item);
                return item;
            });
            return;
        }
        lines.forEach(([text, , , proc], i) => {
            this._lines[i].label.text = text;
            if (proc)
                this._lines[i]._proc = proc;
        });
    }

    _addProcessItem(text, proc) {
        const item = new PopupMenu.PopupSubMenuMenuItem(text);
        item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        item.label.add_style_class_name('gprdock-panel-text');
        item._styleClass = 'process';
        item._proc = proc;
        // O título das opções diz qual processo vai ser encerrado, lido na
        // hora de abrir (a lista fica parada enquanto elas estão abertas).
        const about = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        about.label.add_style_class_name('gprdock-panel-text');
        item.menu.addMenuItem(about);
        item.menu.addAction('Encerrar', () => this._kill(item._proc, 'TERM'));
        item.menu.addAction('Forçar o encerramento', () => this._kill(item._proc, 'KILL'));
        item.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                about.label.text = `${item._proc.name} (processo ${item._proc.pid})`;
        });
        this._panel.addMenuItem(item);
        return item;
    }

    async _kill(proc, signal) {
        try {
            await runCommand(['kill', `-${signal}`, proc.pid], this.cancellable);
        } catch (e) {
            if (!isCancelled(e))
                Main.notify('Atividade', `Não foi possível encerrar ${proc.name}: ${e.message}`);
        }
        this._update();
    }

    async _findSensor() {
        const names = await runCommand(['sh', '-c', 'grep -H . /sys/class/hwmon/hwmon*/name'], this.cancellable);
        for (const sensor of CPU_SENSORS) {
            const match = names.match(new RegExp(`^(.*)/name:${sensor}$`, 'm'));
            if (match)
                return `${match[1]}/temp1_input`;
        }
        return null;
    }

    _readCores(stat) {
        return stat.split('\n').filter(line => /^cpu\d/.test(line)).map(line => {
            const fields = line.trim().split(/\s+/).slice(1).map(Number);
            return {
                idle: fields[3] + (fields[4] ?? 0),
                total: fields.reduce((sum, n) => sum + n, 0),
            };
        });
    }

    // Bytes lidos e gravados desde o boot, somando os discos físicos.
    _readDisks(diskstats) {
        let read = 0, write = 0;
        for (const line of diskstats.split('\n')) {
            const fields = line.trim().split(/\s+/);
            if (PHYSICAL_DISK.test(fields[2] ?? '')) {
                read += Number(fields[5]) * 512;
                write += Number(fields[9]) * 512;
            }
        }
        return {read, write};
    }

    // Bytes recebidos e enviados, sem a interface local.
    _readNet(netdev) {
        let rx = 0, tx = 0;
        for (const line of netdev.split('\n').slice(2)) {
            const [name, data] = line.split(':');
            if (!data || name.trim() === 'lo')
                continue;
            const fields = data.trim().split(/\s+/).map(Number);
            rx += fields[0];
            tx += fields[8];
        }
        return {rx, tx};
    }

    // pid → {name, ticks (tempo de CPU), rss (KiB)}. O nome vem entre
    // parênteses e pode ter espaços, por isso o resto se lê depois do último.
    _readProcesses(output) {
        const pageKib = 4;
        const procs = new Map();
        for (const line of output.split('\n')) {
            const open = line.indexOf('(');
            const close = line.lastIndexOf(')');
            if (open < 0 || close < open)
                continue;
            const fields = line.slice(close + 2).split(' ');
            procs.set(line.slice(0, open).trim(), {
                name: line.slice(open + 1, close),
                ticks: Number(fields[11]) + Number(fields[12]),
                rss: Number(fields[21]) * pageKib,
            });
        }
        return procs;
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
});
