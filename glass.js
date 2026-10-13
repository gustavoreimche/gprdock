import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {registerClass} from './registerClass.js';

const CAPTURE_SCALE = 0.25;     // a tela é copiada pequena: o desfoque esconde a diferença
const BLUR_RADIUS = 110;        // px lógicos
const BRIGHTNESS = 0.9;

const ROUNDED_DECLARATIONS = `
uniform vec2 size;
uniform float radius;
`;
// Quanto de cada ponto fica dentro do retângulo de cantos arredondados, com
// um pixel de transição na borda.
const ROUNDED_CODE = `
vec2 p = cogl_tex_coord_in[0].xy * size;
vec2 d = abs(p - size * 0.5) - (size * 0.5 - vec2(radius));
float distance = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
cogl_color_out *= clamp(0.5 - distance, 0.0, 1.0);
`;

// Recorta o ator em cantos arredondados. O shell só sabe recortar em
// retângulo, e o desfoque dele não tem cantos.
const RoundedClip = registerClass(
class RoundedClip extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._sizeLocation = this.get_uniform_location('size');
        this._radiusLocation = this.get_uniform_location('radius');
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            ROUNDED_DECLARATIONS, ROUNDED_CODE, false);
    }

    setShape(width, height, radius) {
        this.set_uniform_float(this._sizeLocation, 2, [width, height]);
        this.set_uniform_float(this._radiusLocation, 1, [radius]);
    }
});

const MAX_SHAPES = 32;
const SHAPES_DECLARATIONS = `
uniform vec2 size;
uniform float radius;
uniform int count;
uniform vec4 shapes[${MAX_SHAPES}];
`;
// O mesmo recorte, para vários retângulos de uma vez: fica o que cai dentro
// de algum deles.
const SHAPES_CODE = `
vec2 p = cogl_tex_coord_in[0].xy * size;
float cover = 0.0;
for (int i = 0; i < ${MAX_SHAPES}; i++) {
    if (i < count) {
        vec2 half_size = shapes[i].zw * 0.5;
        vec2 d = abs(p - (shapes[i].xy + half_size)) - (half_size - vec2(radius));
        float distance = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
        cover = max(cover, clamp(0.5 - distance, 0.0, 1.0));
    }
}
cogl_color_out *= cover;
`;

const ShapesClip = registerClass(
class ShapesClip extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._sizeLocation = this.get_uniform_location('size');
        this._radiusLocation = this.get_uniform_location('radius');
        this._countLocation = this.get_uniform_location('count');
        this._shapesLocation = this.get_uniform_location('shapes');
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            SHAPES_DECLARATIONS, SHAPES_CODE, false);
    }

    // shapes: [[x, y, largura, altura], ...], em px do ator.
    setShapes(width, height, radius, shapes) {
        const list = shapes.slice(0, MAX_SHAPES);
        const values = new Array(MAX_SHAPES * 4).fill(0);
        list.forEach((shape, i) => shape.forEach((n, j) => (values[i * 4 + j] = n)));
        this.set_uniform_float(this._sizeLocation, 2, [width, height]);
        this.set_uniform_float(this._radiusLocation, 1, [radius]);
        this.set_uniform_float(this._countLocation, 1, [list.length]);
        this.set_uniform_float(this._shapesLocation, 4, values);
    }
});

const STRIP_BLUR = 44;          // px lógicos
const STRIP_BRIGHTNESS = 0.9;

// Vidro dos widgets do dock: o papel de parede borrado, visível só dentro do
// contorno de cada widget.
//
// Atrás do dock só há o papel de parede (as janelas não entram na faixa
// dele), então em vez de desfocar "o que está atrás", coisa que o shell só
// faz em retângulo, a faixa mostra uma cópia viva do próprio papel de parede,
// borrada uma vez só e recortada no formato de todos os widgets juntos. Com
// papel de parede animado, o vidro acompanha.
export class GlassStrip {
    constructor(container, radius) {
        this._container = container;
        this._radius = radius;

        this.actor = new Clutter.Actor({visible: false});
        this._clip = new ShapesClip();
        this.actor.add_effect(this._clip);

        this._blurred = new Clutter.Actor({clip_to_allocation: true});
        this._blur = new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            brightness: STRIP_BRIGHTNESS,
        });
        this._blurred.add_effect(this._blur);
        this._wallpaper = new Clutter.Clone({source: Main.layoutManager._backgroundGroup});
        this._blurred.add_child(this._wallpaper);
        this.actor.add_child(this._blurred);

        container.insert_child_at_index(this.actor, 0);
    }

    // shapes: retângulos dos widgets, em coordenadas da tela. Lista vazia
    // esconde o vidro.
    update(shapes) {
        const {width, height} = this._container;
        if (shapes.length === 0 || !(width > 0 && height > 0)) {
            this.actor.hide();
            return;
        }
        const [x, y] = this._container.get_transformed_position();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.actor.set_size(width, height);
        this._blurred.set_size(width, height);
        this._wallpaper.set_position(-Math.round(x), -Math.round(y));
        this._blur.radius = STRIP_BLUR * scale;
        this._clip.setShapes(width, height, this._radius * scale,
            shapes.map(([sx, sy, w, h]) => [sx - x, sy - y, w, h]));
        this.actor.show();
    }

    destroy() {
        this.actor.destroy();
    }
}

