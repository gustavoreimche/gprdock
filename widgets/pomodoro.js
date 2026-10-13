
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Widget} from './base.js';
import {registerClass} from '../registerClass.js';

const PHASES = {
    focus: {label: 'Foco', key: 'pomodoro-focus-minutes'},
    short: {label: 'Pausa', key: 'pomodoro-short-minutes'},
    long: {label: 'Pausa longa', key: 'pomodoro-long-minutes'},
};

const now = () => Math.floor(Date.now() / 1000);
const today = () => new Date().toLocaleDateString('sv-SE');

// Clique inicia ou pausa; clique direito zera e volta ao foco.
export const PomodoroWidget = registerClass(
class PomodoroWidget extends Widget {
    setup() {
        this._ticker = 0;
        this._restore();

        // Mudou uma duração: a fase parada passa a valer com o tempo novo.
        for (const {key} of Object.values(PHASES)) {
            this._settings.connectObject(`changed::${key}`, () => {
                if (!this._state.running)
                    this._setPhase(this._state.phase);
                this.refresh();
            }, this);
        }
        // A tela de configurações zera o pomodoro limpando esta chave.
        this._settings.connectObject('changed::pomodoro-state', () => {
            if (this._settings.get_string('pomodoro-state') === this._written)
                return;
            this._stopTicker();
            this._restore();
        }, this);
    }

    _seconds(phase) {
        return this._settings.get_int(PHASES[phase].key) * 60;
    }

    _restore() {
        let saved = null;
        try {
            saved = JSON.parse(this._settings.get_string('pomodoro-state'));
        } catch {
            // Sem estado salvo (ou ilegível): começa do zero.
        }

        this._state = PHASES[saved?.phase] ? saved : {
            phase: 'focus',
            running: false,
            remaining: this._seconds('focus'),
            cycles: 0,
            day: today(),
        };

        if (this._state.running)
            this._startTicker();
        this._tick();
    }

    _save() {
        this._written = JSON.stringify(this._state);
        this._settings.set_string('pomodoro-state', this._written);
    }

    _remaining() {
        const s = this._state;
        return s.running ? s.endsAt - now() : s.remaining;
    }

    _startTicker() {
        if (!this._ticker)
            this._ticker = this.every(1, () => this._tick());
    }

    _stopTicker() {
        if (this._ticker) {
            this.cancelTimer(this._ticker);
            this._ticker = 0;
        }
    }

    _tick() {
        if (this._state.day !== today()) {
            this._state.day = today();
            this._state.cycles = 0;
            this._save();
        }

        if (this._state.running && this._remaining() <= 0)
            this._finishPhase();
        this.refresh();
    }

    _finishPhase() {
        const s = this._state;
        let next = 'focus';
        if (s.phase === 'focus') {
            s.cycles++;
            const perLongBreak = this._settings.get_int('pomodoro-cycles');
            next = s.cycles % perLongBreak === 0 ? 'long' : 'short';
            Main.notify('Foco concluído',
                `Hora da pausa de ${this._seconds(next) / 60} minutos.`);
        } else {
            Main.notify('Pausa encerrada', 'Clique no pomodoro para voltar ao foco.');
        }

        this._setPhase(next);
    }

    _setPhase(phase) {
        this._stopTicker();
        Object.assign(this._state, {
            phase,
            running: false,
            remaining: this._seconds(phase),
        });
        delete this._state.endsAt;
        this._save();
    }

    refresh() {
        const s = this._state;
        const phase = PHASES[s.phase];
        const remaining = Math.max(0, this._remaining());
        const time = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:` +
            `${String(remaining % 60).padStart(2, '0')}`;

        this.display({
            ring: Math.max(0, 1 - remaining / this._seconds(s.phase)),
            value: time,
            caption: s.cycles > 0 ? `${phase.label} · ${s.cycles} hoje` : phase.label,
        });

        if (s.phase === 'focus')
            this.remove_style_class_name('gprdock-pomodoro-break');
        else
            this.add_style_class_name('gprdock-pomodoro-break');
    }

    onClick() {
        const s = this._state;
        if (s.running) {
            s.remaining = Math.max(0, this._remaining());
            s.running = false;
            delete s.endsAt;
            this._stopTicker();
        } else {
            s.endsAt = now() + s.remaining;
            s.running = true;
            this._startTicker();
        }
        this._save();
        this.refresh();
    }

    onSecondaryClick() {
        this._setPhase('focus');
        this.refresh();
    }

    onDestroy() {
        this._settings.disconnectObject(this);
    }
});
