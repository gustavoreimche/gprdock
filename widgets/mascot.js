import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Widget, readFile} from './base.js';
import {registerClass} from '../registerClass.js';

const TICK = 40;                // ms entre quadros
const SLEEP_AFTER = 90 * 1000;  // ms sem teclado nem mouse para dormir
const CPU_HOT = 0.85;
const HAPPY_TIME = 1800;        // ms de festa depois de um clique
const BLINK_TIME = 160;
const LOOK_DISTANCE = 220;      // px até o cursor para o olhar ir ao limite
const WALK_SPEED = 26;          // px lógicos por segundo
const STEP_TIME = 520;          // ms de um ciclo de passos
// Gracinhas de quando ele está parado e acordado: nome e duração em ms.
const ANTICS = {
    stretch: 1300,              // espreguiça
    look: 2600,                 // olha em volta, sem ligar para o cursor
    tilt: 900,                  // inclina a cabeça
    wag: 1600,                  // balança a cauda (ou as asas)
};
const ANTIC_EVERY = [5000, 13000];   // ms entre uma gracinha e outra

const DARK = [0.10, 0.10, 0.14];
const WHITE = [1, 1, 1];

// [id, rótulo, cor do corpo, cor das orelhas/detalhes]
export const MASCOTS = [
    ['cat', 'Gato', [0.96, 0.64, 0.35], [0.85, 0.50, 0.24]],
    ['dog', 'Cachorro', [0.80, 0.58, 0.40], [0.52, 0.34, 0.22]],
    ['rabbit', 'Coelho', [0.92, 0.90, 0.95], [0.98, 0.70, 0.78]],
    ['bird', 'Passarinho', [0.42, 0.70, 0.98], [0.99, 0.75, 0.25]],
];

const lighten = (rgb, n) => rgb.map(c => Math.min(1, c + n));
const darken = (rgb, n) => rgb.map(c => Math.max(0, c - n));

