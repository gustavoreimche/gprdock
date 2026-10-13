import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Widget} from './base.js';
import {registerClass} from '../registerClass.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SOON_MINUTES = 5;
const LISTED = 8;

const clock = date => date.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'});
const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());

// O compromisso que vem a seguir, com quanto falta. Usa a mesma agenda que o
// GNOME mostra ao clicar no relógio (as contas de Configurações › Contas
// Online); ela só entrega horário e título, então o link da reunião não vem:
// o clique do meio abre o Teams, ou a Agenda se ele não estiver instalado.
export const MeetingWidget = registerClass(
class MeetingWidget extends Widget {
    setup() {
        this._events = [];
        this._source = null;
        this.createPanel();
        this._attach();
        this.every(20, () => {
            this._attach();
            this._load();
        });
    }

    // A agenda pertence ao relógio do painel, que pode trocá-la (bloqueio de
    // tela, outra sessão).
    _attach() {
        const source = Main.panel.statusArea.dateMenu?._eventSource ?? null;
        if (source === this._source)
            return;
        this._source?.disconnectObject(this);
        this._source = source;
        source?.connectObject('changed', () => this._load(), this);
        this._load();
    }

    _load() {
        const now = new Date();
        const today = startOfDay(now);
        let events = [];
        try {
            events = this._source?.getEvents(now, new Date(today.getTime() + 2 * DAY_MS)) ?? [];
        } catch {
            // Agenda ainda carregando.
        }
        // Os de dia inteiro (feriado, aniversário) não são reunião.
        this._events = events
            .filter(e => e.end > now && e.end - e.date < DAY_MS)
            .sort((a, b) => a.date - b.date);
        this.refresh();
    }

    _teams() {
        return Shell.AppSystem.get_default().get_installed()
            .map(info => Shell.AppSystem.get_default().lookup_app(info.get_id()))
            .find(app => app && /\bteams\b/i.test(app.get_name())) ?? null;
    }

    onMiddleClick() {
        const teams = this._teams();
        if (teams) {
            teams.activate();
            return true;
        }
        return this.launchApp('org.gnome.Calendar.desktop');
    }

    _when(event, now) {
        if (event.date <= now)
            return {text: `agora, até ${clock(event.end)}`, short: 'agora', soon: true};
        const minutes = Math.ceil((event.date - now) / 60000);
        if (minutes <= 90) {
            const text = minutes < 60 ? `em ${minutes} min`
                : `em 1 h${minutes > 60 ? ` ${minutes - 60} min` : ''}`;
            return {text, short: minutes < 60 ? `${minutes}m` : '1h+', soon: minutes <= SOON_MINUTES};
        }
        const tomorrow = event.date >= new Date(startOfDay(now).getTime() + DAY_MS);
        return {
            text: `${tomorrow ? 'amanhã' : 'hoje'} às ${clock(event.date)}`,
            short: clock(event.date),
            soon: false,
        };
    }

    refresh() {
        const now = new Date();
        const [next] = this._events;
        const lines = [['Próximos compromissos', 'gprdock-panel-title']];

        if (!this._source?.hasCalendars) {
            this.display({icon: 'x-office-calendar-symbolic',
                caption: 'Agenda', value: 'Sem agenda', short: '—'});
            lines.push(['Adicione a conta em Configurações › Contas Online, com Agenda ligada']);
            this.remove_style_class_name('gprdock-state-warn');
            this.setPanelLines(lines);
            return;
        }

        if (next) {
            const when = this._when(next, now);
            this.display({
                icon: 'x-office-calendar-symbolic',
                caption: when.text,
                value: next.summary || 'Sem título',
                short: when.short,
            });
            if (when.soon)
                this.add_style_class_name('gprdock-state-warn');
            else
                this.remove_style_class_name('gprdock-state-warn');
        } else {
            this.display({icon: 'x-office-calendar-symbolic',
                caption: 'Agenda', value: 'Nada até amanhã', short: '✓'});
            this.remove_style_class_name('gprdock-state-warn');
            lines.push(['Nenhum compromisso até o fim de amanhã']);
        }

        const tomorrow = new Date(startOfDay(now).getTime() + DAY_MS);
        let day = null;
        for (const event of this._events.slice(0, LISTED)) {
            const label = event.date >= tomorrow ? 'Amanhã' : 'Hoje';
            if (label !== day)
                lines.push([day = label]);
            lines.push([`${clock(event.date)}–${clock(event.end)}  ${event.summary || 'Sem título'}`,
                'gprdock-panel-text']);
        }

        this.setPanelLines(lines);
    }

    onDestroy() {
        this._source?.disconnectObject(this);
    }
});
