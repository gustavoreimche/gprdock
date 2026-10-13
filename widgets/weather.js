import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';
import St from 'gi://St';

import {Widget, httpGet, isCancelled} from './base.js';
import {registerClass} from '../registerClass.js';

const REFRESH_SECONDS = 30 * 60;
const RETRY_SECONDS = 60;
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// Códigos WMO usados pelo Open-Meteo: [limite superior, ícone, descrição].
const CONDITIONS = [
    [0, 'weather-clear', 'Céu limpo'],
    [2, 'weather-few-clouds', 'Poucas nuvens'],
    [3, 'weather-overcast', 'Nublado'],
    [48, 'weather-fog', 'Neblina'],
    [57, 'weather-showers-scattered', 'Garoa'],
    [67, 'weather-showers', 'Chuva'],
    [77, 'weather-snow', 'Neve'],
    [82, 'weather-showers', 'Pancadas de chuva'],
    [86, 'weather-snow', 'Neve'],
    [99, 'weather-storm', 'Tempestade'],
];

function condition(code, isDay = true) {
    const [, icon, text] = CONDITIONS.find(([max]) => code <= max) ?? CONDITIONS[2];
    const night = !isDay && (icon === 'weather-clear' || icon === 'weather-few-clouds');
    return [`${icon}${night ? '-night' : ''}-symbolic`, text];
}

export const WeatherWidget = registerClass(
class WeatherWidget extends Widget {
    onMiddleClick() {
        return this.launchApp('org.gnome.Weather.desktop');
    }

    setup() {
        this.display({icon: 'weather-overcast-symbolic', value: '—',
            caption: this._settings.get_string('weather-city')});
        this.createPanel();
        this.setPanelLines([['Carregando previsão…']]);

        this._session = new Soup.Session({timeout: 15});
        this._loaded = false;
        this._days = [];
        this._dayBox = null;
        this._settings.connectObject(
            'changed::weather-latitude', () => this._fetch(),
            'changed::weather-longitude', () => this._fetch(),
            'changed::weather-city', () => this._fetch(), this);

        this._fetch();
        this.every(REFRESH_SECONDS, () => this._fetch());
    }

    // Grande: o desenho padrão e, ao lado, uma coluna para cada dia.
    build(size) {
        const tile = super.build(size);
        this._dayBox = null;
        if (size !== 'large')
            return tile;

        const box = new St.BoxLayout({style_class: 'gprdock-weather-large'});
        this._dayBox = new St.BoxLayout({
            style_class: 'gprdock-weather-days',
            y_align: Clutter.ActorAlign.CENTER,
        });
        tile.x_expand = false;
        box.add_child(tile);
        box.add_child(this._dayBox);
        return box;
    }

    refresh() {
        super.refresh();
        if (!this._dayBox)
            return;

        this._dayBox.destroy_all_children();
        for (const day of this._days) {
            const column = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'gprdock-weather-day',
            });
            column.add_child(new St.Label({
                style_class: 'gprdock-tile-caption',
                text: day.weekday,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            column.add_child(new St.Icon({
                style_class: 'gprdock-weather-day-icon',
                icon_name: day.icon,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            column.add_child(new St.Label({
                style_class: 'gprdock-weather-day-range',
                text: `${day.max}° ${day.min}°`,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            this._dayBox.add_child(column);
        }
    }

    async _fetch() {
        const lat = this._settings.get_double('weather-latitude');
        const lon = this._settings.get_double('weather-longitude');
        const url = 'https://api.open-meteo.com/v1/forecast' +
            `?latitude=${lat}&longitude=${lon}` +
            '&current=temperature_2m,apparent_temperature,weather_code,is_day' +
            '&daily=weather_code,temperature_2m_max,temperature_2m_min' +
            '&timezone=auto&forecast_days=3';

        try {
            const response = await httpGet(this._session, url, null, this.cancellable);
            if (response.status !== 200)
                throw new Error(`HTTP ${response.status}`);
            this._show(JSON.parse(response.text));
        } catch (e) {
            if (isCancelled(e))
                return;
            // Mantém a última leitura boa; só avisa se nunca houve uma.
            if (!this._loaded)
                this.setPanelLines([['Sem previsão no momento']]);
            this.retryIn(RETRY_SECONDS, () => this._fetch());
        }
    }

    _show(data) {
        const {current, daily} = data;
        const city = this._settings.get_string('weather-city');
        const [icon, text] = condition(current.weather_code, current.is_day === 1);
        const temp = `${Math.round(current.temperature_2m)}°`;
        this._loaded = true;
        this._days = daily.time.map((day, i) => ({
            weekday: WEEKDAYS[new Date(`${day}T12:00:00`).getDay()],
            icon: condition(daily.weather_code[i])[0],
            min: Math.round(daily.temperature_2m_min[i]),
            max: Math.round(daily.temperature_2m_max[i]),
        }));
        this.display({icon, short: temp, value: `${temp} · ${text}`, caption: city});
        this.refresh();

        const lines = [
            [city, 'gprdock-panel-title'],
            [`${text} · sensação ${Math.round(current.apparent_temperature)}°`],
        ];
        daily.time.forEach((day, i) => {
            const weekday = WEEKDAYS[new Date(`${day}T12:00:00`).getDay()];
            const [, dayText] = condition(daily.weather_code[i]);
            const min = Math.round(daily.temperature_2m_min[i]);
            const max = Math.round(daily.temperature_2m_max[i]);
            lines.push([`${weekday}   ${min}° / ${max}°   ${dayText}`]);
        });
        this.setPanelLines(lines);
    }

    onDestroy() {
        this._settings.disconnectObject(this);
        this._session.abort();
    }
});
