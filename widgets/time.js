
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Widget} from './base.js';
import {registerClass} from '../registerClass.js';

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = n => String(n).padStart(2, '0');

function clockText(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export const ClockWidget = registerClass(
class ClockWidget extends Widget {
    onMiddleClick() {
        return this.launchApp('org.gnome.clocks.desktop');
    }

    setup() {
        this.every(5, () => this.refresh());
    }

    refresh() {
        const now = new Date();
        this.display({
            value: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
            caption: `${WEEKDAYS[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]}`,
        });
    }

    onClick() {
        Main.panel.statusArea.dateMenu?.menu.toggle();
    }
});

// Quanto do dia, da semana, do mês e do ano já passou.
export const TimeProgressWidget = registerClass(
class TimeProgressWidget extends Widget {
    setup() {
        this.createPanel();
        this.every(60, () => this.refresh());
    }

    refresh() {
        const now = new Date();
        const y = now.getFullYear();
        const m = now.getMonth();
        const startOfDay = new Date(y, m, now.getDate());
        // A semana começa na segunda-feira.
        const startOfWeek = new Date(y, m, now.getDate() - (now.getDay() + 6) % 7);
        const span = (start, end) => (now - start) / (end - start);

        const parts = [
            ['Dia', span(startOfDay, new Date(y, m, now.getDate() + 1))],
            ['Semana', span(startOfWeek, new Date(startOfWeek.getTime() + 7 * DAY_MS))],
            ['Mês', span(new Date(y, m, 1), new Date(y, m + 1, 1))],
            ['Ano', span(new Date(y, 0, 1), new Date(y + 1, 0, 1))],
        ];
        const percent = f => `${Math.floor(f * 100)}%`;

        this.display({
            ring: parts[0][1],
            ringText: percent(parts[0][1]),
            caption: 'Dia',
            value: `ano ${percent(parts[3][1])}`,
        });
        this.setPanelLines([
            ['Progresso do tempo', 'gprdock-panel-title'],
            ...parts.map(([label, fraction]) => [`${label}: ${percent(fraction)}`]),
        ]);
    }
});

// Dias que faltam para a data definida nas configurações.
export const CountdownWidget = registerClass(
class CountdownWidget extends Widget {
    setup() {
        this.createPanel();
        this._settings.connectObject(
            'changed::countdown-date', () => this.refresh(),
            'changed::countdown-label', () => this.refresh(), this);
        this.every(60, () => this.refresh());
    }

    refresh() {
        const label = this._settings.get_string('countdown-label') || 'Contagem';
        const match = this._settings.get_string('countdown-date')
            .match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) {
            this.display({icon: 'x-office-calendar-symbolic', caption: label, value: 'Sem data', short: '—'});
            this.setPanelLines([['Defina a data em Configurações › Ajustes']]);
            return;
        }

        const target = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const days = Math.round((target - today) / DAY_MS);

        let text = 'É hoje';
        if (days > 0)
            text = days === 1 ? 'Falta 1 dia' : `Faltam ${days} dias`;
        else if (days < 0)
            text = days === -1 ? 'Há 1 dia' : `Há ${-days} dias`;

        this.display({
            icon: 'x-office-calendar-symbolic',
            caption: label,
            value: text,
            short: `${Math.abs(days)}d`,
        });
        this.setPanelLines([
            [label, 'gprdock-panel-title'],
            [`${text} · ${pad(target.getDate())}/${pad(target.getMonth() + 1)}/${target.getFullYear()}`],
        ]);
    }

    onDestroy() {
        this._settings.disconnectObject(this);
    }
});

// Clique inicia ou pausa; clique direito zera.
export const StopwatchWidget = registerClass(
class StopwatchWidget extends Widget {
    onMiddleClick() {
        return this.launchApp('org.gnome.clocks.desktop');
    }

    setup() {
        this._elapsed = 0;       // ms acumulados antes da última largada
        this._startedAt = null;
        this._ticker = 0;
    }

    _total() {
        return this._elapsed + (this._startedAt ? Date.now() - this._startedAt : 0);
    }

    refresh() {
        this.display({
            icon: 'alarm-symbolic',
            caption: this._startedAt ? 'Cronômetro' : 'Cronômetro · parado',
            value: clockText(Math.floor(this._total() / 1000)),
        });
    }

    onClick() {
        if (this._startedAt) {
            this._elapsed = this._total();
            this._startedAt = null;
            this.cancelTimer(this._ticker);
            this._ticker = 0;
        } else {
            this._startedAt = Date.now();
            this._ticker = this.every(1, () => this.refresh());
        }
        this.refresh();
    }

    onSecondaryClick() {
        if (this._ticker)
            this.cancelTimer(this._ticker);
        this._ticker = 0;
        this._elapsed = 0;
        this._startedAt = null;
        this.refresh();
    }
});

// Contagem regressiva com a duração das configurações. Clique inicia ou
// pausa; clique direito zera.
export const TimerWidget = registerClass(
class TimerWidget extends Widget {
    onMiddleClick() {
        return this.launchApp('org.gnome.clocks.desktop');
    }

    setup() {
        this._ticker = 0;
        this._endsAt = null;
        this._remaining = this._duration();
        this._settings.connectObject('changed::timer-minutes', () => {
            if (!this._endsAt)
                this._remaining = this._duration();
            this.refresh();
        }, this);
    }

    _duration() {
        return this._settings.get_int('timer-minutes') * 60;
    }

    _left() {
        return this._endsAt
            ? Math.max(0, Math.ceil((this._endsAt - Date.now()) / 1000)) : this._remaining;
    }

    _stop() {
        if (this._ticker)
            this.cancelTimer(this._ticker);
        this._ticker = 0;
        this._endsAt = null;
    }

    _tick() {
        if (this._endsAt && this._left() === 0) {
            this._stop();
            this._remaining = this._duration();
            Main.notify('Timer encerrado',
                `Passaram os ${this._settings.get_int('timer-minutes')} minutos.`);
        }
        this.refresh();
    }

    refresh() {
        const left = this._left();
        this.display({
            ring: 1 - left / this._duration(),
            caption: this._endsAt ? 'Timer' : 'Timer · parado',
            value: clockText(left),
        });
    }

    onClick() {
        if (this._endsAt) {
            this._remaining = this._left();
            this._stop();
        } else {
            this._endsAt = Date.now() + this._remaining * 1000;
            this._ticker = this.every(1, () => this._tick());
        }
        this.refresh();
    }

    onSecondaryClick() {
        this._stop();
        this._remaining = this._duration();
        this.refresh();
    }

    onDestroy() {
        this._settings.disconnectObject(this);
    }
});