// O bichinho, desenhado numa caixa de 100×100 centrada na origem, com os pés
// na borda de baixo. Tudo o que muda de quadro a quadro chega por `model`.
const MascotArt = registerClass(
class MascotArt extends St.DrawingArea {
    _init(params = {}) {
        super._init(params);
        this.model = {
            kind: 'cat', mood: 'awake', time: 0, look: [0, 0], blink: 0, hop: 0,
            step: null, direction: 1, antic: null,
        };
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const m = this.model;
        const {kind, mood, time, blink, hop, step, direction, antic} = m;
        const [, , body, detail] = MASCOTS.find(([id]) => id === kind) ?? MASCOTS[0];
        const side = Math.min(width, height);

        cr.translate(width / 2, height / 2);
        cr.scale(side / 100, side / 100);

        // Os de orelha ou penacho comprido encolhem em torno dos pés.
        const shrink = {rabbit: 0.74, bird: 0.9}[kind];
        if (shrink) {
            cr.translate(0, 47);
            cr.scale(shrink, shrink);
            cr.translate(0, -47);
        }

        const walking = step !== null;
        const stride = walking ? Math.sin(step * 2 * Math.PI) : 0;
        const anticPhase = antic ? antic.phase : 0;
        const bump = n => Math.sin(Math.min(1, Math.max(0, n)) * Math.PI);  // 0→1→0

        // Pulo (festa), balanço do passo e respiração.
        const jump = mood === 'happy' ? Math.abs(Math.sin(hop * Math.PI * 2)) * 11 : 0;
        const bob = walking ? Math.abs(stride) * 2.5 : 0;
        const breath = Math.sin(time * (mood === 'sleep' ? 1.4 : 2.4)) * (mood === 'sleep' ? 1.6 : 0.8);
        const shake = mood === 'hot' ? Math.sin(time * 40) * 0.8 : 0;
        // Espreguiçar estica o corpo para cima; o pulo esmaga ao cair.
        const stretch = antic?.kind === 'stretch' ? bump(anticPhase) * 0.12 : 0;
        const squash = mood === 'happy' ? Math.max(0, Math.cos(hop * Math.PI * 2)) * 0.06 : 0;
        const tilt = antic?.kind === 'tilt' ? bump(anticPhase) * 0.2 : 0;

        // Sombra no chão: encolhe quando ele sai do chão.
        cr.setSourceRGBA(0, 0, 0, 0.22);
        cr.save();
        cr.translate(0, 45);
        cr.scale(1 - jump / 30, 0.14);
        cr.arc(0, 0, 28, 0, 2 * Math.PI);
        cr.restore();
        cr.fill();

        const look = antic?.kind === 'look'
            ? [Math.sin(anticPhase * Math.PI * 2) * 0.9, -0.2] : m.look;

        // Cauda (atrás do corpo).
        cr.save();
        cr.translate(shake, -jump - bob);
        this._drawTail(cr, kind, body, detail, mood, time, walking ? stride : 0, antic, direction);
        cr.restore();

        // Pés: alternam enquanto anda.
        this._drawFeet(cr, kind, detail, walking, stride, direction, jump);

        cr.translate(shake, -jump - bob);
        // Inclina no sentido do passo e, na gracinha, de lado.
        cr.translate(0, 40);
        cr.rotate(stride * 0.06 * direction + tilt * direction);
        cr.scale(1 + squash - stretch * 0.4, 1 - squash + stretch);
        cr.translate(0, -40);

        const top = -24 - breath;
        const bottom = 40;

        if (kind === 'rabbit')
            this._drawRabbitEars(cr, body, detail, top, mood, stride, antic);
        if (kind === 'bird')
            this._drawCrest(cr, detail, top, time);

        this._drawBody(cr, kind, body, detail, top, bottom);

        if (kind === 'cat')
            this._drawCatEars(cr, body, detail, top, antic);
        else if (kind === 'dog')
            this._drawDogEars(cr, detail, top, walking ? stride : 0);

        this._drawArms(cr, kind, body, detail, top, walking, stride, direction, antic, mood, time);

        // O rosto vira um pouco para o lado em que ele anda.
        if (walking)
            cr.translate(direction * 4, 0);

        if (kind === 'dog')
            this._drawEyePatch(cr, detail);

        // Bochechas.
        cr.setSourceRGBA(1, 0.45, 0.55, mood === 'happy' || mood === 'hot' ? 0.6 : 0.3);
        for (const s of [-1, 1]) {
            cr.arc(s * 23, 14, 5, 0, 2 * Math.PI);
            cr.fill();
        }

        this._drawEyes(cr, kind, mood, look, blink);
        if (kind === 'cat')
            this._drawWhiskers(cr, time, mood);
        if (kind === 'dog')
            this._drawDogMouth(cr, mood, time);
        else if (kind === 'rabbit')
            this._drawRabbitMouth(cr, mood, time);
        else if (kind === 'bird')
            this._drawBeak(cr, detail, mood, time);
        else
            this._drawCatMouth(cr, mood);

        if (mood === 'sleep')
            this._drawSnore(cr, time);
        else if (mood === 'hot')
            this._drawSweat(cr, time);
        else if (mood === 'happy')
            this._drawParty(cr, hop);

        cr.$dispose();
    }

    // Corpo arredondado com luz vindo de cima e à esquerda.
    _drawBody(cr, kind, body, detail, top, bottom) {
        const half = kind === 'bird' ? 30 : 34;
        const radius = kind === 'bird' ? 28 : 22;
        cr.newPath();
        cr.arc(-half + radius, top + radius, radius, Math.PI, 1.5 * Math.PI);
        cr.arc(half - radius, top + radius, radius, 1.5 * Math.PI, 2 * Math.PI);
        cr.arc(half - radius, bottom - radius, radius, 0, 0.5 * Math.PI);
        cr.arc(-half + radius, bottom - radius, radius, 0.5 * Math.PI, Math.PI);
        cr.closePath();

        const shade = new Cairo.RadialGradient(-14, top + 14, 4, 0, top + 30, 70);
        shade.addColorStopRGB(0, ...lighten(body, 0.14));
        shade.addColorStopRGB(0.55, ...body);
        shade.addColorStopRGB(1, ...darken(body, 0.12));
        cr.setSource(shade);
        cr.fillPreserve();
        cr.setLineWidth(1.4);
        cr.setSourceRGBA(...darken(body, 0.3), 0.35);
        cr.stroke();

        // Barriga clara.
        cr.save();
        cr.translate(0, bottom - 16);
        cr.scale(1, 0.62);
        cr.arc(0, 0, kind === 'bird' ? 18 : 21, 0, 2 * Math.PI);
        cr.restore();
        cr.setSourceRGBA(1, 1, 1, kind === 'rabbit' ? 0.35 : 0.3);
        cr.fill();

        // O gato tem três listras na testa.
        if (kind === 'cat') {
            cr.setSourceRGBA(...detail, 0.8);
            cr.setLineWidth(2.4);
            cr.setLineCap(1);
            for (const x of [-7, 0, 7]) {
                cr.moveTo(x, top + 4);
                cr.lineTo(x * 1.3, top + 13);
                cr.stroke();
            }
        }
    }

    _drawFeet(cr, kind, detail, walking, stride, direction, jump) {
        cr.setSourceRGB(...(kind === 'bird' ? [0.99, 0.6, 0.2] : detail));
        for (const s of [-1, 1]) {
            const lift = walking ? Math.max(0, s * stride) * 5 : 0;
            const reach = walking ? s * stride * 3 * direction : 0;
            if (kind === 'bird') {
                // Patinhas finas, com três dedos.
                cr.setLineWidth(2.2);
                cr.setLineCap(1);
                const x = s * 10 + reach;
                const y = 36 - lift - jump;
                cr.moveTo(x, y);
                cr.lineTo(x, y + 8);
                for (const d of [-4, 0, 4]) {
                    cr.moveTo(x, y + 8);
                    cr.lineTo(x + d, y + 11);
                }
                cr.stroke();
                continue;
            }
            cr.save();
            cr.translate(s * 15 + reach, 42 - lift - jump);
            cr.scale(1, 0.6);
            cr.arc(0, 0, 9, 0, 2 * Math.PI);
            cr.restore();
            cr.fill();
            // Dedinhos.
            cr.setSourceRGBA(0, 0, 0, 0.18);
            for (const d of [-4, 0, 4]) {
                cr.arc(s * 15 + reach + d, 44 - lift - jump, 1.4, 0, 2 * Math.PI);
                cr.fill();
            }
            cr.setSourceRGB(...detail);
        }
    }

    // Bracinhos ao lado do corpo; balançam no passo e sobem no espreguiçar.
    // O passarinho tem asas, que batem na festa e no "wag".
    _drawArms(cr, kind, body, detail, top, walking, stride, direction, antic, mood, time) {
        const phase = antic ? antic.phase : 0;
        const up = antic?.kind === 'stretch' ? Math.sin(Math.min(1, phase) * Math.PI) : 0;
        const flap = kind === 'bird' && (mood === 'happy' || antic?.kind === 'wag' || walking)
            ? Math.sin(time * 18) * 0.5 : 0;
        for (const s of [-1, 1]) {
            cr.save();
            cr.translate(s * 31, 18);
            if (kind === 'bird') {
                cr.rotate(s * (-0.35 - flap + up * 0.8));
                cr.setSourceRGB(...darken(body, 0.1));
                cr.save();
                cr.scale(0.55, 1);
                cr.arc(0, 0, 16, 0, 2 * Math.PI);
                cr.restore();
                cr.fill();
            } else {
                const swing = walking ? -s * stride * 0.5 * direction : 0;
                cr.rotate(s * (0.25 + swing) - s * up * 2.4);
                cr.setSourceRGB(...body);
                cr.save();
                cr.scale(0.55, 1);
                cr.arc(0, 4, 11, 0, 2 * Math.PI);
                cr.restore();
                cr.fillPreserve();
                cr.setLineWidth(1.2);
                cr.setSourceRGBA(...darken(body, 0.3), 0.3);
                cr.stroke();
                cr.setSourceRGB(...detail);
                cr.arc(0, 12, 4.2, 0, 2 * Math.PI);
                cr.fill();
            }
            cr.restore();
        }
    }

    _drawTail(cr, kind, body, detail, mood, time, stride, antic, direction) {
        const wagging = antic?.kind === 'wag' || mood === 'happy';
        const side = -direction;    // a cauda fica atrás, oposta ao andar
        cr.save();
        cr.setLineCap(1);
        if (kind === 'cat') {
            // Cauda comprida que ondula; dormindo, enrola no corpo.
            const sway = mood === 'sleep' ? 0 : Math.sin(time * (wagging ? 9 : 2.2)) * (wagging ? 8 : 4);
            cr.setLineWidth(7);
            cr.setSourceRGB(...detail);
            cr.moveTo(side * 26, 30);
            if (mood === 'sleep')
                cr.curveTo(side * 44, 34, side * 46, 12, side * 30, 10);
            else
                cr.curveTo(side * 44, 30, side * 46 + sway, 4, side * 38 + sway, -10);
            cr.stroke();
            cr.setLineWidth(4);
            cr.setSourceRGB(...lighten(detail, 0.2));
            cr.arc(mood === 'sleep' ? side * 30 : side * 38 + sway,
                mood === 'sleep' ? 10 : -10, 3.5, 0, 2 * Math.PI);
            cr.fill();
        } else if (kind === 'dog') {
            // Cauda curta que abana (rápido na festa).
            const wag = mood === 'sleep' ? 0.2 : Math.sin(time * (wagging ? 22 : 5)) * (wagging ? 0.6 : 0.25);
            cr.translate(side * 30, 26);
            cr.rotate(side * (-0.9 + wag));
            cr.setLineWidth(7);
            cr.setSourceRGB(...detail);
            cr.moveTo(0, 0);
            cr.lineTo(0, -18);
            cr.stroke();
            cr.setSourceRGB(...lighten(detail, 0.25));
            cr.arc(0, -18, 3.5, 0, 2 * Math.PI);
            cr.fill();
        } else if (kind === 'rabbit') {
            // Pompom.
            cr.setSourceRGB(...WHITE);
            cr.arc(side * 30, 30, 7, 0, 2 * Math.PI);
            cr.fill();
            cr.setSourceRGBA(0, 0, 0, 0.08);
            cr.arc(side * 31, 32, 4, 0, 2 * Math.PI);
            cr.fill();
        } else {
            // Penas da cauda, em leque.
            const lift = wagging ? Math.sin(time * 14) * 0.25 : 0;
            cr.setLineWidth(5);
            for (const [i, a] of [[-1, 0.35], [0, 0.6], [1, 0.85]]) {
                cr.setSourceRGB(...(i === 0 ? darken(body, 0.15) : darken(body, 0.05)));
                cr.moveTo(side * 24, 28);
                const angle = a + lift + Math.abs(stride) * 0.1;
                cr.lineTo(side * (24 + Math.cos(angle) * 20), 28 + Math.sin(angle) * 16 - 8);
                cr.stroke();
            }
        }
        cr.restore();
    }

    _drawCatEars(cr, body, detail, top, antic) {
        // Uma orelha treme na gracinha "tilt".
        const twitch = antic?.kind === 'tilt' ? Math.sin(antic.phase * Math.PI * 6) * 0.15 : 0;
        for (const s of [-1, 1]) {
            cr.save();
            cr.translate(s * 27, top - 2);
            cr.rotate(s === 1 ? twitch : 0);
            cr.setSourceRGB(...body);
            cr.moveTo(s * 6, 22);
            cr.lineTo(0, -13);
            cr.lineTo(-s * 20, 5);
            cr.closePath();
            cr.fillPreserve();
            cr.setLineWidth(1.4);
            cr.setSourceRGBA(...darken(body, 0.3), 0.35);
            cr.stroke();
            cr.setSourceRGB(0.98, 0.65, 0.72);
            cr.moveTo(s * 3, 16);
            cr.lineTo(0, -6);
            cr.lineTo(-s * 12, 6);
            cr.closePath();
            cr.fill();
            cr.restore();
        }
    }

    // Orelhas caídas, que balançam com o passo.
    _drawDogEars(cr, detail, top, stride) {
        for (const s of [-1, 1]) {
            cr.save();
            cr.translate(s * 30, top + 8);
            cr.rotate(s * (-0.22 - stride * 0.12));
            cr.scale(0.5, 1);
            cr.arc(0, 16, 19, 0, 2 * Math.PI);
            cr.restore();
            cr.setSourceRGB(...detail);
            cr.fillPreserve();
            cr.setLineWidth(1.2);
            cr.setSourceRGBA(0, 0, 0, 0.18);
            cr.stroke();
        }
    }

    // Mancha escura em volta de um olho.
    _drawEyePatch(cr, detail) {
        cr.setSourceRGBA(...detail, 0.55);
        cr.arc(14, 2, 13, 0, 2 * Math.PI);
        cr.fill();
    }

    // Orelhas compridas; dormindo, uma delas dobra; andando, balançam.
    _drawRabbitEars(cr, body, detail, top, mood, stride, antic) {
        const twitch = antic?.kind === 'tilt' ? Math.sin(antic.phase * Math.PI * 6) * 0.12 : 0;
        for (const s of [-1, 1]) {
            const droop = mood === 'sleep' && s === 1 ? 0.9 : 0;
            cr.save();
            cr.translate(s * 15, top + 10);
            cr.rotate(s * (0.12 + droop + stride * 0.06) + (s === -1 ? twitch : 0));
            cr.setSourceRGB(...body);
            cr.save();
            cr.scale(0.36, 1);
            cr.arc(0, -30, 30, 0, 2 * Math.PI);
            cr.restore();
            cr.fillPreserve();
            cr.setLineWidth(1.3);
            cr.setSourceRGBA(0, 0, 0, 0.14);
            cr.stroke();
            cr.setSourceRGB(...detail);
            cr.save();
            cr.scale(0.2, 0.8);
            cr.arc(0, -36, 30, 0, 2 * Math.PI);
            cr.restore();
            cr.fill();
            cr.restore();
        }
    }

    // Penacho de três penas, que balança devagar.
    _drawCrest(cr, detail, top, time) {
        cr.setLineWidth(5);
        cr.setLineCap(1);
        for (const [i, a] of [[-1, -1.9], [0, -1.55], [1, -1.2]]) {
            cr.setSourceRGB(...(i === 0 ? detail : darken(detail, 0.1)));
            const angle = a + Math.sin(time * 2 + i) * 0.08;
            cr.moveTo(i * 4, top + 6);
            cr.lineTo(i * 4 + Math.cos(angle) * 18, top + 6 + Math.sin(angle) * 18);
            cr.stroke();
        }
    }

    _drawEyes(cr, kind, mood, look, blink) {
        const y = 2;
        const gap = kind === 'bird' ? 11 : 14;
        cr.setLineCap(1);

        for (const s of [-1, 1]) {
            const x = s * gap;
            if (mood === 'sleep' || mood === 'happy') {
                // Fechados: dormindo a curva desce, sorrindo ela sobe.
                cr.setLineWidth(3);
                cr.setSourceRGB(...DARK);
                if (mood === 'sleep')
                    cr.arc(x, y - 2, 6, 0.15 * Math.PI, 0.85 * Math.PI);
                else
                    cr.arc(x, y + 4, 6, 1.15 * Math.PI, 1.85 * Math.PI);
                cr.stroke();
                continue;
            }

            const open = Math.max(0.08, 1 - blink);
            const hot = mood === 'hot';
            const size = kind === 'bird' ? 7.5 : 9;
            cr.save();
            cr.translate(x, y);
            cr.scale(1, open);
            cr.arc(0, 0, hot ? size + 1 : size, 0, 2 * Math.PI);
            cr.setSourceRGB(...WHITE);
            cr.fillPreserve();
            // Contorno leve, para o olho aparecer também num corpo claro.
            cr.setLineWidth(1.2);
            cr.setSourceRGBA(...DARK, 0.35);
            cr.stroke();
            // Íris colorida e pupila.
            cr.setSourceRGB(...(kind === 'cat' ? [0.3, 0.6, 0.35] : kind === 'bird' ? [0.2, 0.2, 0.3] : [0.35, 0.25, 0.2]));
            cr.arc(look[0] * 4, look[1] * 4, hot ? 3.4 : size * 0.6, 0, 2 * Math.PI);
            cr.fill();
            cr.setSourceRGB(...DARK);
            cr.arc(look[0] * 4, look[1] * 4, hot ? 2.2 : size * 0.38, 0, 2 * Math.PI);
            cr.fill();
            if (!hot) {
                cr.setSourceRGB(...WHITE);
                cr.arc(look[0] * 4 - 1.8, look[1] * 4 - 2, 1.6, 0, 2 * Math.PI);
                cr.fill();
                cr.arc(look[0] * 4 + 1.6, look[1] * 4 + 1.6, 0.8, 0, 2 * Math.PI);
                cr.fill();
            }
            cr.restore();
        }
    }

    _drawWhiskers(cr, time, mood) {
        const wiggle = mood === 'sleep' ? 0 : Math.sin(time * 3) * 0.04;
        cr.setLineWidth(1.3);
        cr.setLineCap(1);
        cr.setSourceRGBA(...DARK, 0.55);
        for (const s of [-1, 1]) {
            for (const [dy, tilt] of [[-2, -4], [2, 0], [6, 4]]) {
                cr.moveTo(s * 9, 12 + dy);
                cr.lineTo(s * 28, 12 + dy + tilt + wiggle * 20);
                cr.stroke();
            }
        }
    }

    // O que é igual para todos: boca aberta na festa, bico no sono, tremida
    // no calor. Devolve falso quando o bicho deve desenhar a boca normal.
    _drawMoodMouth(cr, mood, y) {
        cr.setSourceRGB(...DARK);
        cr.setLineWidth(2.4);
        if (mood === 'happy') {
            cr.arc(0, y - 1, 7, 0, Math.PI);
            cr.closePath();
            cr.fill();
            cr.setSourceRGB(1, 0.45, 0.5);
            cr.arc(0, y + 3.5, 3.2, 0, 2 * Math.PI);
            cr.fill();
        } else if (mood === 'sleep') {
            cr.arc(0, y + 2, 2.6, 0, 2 * Math.PI);
            cr.fill();
        } else if (mood === 'hot') {
            cr.moveTo(-8, y + 3);
            cr.curveTo(-4, y - 2, -2, y + 8, 0, y + 3);
            cr.curveTo(2, y - 2, 4, y + 8, 8, y + 3);
            cr.stroke();
        } else {
            return false;
        }
        return true;
    }

    _drawCatMouth(cr, mood) {
        cr.setSourceRGB(0.98, 0.55, 0.62);
        cr.moveTo(-3, 10);
        cr.lineTo(3, 10);
        cr.lineTo(0, 13.5);
        cr.closePath();
        cr.fill();
        if (this._drawMoodMouth(cr, mood, 17))
            return;
        cr.setLineWidth(2.2);
        cr.arc(-4, 15, 4, 0.1 * Math.PI, 0.9 * Math.PI);
        cr.stroke();
        cr.arc(4, 15, 4, 0.1 * Math.PI, 0.9 * Math.PI);
        cr.stroke();
    }

    // Focinho claro com o nariz em cima; a língua sai no calor e na festa.
    _drawDogMouth(cr, mood, time) {
        cr.setSourceRGBA(1, 1, 1, 0.55);
        cr.save();
        cr.translate(0, 19);
        cr.scale(1, 0.72);
        cr.arc(0, 0, 15, 0, 2 * Math.PI);
        cr.restore();
        cr.fill();

        cr.setSourceRGB(...DARK);
        cr.save();
        cr.translate(0, 12);
        cr.scale(1, 0.7);
        cr.arc(0, 0, 5, 0, 2 * Math.PI);
        cr.restore();
        cr.fill();
        cr.setSourceRGBA(1, 1, 1, 0.5);
        cr.arc(-1.6, 10.5, 1.4, 0, 2 * Math.PI);
        cr.fill();

        if (mood === 'hot' || mood === 'happy') {
            // Língua de fora, balançando.
            const pant = mood === 'hot' ? Math.sin(time * 14) * 2 : 0;
            cr.setSourceRGB(1, 0.45, 0.5);
            cr.save();
            cr.translate(3, 26 + pant);
            cr.scale(0.6, 1);
            cr.arc(0, 0, 6, 0, 2 * Math.PI);
            cr.restore();
            cr.fill();
            cr.setSourceRGB(...DARK);
            cr.setLineWidth(2.2);
            cr.arc(-3, 19, 5, 0.1 * Math.PI, 0.9 * Math.PI);
            cr.stroke();
            return;
        }
        if (this._drawMoodMouth(cr, mood, 22))
            return;
        cr.setLineWidth(2.2);
        cr.arc(-4, 19, 4, 0.1 * Math.PI, 0.9 * Math.PI);
        cr.stroke();
        cr.arc(4, 19, 4, 0.1 * Math.PI, 0.9 * Math.PI);
        cr.stroke();
    }

    // Nariz rosa que mexe e os dois dentes.
    _drawRabbitMouth(cr, mood, time) {
        const twitch = mood === 'sleep' ? 0 : Math.max(0, Math.sin(time * 9)) * 1.2;
        cr.setSourceRGB(0.95, 0.5, 0.6);
        cr.moveTo(-4, 11 - twitch);
        cr.lineTo(4, 11 - twitch);
        cr.lineTo(0, 15 - twitch);
        cr.closePath();
        cr.fill();

        if (this._drawMoodMouth(cr, mood, 20))
            return;
        cr.setLineWidth(2);
        cr.setSourceRGB(...DARK);
        cr.arc(-4, 16, 4, 0.1 * Math.PI, 0.9 * Math.PI);
        cr.stroke();
        cr.arc(4, 16, 4, 0.1 * Math.PI, 0.9 * Math.PI);
        cr.stroke();
        cr.rectangle(-3.6, 19.5, 7.2, 6);
        cr.setSourceRGB(...WHITE);
        cr.fillPreserve();
        cr.setLineWidth(1);
        cr.setSourceRGBA(...DARK, 0.6);
        cr.stroke();
        cr.moveTo(0, 19.5);
        cr.lineTo(0, 25.5);
        cr.stroke();
    }

    // Bico, que abre na festa e no calor.
    _drawBeak(cr, detail, mood, time) {
        const open = mood === 'happy' ? 4 : mood === 'hot' ? 2 + Math.sin(time * 14) : 0;
        const beak = [0.99, 0.6, 0.2];
        cr.setSourceRGB(...beak);
        cr.moveTo(-7, 11);
        cr.lineTo(9, 13 - open / 2);
        cr.lineTo(-7, 15 - open / 2);
        cr.closePath();
        cr.fill();
        cr.setSourceRGB(...darken(beak, 0.15));
        cr.moveTo(-7, 14 + open / 2);
        cr.lineTo(8, 15 + open / 2);
        cr.lineTo(-7, 18 + open / 2);
        cr.closePath();
        cr.fill();
        if (mood === 'sleep') {
            cr.setSourceRGBA(...DARK, 0.4);
            cr.setLineWidth(1.5);
            cr.moveTo(-7, 14);
            cr.lineTo(8, 14);
            cr.stroke();
        }
    }

    // Três "z" que sobem e somem, um atrás do outro.
    _drawSnore(cr, time) {
        cr.setLineWidth(2.2);
        cr.setLineJoin(1);
        for (let i = 0; i < 3; i++) {
            const phase = (time * 0.45 + i / 3) % 1;
            const size = 4 + phase * 6;
            const x = 22 + phase * 12;
            const y = -24 - phase * 16;
            cr.setSourceRGBA(0.75, 0.85, 1, Math.sin(phase * Math.PI));
            cr.moveTo(x, y);
            cr.lineTo(x + size, y);
            cr.lineTo(x, y + size);
            cr.lineTo(x + size, y + size);
            cr.stroke();
        }
    }

    _drawSweat(cr, time) {
        for (const [i, x] of [[0, 30], [0.5, -32]]) {
            const phase = (time * 0.9 + i) % 1;
            const y = -18 + phase * 22;
            cr.setSourceRGBA(0.45, 0.78, 1, 1 - phase * 0.7);
            cr.moveTo(x, y - 7);
            cr.curveTo(x + 6, y + 1, x + 4, y + 6, x, y + 6);
            cr.curveTo(x - 4, y + 6, x - 6, y + 1, x, y - 7);
            cr.fill();
        }
    }

    // Corações e estrelinhas que sobem em volta dele.
    _drawParty(cr, hop) {
        const heart = (x, y, s, alpha) => {
            cr.setSourceRGBA(1, 0.3, 0.4, alpha);
            cr.moveTo(x, y + 12 * s);
            cr.curveTo(x - 22 * s, y - 4 * s, x - 8 * s, y - 18 * s, x, y - 6 * s);
            cr.curveTo(x + 8 * s, y - 18 * s, x + 22 * s, y - 4 * s, x, y + 12 * s);
            cr.fill();
        };
        const star = (x, y, r, alpha) => {
            cr.setSourceRGBA(1, 0.85, 0.3, alpha);
            for (let i = 0; i < 8; i++) {
                const a = i * Math.PI / 4;
                const d = i % 2 ? r * 0.4 : r;
                cr.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
            }
            cr.closePath();
            cr.fill();
        };
        for (const [i, x] of [[0, 34], [0.33, -36], [0.66, 10]]) {
            const phase = (hop + i) % 1;
            heart(x, -26 - phase * 26, 0.4 + phase * 0.25, 1 - phase);
        }
        for (const [i, x, y] of [[0.15, -40, 20], [0.5, 42, 0], [0.8, -20, -30]]) {
            const phase = (hop * 1.3 + i) % 1;
            star(x, y - phase * 12, 3 + phase * 3, 1 - phase);
        }
    }
});

