import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import {registerClass} from '../registerClass.js';

// As cores vêm do CSS: `color` é o traço preenchido e a trilha é a mesma cor
// com pouca opacidade, então cada tema só precisa definir uma cor.
const TRACK_ALPHA = 0.18;
const GLOW_ALPHA = 0.28;
const FILL_TIME = 600;          // ms para o medidor chegar ao valor novo

function setSource(cr, color, alpha = 1) {
    cr.setSourceRGBA(
        color.red / 255, color.green / 255, color.blue / 255,
        (color.alpha / 255) * alpha);
}

// Base dos medidores: `fraction` é uma propriedade de verdade, para o
// Clutter poder animá-la; atribuí-la vai direto ao valor. `show(valor)` é o
// que os widgets usam: anima até lá (a primeira leitura só aparece).
const Gauge = registerClass({
    Properties: {
        'fraction': GObject.ParamSpec.double(
            'fraction', null, null, GObject.ParamFlags.READWRITE, 0, 1, 0),
    },
}, class Gauge extends St.DrawingArea {
    _init(params = {}) {
        this._fraction = 0;
        this._fresh = true;
        super._init(params);
    }

    get fraction() {
        return this._fraction;
    }

    set fraction(value) {
        value = Math.clamp(value || 0, 0, 1);
        if (value === this._fraction)
            return;
        this._fraction = value;
        this.notify('fraction');
        if (this.get_stage())
            this.queue_repaint();
    }

    show(value) {
        value = Math.clamp(value || 0, 0, 1);
        this.remove_transition('fraction');
        // Fora da tela (widget de outro perfil) não se anima nem redesenha.
        if (this._fresh || !this.get_stage()) {
            this._fresh = false;
            this.fraction = value;
            return;
        }
        this.ease_property('fraction', value, {
            duration: FILL_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }
});

export const Ring = registerClass(
class Ring extends Gauge {
    _init(params = {}) {
        super._init({style_class: 'gprdock-ring', ...params});
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const color = this.get_theme_node().get_foreground_color();
        const side = Math.min(width, height);
        const lineWidth = Math.max(2, side * 0.1);
        const radius = (side - lineWidth) / 2 - 1;
        const fraction = this._fraction;

        cr.setLineCap(1); // arredondado

        cr.setLineWidth(lineWidth);
        setSource(cr, color, TRACK_ALPHA);
        cr.arc(width / 2, height / 2, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (fraction > 0) {
            const start = -Math.PI / 2;
            const end = start + 2 * Math.PI * fraction;
            // Um halo largo e fraco por baixo do traço: o anel "acende".
            cr.setLineWidth(lineWidth * 2);
            setSource(cr, color, GLOW_ALPHA * Math.min(1, fraction * 3));
            cr.arc(width / 2, height / 2, radius, start, end);
            cr.stroke();

            cr.setLineWidth(lineWidth);
            setSource(cr, color);
            cr.arc(width / 2, height / 2, radius, start, end);
            cr.stroke();

            // Ponta mais clara, para o fim do traço se destacar.
            cr.setSourceRGBA(1, 1, 1, 0.55);
            cr.arc(width / 2 + Math.cos(end) * radius, height / 2 + Math.sin(end) * radius,
                lineWidth * 0.28, 0, 2 * Math.PI);
            cr.fill();
        }

        cr.$dispose();
    }
});

export const Bar = registerClass(
class Bar extends Gauge {
    _init(params = {}) {
        super._init({style_class: 'gprdock-bar', ...params});
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const color = this.get_theme_node().get_foreground_color();
        const radius = height / 2;
        const fraction = this._fraction;

        const pill = w => {
            w = Math.max(w, height);
            cr.newSubPath();
            cr.arc(radius, radius, radius, Math.PI / 2, 3 * Math.PI / 2);
            cr.arc(w - radius, radius, radius, -Math.PI / 2, Math.PI / 2);
            cr.closePath();
        };

        setSource(cr, color, TRACK_ALPHA);
        pill(width);
        cr.fill();

        if (fraction > 0) {
            const w = width * fraction;
            setSource(cr, color);
            pill(w);
            cr.fill();
            // Brilho na metade de cima da barra cheia.
            cr.save();
            pill(w);
            cr.clip();
            cr.setSourceRGBA(1, 1, 1, 0.22);
            cr.rectangle(0, 0, w, height / 2);
            cr.fill();
            cr.restore();
        }

        cr.$dispose();
    }
});

// Mapa de atividade no estilo do GitHub: uma coluna por semana, uma linha
// por dia, mais forte quanto mais contribuições no dia.
export const Heatmap = registerClass(
class Heatmap extends St.DrawingArea {
    _init(params = {}) {
        super._init({style_class: 'gprdock-heatmap', ...params});
        this._weeks = [];
        this._max = 0;
    }

    // weeks: lista de semanas, cada uma com até 7 contagens (dom a sáb).
    set weeks(weeks) {
        this._weeks = weeks;
        this._max = Math.max(0, ...weeks.flat());
        if (this.get_stage())
            this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const color = this.get_theme_node().get_foreground_color();
        const columns = Math.max(1, this._weeks.length);
        const gap = Math.max(1, Math.round(height / 40));
        const cell = Math.max(1, Math.min(
            (height - 6 * gap) / 7, (width - (columns - 1) * gap) / columns));
        const corner = Math.min(2, cell / 3);

        const rounded = (x, y) => {
            cr.newSubPath();
            cr.arc(x + cell - corner, y + corner, corner, -Math.PI / 2, 0);
            cr.arc(x + cell - corner, y + cell - corner, corner, 0, Math.PI / 2);
            cr.arc(x + corner, y + cell - corner, corner, Math.PI / 2, Math.PI);
            cr.arc(x + corner, y + corner, corner, Math.PI, 1.5 * Math.PI);
            cr.closePath();
        };

        this._weeks.forEach((week, x) => {
            week.forEach((count, y) => {
                // Quatro níveis, como no GitHub; dia sem nada fica só a trilha.
                const level = count > 0 && this._max > 0
                    ? Math.ceil(4 * count / this._max) : 0;
                setSource(cr, color, [0.12, 0.38, 0.58, 0.8, 1][level]);
                rounded(x * (cell + gap), y * (cell + gap));
                cr.fill();
            });
        });

        cr.$dispose();
    }
});