// Fundo de vidro de um menu (ou de qualquer coisa com o mesmo jeito: um
// `actor` que aparece e some e uma `box` com o conteúdo): o que está atrás
// dele, borrado, visto através do painel translúcido.
//
// O desfoque "ao vivo" do shell é sempre um retângulo, que sobraria nos
// cantos do painel. Aqui a tela é copiada no instante em que o menu abre
// (ele ainda está invisível, começando a aparecer), e essa cópia, borrada e
// recortada com os cantos do painel, fica logo atrás dele. É uma foto: o que
// se mexer atrás do painel enquanto ele está aberto não aparece.
export class GlassBackdrop {
    constructor(menu, radius) {
        this._menu = menu;
        this._radius = radius;
        this._later = 0;
        this._enabled = false;

        this.actor = new Clutter.Actor({clip_to_allocation: true, visible: false});
        this._picture = new Clutter.Actor();
        this._blur = new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            brightness: BRIGHTNESS,
        });
        this._picture.add_effect(this._blur);
        this.actor.add_child(this._picture);
        this._clip = new RoundedClip();
        this.actor.add_effect(this._clip);

        menu.connectObject('open-state-changed', (_menu, open) => {
            if (open)
                this._show();
            else
                this._queueHideCheck();
        }, this);
        // O menu aparece e some com um deslize e um esmaecer; o fundo vai junto.
        menu.actor.connectObject(
            'notify::opacity', () => this._follow(),
            'notify::translation-x', () => this._queuePlace(),
            'notify::translation-y', () => this._queuePlace(),
            'notify::visible', () => this._follow(), this);
        menu.box.connectObject('notify::allocation', () => this._queuePlace(), this);
    }

    set enabled(enabled) {
        this._enabled = enabled;
        if (!enabled)
            this._hide();
        else if (this._menu.isOpen)
            this._show();
    }

    // Para quem não é menu e abre e fecha por conta própria.
    show() {
        this._show();
    }

    _show() {
        if (!this._enabled)
            return;
        const monitor = Main.layoutManager.findMonitorForActor(this._menu.sourceActor) ??
            Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        try {
            // Neste instante o menu ainda está com opacidade zero: não sai
            // na própria foto.
            this._picture.content = global.stage.paint_to_content(
                new Mtk.Rectangle({x: monitor.x, y: monitor.y,
                    width: monitor.width, height: monitor.height}),
                CAPTURE_SCALE, null, Clutter.PaintFlag.NO_CURSORS);
        } catch (e) {
            console.warn('gprdock: não foi possível copiar a tela para o vidro', e);
            return;
        }
        this._monitor = monitor;
        this._blur.radius = BLUR_RADIUS * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._picture.set_size(monitor.width, monitor.height);

        const parent = this._menu.actor.get_parent();
        if (this.actor.get_parent() !== parent) {
            this.actor.get_parent()?.remove_child(this.actor);
            parent.add_child(this.actor);
        }
        parent.set_child_below_sibling(this.actor, this._menu.actor);
        this.actor.show();
        this._follow();
        this._queuePlace();
    }

    _follow() {
        this.actor.opacity = this._menu.actor.opacity;
        if (!this._menu.actor.visible)
            this._hide();
    }

    // Ao fechar, o fundo some junto com a animação do menu (ver _follow);
    // sem animação, some já.
    _queueHideCheck() {
        if (!this._menu.actor.visible || this._menu.actor.opacity === 0)
            this._hide();
    }

    _hide() {
        if (this._later) {
            global.compositor.get_laters().remove(this._later);
            this._later = 0;
        }
        this.actor.hide();
        this._picture.content = null;
    }

    // As posições na tela só valem depois de o quadro ser montado.
    _queuePlace() {
        if (this._later || !this.actor.visible)
            return;
        this._later = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._later = 0;
            this._place();
            return GLib.SOURCE_REMOVE;
        });
    }

    _place() {
        const box = this._menu.box;
        if (!this.actor.visible || !box.get_stage())
            return;
        const [x, y] = box.get_transformed_position();
        const [width, height] = box.get_transformed_size();
        if (!(width > 0 && height > 0))
            return;
        this.actor.set_position(Math.round(x), Math.round(y));
        this.actor.set_size(Math.round(width), Math.round(height));
        this._picture.set_position(
            this._monitor.x - Math.round(x), this._monitor.y - Math.round(y));
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._clip.setShape(Math.round(width), Math.round(height), this._radius * scale);
    }

    destroy() {
        this._hide();
        this._menu.disconnectObject(this);
        this._menu.actor.disconnectObject(this);
        this._menu.box.disconnectObject(this);
        this.actor.destroy();
    }
}