// Um bichinho que mora no dock: acompanha o cursor com os olhos, pisca,
// dorme quando você se afasta, sua quando o processador aperta, faz festa
// quando leva um clique e, entre uma coisa e outra, se espreguiça, olha em
// volta e abana a cauda. Com "Passear pelo dock" ligado, ele sai do tile e
// anda de um lado para o outro em cima do dock.
export const MascotWidget = registerClass(
class MascotWidget extends Widget {
    setup() {
        this._mood = 'awake';
        this._cpu = 0;
        this._lastCpu = null;
        this._happyUntil = 0;
        this._blinkAt = this._now() + 2000;
        this._lastTick = this._now();
        this._idle = global.backend.get_core_idle_monitor();
        this._antic = null;
        this._anticAt = this._now() + 4000;

        // Passeio: posição (0..1 ao longo do dock), sentido e até quando
        // dura o trecho atual (andando ou parado).
        this._walker = null;
        this._place = Math.random();
        this._direction = Math.random() < 0.5 ? -1 : 1;
        this._moving = true;
        this._legUntil = this._now() + 4000;

        this._settings.connectObject(
            'changed::mascot-kind', () => this.refresh(),
            'changed::mascot-walk', () => this.refresh(), this);

        this._timers.add(GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, TICK, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        }));
        this.every(3, () => this._readCpu());
        this._readCpu();
    }

    _now() {
        return GLib.get_monotonic_time() / 1000;
    }

    get _kind() {
        return this._settings.get_string('mascot-kind');
    }

    get _walks() {
        return this._settings.get_boolean('mascot-walk');
    }

    async _readCpu() {
        try {
            const stat = await readFile('/proc/stat', this.cancellable);
            const fields = stat.split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
            const idle = fields[3] + (fields[4] ?? 0);
            const total = fields.reduce((sum, n) => sum + n, 0);
            if (this._lastCpu && total > this._lastCpu.total)
                this._cpu = 1 - (idle - this._lastCpu.idle) / (total - this._lastCpu.total);
            this._lastCpu = {idle, total};
        } catch {
            // Leitura cancelada ou falha pontual: a próxima rodada corrige.
        }
    }

    build(size) {
        const wide = size !== 'square';
        const side = this._dock.tileSize - 2;

        this._art = new MascotArt({
            style: `width: ${side}px; height: ${side}px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._caption = null;
        this._value = null;

        const box = new St.BoxLayout({
            style_class: `gprdock-tile gprdock-tile-${wide ? 'wide' : 'square'}`,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        box.add_child(this._art);

        if (wide) {
            const text = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'gprdock-tile-text',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._caption = new St.Label({style_class: 'gprdock-tile-caption'});
            this._value = new St.Label({style_class: 'gprdock-tile-value'});
            text.add_child(this._caption);
            text.add_child(this._value);
            box.add_child(text);
        }
        return box;
    }

    refresh() {
        // Passeando, ele não ocupa lugar no dock: o tile some e os cliques
        // (festa e menu) passam a ser no próprio bicho.
        const walks = this._walks;
        this.visible = !walks;
        if (!this._value)
            return;

        const name = MASCOTS.find(([id]) => id === this._kind)?.[1] ?? 'Mascote';
        const hour = new Date().getHours();
        const greeting = hour < 5 ? 'Ainda acordado?' : hour < 12 ? 'Bom dia!'
            : hour < 18 ? 'Boa tarde!' : 'Boa noite!';
        const [caption, value] = {
            awake: [name, greeting],
            sleep: [name, 'Zzz…'],
            hot: ['Ufa!', `Processador em ${Math.round(this._cpu * 100)}%`],
            happy: [name, 'Oba!'],
        }[this._mood];
        this._caption.text = caption;
        this._value.text = value;
    }

    // Opções a mais no menu do clique direito.
    buildMenu(menu) {
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Bicho'));
        for (const [id, label] of MASCOTS) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.setOrnament(id === this._kind
                ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            item.connect('activate', () => this._settings.set_string('mascot-kind', id));
            menu.addMenuItem(item);
        }
        const walk = new PopupMenu.PopupSwitchMenuItem('Passear pelo dock', this._walks);
        walk.connect('toggled', (_item, state) => {
            // O menu pode estar apontando para o bicho, que vai sumir.
            menu.close();
            this._settings.set_boolean('mascot-walk', state);
        });
        menu.addMenuItem(walk);
    }

    // Gracinhas de vez em quando, só parado e acordado.
    _updateAntic(now, mood, walking) {
        if (this._antic) {
            const phase = (now - this._antic.since) / ANTICS[this._antic.kind];
            if (phase >= 1 || mood !== 'awake') {
                this._antic = null;
                this._anticAt = now + ANTIC_EVERY[0] +
                    Math.random() * (ANTIC_EVERY[1] - ANTIC_EVERY[0]);
            } else {
                this._antic.phase = phase;
            }
            return;
        }
        if (mood !== 'awake' || walking || now < this._anticAt)
            return;
        const kinds = Object.keys(ANTICS);
        this._antic = {kind: kinds[Math.floor(Math.random() * kinds.length)], since: now, phase: 0};
    }

    _tick() {
        const now = this._now();
        const elapsed = Math.min(200, now - this._lastTick);
        this._lastTick = now;

        // Em outro perfil o widget fica guardado, fora da tela.
        if (!this.get_parent()?.mapped || !this._art) {
            this._dropWalker();
            return;
        }

        let mood = 'awake';
        if (now < this._happyUntil)
            mood = 'happy';
        else if (this._idle.get_idletime() > SLEEP_AFTER)
            mood = 'sleep';
        else if (this._cpu > CPU_HOT)
            mood = 'hot';
        if (mood !== this._mood) {
            this._mood = mood;
            this.refresh();
        }

        let art = this._art;
        let step = null;
        // Com um dock por monitor, só o do principal solta o bicho; nos
        // outros o tile some e pronto.
        if (this._walks && !this._dock.isPrimary) {
            this._dropWalker();
            return;
        }
        if (this._walks) {
            art = this._ensureWalker();
            if (this._walk(art, now, elapsed, mood))
                step = (now % STEP_TIME) / STEP_TIME;
        } else {
            this._dropWalker();
        }
        this._updateAntic(now, mood, step !== null);

        // Para onde olhar: a direção do cursor, mais forte quanto mais longe.
        const [px, py] = global.get_pointer();
        const [ax, ay] = art.get_transformed_position();
        const [aw, ah] = art.get_transformed_size();
        const dx = px - (ax + aw / 2);
        const dy = py - (ay + ah / 2);
        const distance = Math.hypot(dx, dy) || 1;
        const reach = Math.min(1, distance / LOOK_DISTANCE);

        let blink = 0;
        if (now >= this._blinkAt) {
            const phase = (now - this._blinkAt) / BLINK_TIME;
            if (phase >= 1)
                this._blinkAt = now + 1800 + Math.random() * 4200;
            else
                blink = 1 - Math.abs(phase * 2 - 1);
        }

        art.model = {
            kind: this._kind,
            mood,
            time: now / 1000,
            look: [dx / distance * reach, dy / distance * reach],
            blink,
            hop: mood === 'happy' ? 1 - (this._happyUntil - now) / HAPPY_TIME : 0,
            step,
            direction: this._direction,
            antic: this._antic ? {kind: this._antic.kind, phase: this._antic.phase} : null,
        };
        art.queue_repaint();
    }

    // ---------- Passeio ----------

    _ensureWalker() {
        if (!this._walker) {
            const walker = this._walker = new MascotArt({reactive: true});
            walker.connect('button-press-event', (_actor, event) => {
                if (event.get_button() === Clutter.BUTTON_SECONDARY)
                    this._dock.openMenu(this, walker);
                else
                    this.onClick();
                return Clutter.EVENT_STOP;
            });
            // Ele anda por cima das janelas, fora da faixa do dock: precisa
            // ser registrado à parte para receber cliques.
            Main.layoutManager.addChrome(walker, {trackFullscreen: true});
        }
        return this._walker;
    }

    _dropWalker() {
        if (!this._walker)
            return;
        Main.layoutManager.removeChrome(this._walker);
        this._walker.destroy();
        this._walker = null;
    }

    // Põe o bicho em cima do dock e o faz andar; devolve se está andando.
    _walk(walker, now, elapsed, mood) {
        const dock = this._dock.actor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const size = this._dock.tileSize * dock.scale_x * scale;
        const [dockWidth] = dock.get_transformed_size();
        const span = Math.max(1, dockWidth - size);

        // Só anda acordado e sossegado; no resto fica onde está.
        if (mood !== 'awake' || this._antic) {
            this._moving = false;
            this._legUntil = now + 1500;
        } else if (now >= this._legUntil) {
            // Fim do trecho: alterna entre andar e ficar parado olhando.
            this._moving = !this._moving;
            this._legUntil = now + (this._moving
                ? 4000 + Math.random() * 9000 : 1500 + Math.random() * 4000);
            if (this._moving && Math.random() < 0.4)
                this._direction = -this._direction;
        }

        if (this._moving) {
            this._place += this._direction * WALK_SPEED * scale * elapsed / 1000 / span;
            if (this._place <= 0 || this._place >= 1) {
                this._place = Math.min(1, Math.max(0, this._place));
                this._direction = -this._direction;
            }
        }

        // Com o dock escondido ele some junto (a visibilidade em si é do
        // shell, que o esconde em tela cheia).
        const strip = this._dock.container;
        walker.opacity = dock.visible ? 255 : 0;
        walker.reactive = dock.visible;
        walker.set_size(size, size);
        // Os pés ficam um pouco para dentro da borda de cima do dock.
        walker.set_position(
            Math.round(strip.x + dock.x + this._place * span),
            Math.round(strip.y + dock.y + dock.translation_y - size * 0.9));
        return this._moving;
    }

    onClick() {
        this._happyUntil = this._now() + HAPPY_TIME;
        this._antic = null;
    }

    onDestroy() {
        this._settings.disconnectObject(this);
        this._dropWalker();
    }
});
