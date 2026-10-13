import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Widget} from './base.js';
import {registerClass} from '../registerClass.js';

const WEEKDAYS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
const WEEKDAY_NAMES = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira',
    'Quinta-feira', 'Sexta-feira', 'Sábado'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho',
    'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export const CalendarWidget = registerClass(
class CalendarWidget extends Widget {
    onMiddleClick() {
        return this.launchApp('org.gnome.Calendar.desktop');
    }

    setup() {
        this.every(30, () => this.refresh());
    }

    // A folhinha (dia da semana em cima, número embaixo) é o quadrado; o
    // retângulo põe ao lado dela o dia e o mês por extenso.
    build(size) {
        const leaf = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'gprdock-calendar-leaf',
            x_expand: size === 'square',
            y_expand: true,
        });
        this._weekday = new St.Label({
            style_class: 'gprdock-calendar-weekday',
            x_align: Clutter.ActorAlign.FILL,
        });
        this._day = new St.Label({
            style_class: 'gprdock-calendar-day',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        leaf.add_child(this._weekday);
        leaf.add_child(this._day);
        this._long = null;
        if (size === 'square')
            return leaf;

        leaf.style = `width: ${this._dock.tileSize}px;`;
        const box = new St.BoxLayout({style_class: 'gprdock-calendar-wide'});
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'gprdock-tile-text',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._long = {
            caption: new St.Label({style_class: 'gprdock-tile-caption'}),
            value: new St.Label({style_class: 'gprdock-tile-value'}),
        };
        text.add_child(this._long.caption);
        text.add_child(this._long.value);
        box.add_child(leaf);
        box.add_child(text);
        return box;
    }

    refresh() {
        const now = new Date();
        this._weekday.text = WEEKDAYS[now.getDay()];
        this._day.text = `${now.getDate()}`;
        if (this._long) {
            this._long.caption.text = WEEKDAY_NAMES[now.getDay()];
            this._long.value.text = `${now.getDate()} de ${MONTHS[now.getMonth()]}`;
        }
    }

    onClick() {
        Main.panel.statusArea.dateMenu?.menu.toggle();
    }
});
