import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {createAppItem} from './appIcons.js';
import {
    copyOfWindowClass, createIsolatedCopy, learnWindowClass, removeIsolatedCopy,
} from './webApps.js';
import {AppSpread} from './appSpread.js';
import {Badges} from './badges.js';
import {GlassBackdrop, GlassStrip} from './glass.js';
import {WindowPreview} from './windowPreview.js';
import {
    THEMES, WIDGET_LABELS, RUNNING, appItem, widgetItem, itemApp, itemWidget,
    profileApps, profileWidgets, widgetBase, widgetSize, widgetSizes,
} from './profiles.js';
import {MusicWidget} from './widgets/music.js';
import {CalendarWidget} from './widgets/calendar.js';
import {WeatherWidget} from './widgets/weather.js';
import {BatteryWidget} from './widgets/battery.js';
import {ActivityWidget} from './widgets/activity.js';
import {PomodoroWidget} from './widgets/pomodoro.js';
import {ClaudeWidget} from './widgets/claude.js';
import {JarvisWidget} from './widgets/jarvis.js';
import {VerseWidget} from './widgets/verse.js';
import {GitWidget} from './widgets/git.js';
import {
    ClockWidget, TimeProgressWidget, CountdownWidget, StopwatchWidget, TimerWidget,
} from './widgets/time.js';
import {NetworkWidget, NoteWidget, SeparatorWidget, WaterWidget} from './widgets/misc.js';
import {
    ClipboardWidget, EmojiWidget, ColorPickerWidget, ScreenshotsWidget, FilesWidget,
} from './widgets/tools.js';
import {
    BookmarksWidget, ShortcutsWidget, CollectionWidget, RemindersWidget, ConverterWidget,
} from './widgets/more.js';
import {CustomWidget, customWidgetFor} from './widgets/custom.js';
import {DockerWidget} from './widgets/docker.js';
import {MascotWidget} from './widgets/mascot.js';
import {ShelfWidget} from './widgets/shelf.js';
import {EngineWidget} from './widgets/engine.js';
import {
    AudioWidget, FocusWidget, MicWidget, PortsWidget, VpnWidget,
} from './widgets/system.js';
import {MeetingWidget} from './widgets/meeting.js';
import {ClaudeCodeWidget} from './widgets/claudecode.js';
import {
    StorageWidget, TogglesWidget, VoiceMemoWidget, WorldClockWidget,
} from './widgets/extras.js';

const WIDGETS = {
    music: MusicWidget,
    calendar: CalendarWidget,
    weather: WeatherWidget,
    battery: BatteryWidget,
    activity: ActivityWidget,
    pomodoro: PomodoroWidget,
    claude: ClaudeWidget,
    jarvis: JarvisWidget,
    verse: VerseWidget,
    git: GitWidget,
    clock: ClockWidget,
    timeprogress: TimeProgressWidget,
    countdown: CountdownWidget,
    stopwatch: StopwatchWidget,
    timer: TimerWidget,
    network: NetworkWidget,
    note: NoteWidget,
    water: WaterWidget,
    engine: EngineWidget,
    clipboard: ClipboardWidget,
    emoji: EmojiWidget,
    colorpicker: ColorPickerWidget,
    screenshots: ScreenshotsWidget,
    files: FilesWidget,
    bookmarks: BookmarksWidget,
    shortcuts: ShortcutsWidget,
    collection: CollectionWidget,
    reminders: RemindersWidget,
    converter: ConverterWidget,
    docker: DockerWidget,
    shelf: ShelfWidget,
    separator: SeparatorWidget,
    custom: CustomWidget,
    mascot: MascotWidget,
    vpn: VpnWidget,
    audio: AudioWidget,
    mic: MicWidget,
    focus: FocusWidget,
    ports: PortsWidget,
    meeting: MeetingWidget,
    claudecode: ClaudeCodeWidget,
    toggles: TogglesWidget,
    storage: StorageWidget,
    worldclock: WorldClockWidget,
    voicememo: VoiceMemoWidget,
};

// Temas em que os painéis são de vidro: translúcidos, com desfoque atrás.
const GLASS_THEMES = new Set(['floating']);
const GLASS_RADIUS = 16;        // o mesmo de .gprdock-panel-content
const SETTLE_TIME = 700;        // ms que um app precisa ficar aberto para entrar no dock
const SWIPE_DISTANCE = 48;      // px lógicos de arrasto para trocar de perfil
const SCROLL_COOLDOWN = 350;    // ms entre trocas pela roda ou pelo touchpad
const SCROLL_IDLE = 400;        // ms sem rolar para descartar o acumulado
// A troca de perfil desliza como a de área de trabalho do GNOME: mesmo
// tempo, mesma curva e mesma distância (a tela mais o vão entre as áreas).
const SLIDE_TIME = 250;
const SLIDE_GAP = 100;
// Sem a área de trabalho junto, só um empurrão curto com esmaecer.
const NUDGE_DISTANCE = 28;
const NUDGE_TIME = 180;
const FLASH_TIME = 1100;
const DRAG_OUT_DISTANCE = 40;   // px lógicos acima do dock para "soltar fora"
const DRAG_SOURCE_OPACITY = 90;
// Folgas, em px lógicos: acima e abaixo do dock, e dos lados da tela.
const PAD_TOP = 3;
const PAD_BOTTOM = 4;
const SIDE_MARGIN = 12;
// Ocultar automaticamente
const EDGE_HEIGHT = 2;          // faixa na borda de baixo que chama o dock de volta
const HIDE_DELAY = 500;         // ms sem o cursor por perto antes de esconder
const REVEAL_TIME = 180;

export class Dock {
    // `monitorIndex`: em qual monitor este dock fica; o principal se não
    // for dito. Com "em todos os monitores" há um Dock por monitor, e só o
    // do principal cuida do que é único (o dash do GNOME, o mascote solto).
    constructor(settings, profiles, path, openPreferences, monitorIndex = null) {
        this.settings = settings;
        this._monitorIndex = monitorIndex;
        this.path = path;
        this.profiles = profiles;
        this._openPreferences = openPreferences;
        this._themedActors = new Set();
        // Quando cada app aberto foi visto pela primeira vez. Os que já
        // estavam abertos ao ligar entram direto.
        this._firstSeen = new Map(Shell.AppSystem.get_default().get_running()
            .map(app => [app.get_id(), -SETTLE_TIME]));
        this._settleId = 0;
        this._externalDrags = new Set();   // widgets esperando um arrasto de fora
        this._menus = new Set();    // menu do dock e painéis dos widgets
        this._widgets = new Map();
        this._appItems = new Map();
        this._layoutKey = null;
        this._appSpread = new AppSpread();

        // Faixa invisível de borda a borda: é ela que reserva o espaço na
        // tela, já que o dock flutuante não encosta em nenhuma borda. O dock
        // é posicionado dentro dela à mão (ver _reposition), para poder ter
        // o tamanho natural dele mesmo quando é mais largo que a tela.
        this._container = new St.Widget({
            style_class: 'gprdock-container',
            reactive: false,
            // Na troca de perfil o dock entra e sai pelos lados: o que passa
            // da tela não pode aparecer no monitor vizinho.
            clip_to_allocation: true,
        });

        this.actor = new St.BoxLayout({
            style_class: 'gprdock',
            reactive: true,
        });
        // O dock inteiro é o alvo de arrastar e soltar (ver handleDragOver).
        this.actor._delegate = this;
        this._container.add_child(this.actor);
        this._themedActors.add(this.actor);

        this.menuManager = new PopupMenu.PopupMenuManager(this.actor);

        this._dots = new St.BoxLayout({
            style_class: 'gprdock-dots',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._dots);

        this._showApps = this._createShowAppsButton();
        this.actor.add_child(this._showApps);

        // Apps e widgets na ordem do perfil, misturados.
        this._itemBox = new St.BoxLayout({style_class: 'gprdock-items'});
        this.actor.add_child(this._itemBox);
        this._placeholder = new St.Widget({
            style_class: 'gprdock-drop-placeholder',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._flash = new St.Label({style_class: 'dash-label gprdock-flash'});
        this._flash.hide();
        Main.uiGroup.add_child(this._flash);
        this._flashId = 0;

        this._menu = new PopupMenu.PopupMenu(this.actor, 0.5, St.Side.BOTTOM);
        this.registerMenu(this._menu);

        this._background = [this.actor, this._dots, this._itemBox];
        this._swipe = null;
        this._scrollSum = 0;
        this._scrollTime = 0;
        this._switchTime = 0;
        this.actor.connect('captured-event', (_actor, event) => this._onCaptured(event));
        this.actor.connect('scroll-event', (_actor, event) => this._onScroll(event));

        Main.layoutManager.addChrome(this._container, {
            affectsStruts: true,
            trackFullscreen: true,
        });

        // Faixa fina na borda de baixo: com o dock escondido, é encostar o
        // cursor nela que o traz de volta.
        this._edge = new St.Widget({reactive: true, track_hover: true, visible: false});
        Main.layoutManager.addChrome(this._edge, {trackFullscreen: true});
        this._edge.connect('notify::hover', () => this._onHoverChanged());
        this.actor.track_hover = true;
        this.actor.connect('notify::hover', () => this._onHoverChanged());
        this._autohide = false;
        this._revealed = true;
        this._hideId = 0;

        // O conteúdo mudou de tamanho: reposiciona antes do próximo quadro
        // (mexer na posição dentro da própria alocação não é permitido).
        this._repositionLater = 0;
        this.actor.connect('notify::allocation', () => this._queueReposition());
        // Deslizando (troca de perfil, ocultar): o vidro vai junto.
        for (const property of ['translation-x', 'translation-y', 'visible'])
            this.actor.connect(`notify::${property}`, () => this._syncGlassStrip());
        Main.layoutManager.connectObject('monitors-changed',
            () => this._reposition(), this);

        // Na visão geral o gprdock continua na tela e substitui o dash
        // embutido do GNOME, que ocuparia o mesmo lugar.
        this._dash = this.isPrimary ? Main.overview.dash : null;
        if (this._dash) {
            this._dash.hide();
            this._dash.set_height(0);
            // Escondido, o dash continua recalculando o tamanho dos ícones a
            // cada app que abre, e falha porque eles nunca chegam a ser
            // desenhados. O método volta ao normal em destroy().
            this._dash._adjustIconSize = () => {};
        }

        // Todo ícone de app (os do dock e os da grade) avisa a visão geral
        // quando começa e termina um arrasto.
        Main.overview.connectObject(
            'item-drag-begin', () => this._onDragBegin(),
            'item-drag-end', () => this._onDragEnd(),
            'item-drag-cancelled', () => this._onDragEnd(), this);
        this._dragMonitor = {dragMotion: event => this._onDragMotion(event)};

        this._appSystem = Shell.AppSystem.get_default();
        this._appSystem.connectObject(
            'app-state-changed', () => this._syncItems(),
            'installed-changed', () => this._syncItems(true), this);
        AppFavorites.getAppFavorites().connectObject(
            'changed', () => this._syncItems(), this);
        // Apps abertos fora dos fixados aparecem só na área de trabalho deles.
        Shell.WindowTracker.get_default().connectObject(
            'tracked-windows-changed', () => {
                this._adoptWebAppWindows();
                this._syncItems();
                // Janela nova: precisa saber para onde minimizar.
                this._queueReposition();
            }, this);
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._syncItems(), this);

        this.settings.connectObject(
            'changed::icon-size', () => {
                this._clearItems();
                this._syncProfile();
            },
            'changed::app-icons', () => this._appItems.forEach(item => item.appIcon.icon.update()),
            'changed::autohide', () => this._syncAutohide(),
            'changed::window-previews', () => this._syncExtras(),
            'changed::notification-badges', () => this._syncExtras(), this);
        this._preview = null;
        this._badges = null;
        this._syncExtras();
        Main.overview.connectObject(
            'showing', () => this._onHoverChanged(),
            'hidden', () => this._onHoverChanged(), this);
        this._profilesListener = this.profiles.connect(
            (event, data) => this._onProfileEvent(event, data));

        this._syncProfile();
        this._reposition();
        this._syncAutohide();
    }

    get isPrimary() {
        return this._monitorIndex === null ||
            this._monitorIndex === Main.layoutManager.primaryIndex;
    }

    // O monitor deste dock; se ele sumiu, o principal.
    get monitor() {
        const monitors = Main.layoutManager.monitors;
        return (this._monitorIndex !== null && monitors[this._monitorIndex]) ||
            Main.layoutManager.primaryMonitor;
    }

    // A faixa de borda a borda onde o dock fica; o que for posto nela pode
    // desenhar acima dele.
    get container() {
        return this._container;
    }

    get tileSize() {
        return this.settings.get_int('icon-size') + 8;
    }

    get _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    // Menus e painéis recebem a classe do tema e fecham uns aos outros.
    registerMenu(menu) {
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        menu.actor.add_style_class_name('gprdock-panel');
        // As classes padrão de popup saem: extensões como o Blur my Shell
        // procuram por elas para pôr uma superfície de desfoque atrás, com
        // cantos que não batem com os do painel. O visual vem todo do tema
        // do dock (.gprdock-panel-content).
        menu.actor.remove_style_class_name('popup-menu');
        menu.box.remove_style_class_name('popup-menu-content');
        menu.box.add_style_class_name('gprdock-panel-content');
        this.menuManager.addMenu(menu);
        this._menus.add(menu);
        // Com um menu aberto o cursor pode sair sem aviso; ao fechar, confere
        // se é hora de esconder o dock.
        menu.connect('open-state-changed', () => this._onHoverChanged());
        this._themedActors.add(menu.actor);
        this._applyThemeTo(menu.actor);
        menu.actor.connect('destroy', () => {
            this._themedActors.delete(menu.actor);
            this._menus.delete(menu);
        });
        this._syncGlass(menu);
    }

    get glass() {
        return GLASS_THEMES.has(this.profiles.current.theme);
    }

    // Um fundo de vidro para algo do dock que não é menu (a prévia das
    // janelas): ver GlassBackdrop.
    createGlass(target) {
        return new GlassBackdrop(target, GLASS_RADIUS);
    }

    // O menu do clique direito num ícone de app é do GNOME; aqui ele ganha o
    // visual dos painéis do dock (tema e vidro), sem mudar o que faz.
    adoptMenu(menu) {
        menu.actor.add_style_class_name('gprdock-panel');
        menu.actor.remove_style_class_name('popup-menu');
        menu.box.remove_style_class_name('popup-menu-content');
        menu.box.add_style_class_name('gprdock-panel-content');
        this._menus.add(menu);
        this._themedActors.add(menu.actor);
        this._applyThemeTo(menu.actor);
        menu.actor.connect('destroy', () => {
            this._themedActors.delete(menu.actor);
            this._menus.delete(menu);
        });
        this._syncGlass(menu);
    }

    // Nos temas de vidro o painel é translúcido e ganha, atrás, o que está
    // na tela borrado (ver glass.js).
    _syncGlass(menu) {
        const glass = GLASS_THEMES.has(this.profiles.current.theme);
        if (glass)
            menu.box.add_style_class_name('gprdock-panel-glass');
        else
            menu.box.remove_style_class_name('gprdock-panel-glass');
        if (glass && !menu._glass) {
            menu._glass = new GlassBackdrop(menu, GLASS_RADIUS);
            menu.actor.connect('destroy', () => {
                menu._glass?.destroy();
                menu._glass = null;
            });
        }
        if (menu._glass)
            menu._glass.enabled = glass;
    }

    // Qualquer ator de fora do dock que deva seguir o tema do perfil.
    themeActor(actor) {
        this._themedActors.add(actor);
        this._applyThemeTo(actor);
        actor.connect('destroy', () => this._themedActors.delete(actor));
    }

    // Prévia das janelas e contador de notificações: ligam e desligam pelas
    // configurações.
    _syncExtras() {
        const previews = this.settings.get_boolean('window-previews');
        if (previews && !this._preview) {
            this._preview = new WindowPreview(this);
        } else if (!previews && this._preview) {
            this._preview.destroy();
            this._preview = null;
        }

        const badges = this.settings.get_boolean('notification-badges');
        if (badges && !this._badges) {
            this._badges = new Badges(() => this._syncBadges());
        } else if (!badges && this._badges) {
            this._badges.destroy();
            this._badges = null;
        }
        this._syncBadges();
    }

    _syncBadges() {
        for (const item of this._appItems?.values() ?? [])
            item.setBadge(this._badges?.count(item.appIcon.app) ?? 0);
    }

    // Um widget mudou de lugar por conta própria (subiu com o cursor).
    onWidgetMoved() {
        this._syncGlassStrip();
    }

    // A prévia abriu ou fechou: com ela aberta o dock não se esconde.
    onPreviewChanged() {
        this._onHoverChanged();
    }

    _onBackground(event) {
        return this._background.includes(global.stage.get_event_actor(event));
    }

    _createShowAppsButton() {
        const button = new St.Button({
            style_class: 'gprdock-show-apps',
            child: new St.Icon({icon_name: 'view-app-grid-symbolic'}),
            accessible_name: 'Mostrar aplicativos',
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
        });
        button.connect('clicked', () => {
            if (Main.overview.visible && Main.overview.dash.showAppsButton.checked)
                Main.overview.hide();
            else
                Main.overview.showApps();
        });
        // Clique direito abre o menu do dock: perfis e configurações.
        button.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this.openDockMenu();
            return Clutter.EVENT_STOP;
        });
        return button;
    }

    // ---------- Perfil em uso ----------

    _onProfileEvent(event, data) {
        // O dock ainda mostra o perfil anterior: é a hora de fotografá-lo.
        const ghost = event === 'switched' ? this._createGhost() : null;
        this._syncProfile();
        if (event === 'switched') {
            this._slide(data.direction, ghost);
            this._showFlash(this.profiles.current.name);
        }
    }

    // Um segundo atalho do mesmo app web, com login e janela próprios,
    // fixado neste perfil logo depois do original.
    _duplicateWebApp(app) {
        const profile = this.profiles.current;
        let id = null;
        try {
            id = createIsolatedCopy(app, profile.name);
        } catch (e) {
            Main.notify('gprdock', `Não foi possível duplicar ${app.get_name()}: ${e.message}.`);
            return;
        }
        const at = profile.items.indexOf(appItem(app.get_id()));
        this.profiles.placeItem(appItem(id), at >= 0 ? at + 1 : profile.items.length);
        Main.notify('gprdock', `${app.get_name()} duplicado: a cópia abre sem login, ` +
            'com uma sessão só dela.');
    }

    // Janela de uma cópia isolada que o GNOME não ligou ao atalho dela: o
    // atalho passa a trazer a classe que a janela tem de verdade.
    _adoptWebAppWindows() {
        const tracker = Shell.WindowTracker.get_default();
        for (const actor of global.get_window_actors()) {
            const window = actor.meta_window;
            const id = copyOfWindowClass(window.get_wm_class());
            if (id && tracker.get_window_app(window)?.get_id() !== id)
                learnWindowClass(id, window.get_wm_class());
        }
    }

    _removeWebAppCopy(app) {
        const id = app.get_id();
        // Fecha as janelas dela, mesmo as que o GNOME não ligou ao atalho.
        global.get_window_actors().map(actor => actor.meta_window)
            .filter(window => copyOfWindowClass(window.get_wm_class()) === id ||
                app.get_windows().includes(window))
            .forEach(window => window.delete(global.get_current_time()));
        this.profiles.removeItemEverywhere(appItem(id));
        removeIsolatedCopy(id);
    }

    _syncProfile() {
        this._syncItems();
        // Alguns widgets mostram coisas diferentes conforme o perfil.
        this._itemBox.get_children().forEach(child => child.onProfileChanged?.());
        this._syncDots();
        this._applyTheme();
    }

    // Apps abertos há tempo bastante para aparecer no dock. Copiar e colar
    // pelo terminal (wl-copy, wl-paste) abre uma janela que some em seguida;
    // sem esta espera, cada uma faria o dock crescer e encolher.
    _settledApps() {
        const now = GLib.get_monotonic_time() / 1000;
        const running = this._appSystem.get_running();
        const ids = new Set(running.map(app => app.get_id()));
        for (const id of this._firstSeen.keys()) {
            if (!ids.has(id))
                this._firstSeen.delete(id);
        }

        let wait = 0;
        const settled = running.filter(app => {
            const id = app.get_id();
            if (!this._firstSeen.has(id))
                this._firstSeen.set(id, now);
            const left = SETTLE_TIME - (now - this._firstSeen.get(id));
            wait = Math.max(wait, left);
            return left <= 0;
        });
        if (wait > 0 && !this._settleId) {
            this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(wait) + 20, () => {
                this._settleId = 0;
                this._syncItems();
                return GLib.SOURCE_REMOVE;
            });
        }
        return settled;
    }

    // Monta o dock na ordem da lista do perfil. Widgets e ícones ficam vivos
    // entre perfis (trocar não refaz consultas nem perde estado); só os
    // ícones de apps que saíram do dock são descartados.
    _syncItems(force = false) {
        const profile = this.profiles.current;
        const pinned = new Set(profileApps(profile));
        const workspace = global.workspace_manager.get_active_workspace();
        // Um app que tem um widget personalizado no perfil (ver "wmClasses"
        // no manifest dele) já está representado: o ícone de app aberto seria
        // a mesma coisa duas vezes.
        const widgets = new Set(profileWidgets(profile));
        const running = this._settledApps()
            .filter(app => !pinned.has(app.get_id()) && app.is_on_workspace(workspace) &&
                !widgets.has(customWidgetFor(app)));

        // Cada entrada vira um ator; `index` é onde, na lista do perfil, cai
        // um item solto logo antes dele.
        const entries = [];
        profile.items.forEach((item, index) => {
            const appId = itemApp(item);
            const widget = itemWidget(item);
            if (appId) {
                // Fixado, mas aberto e com widget: fica só o widget.
                const app = this._appSystem.lookup_app(appId);
                if (app && !widgets.has(customWidgetFor(app)))
                    entries.push({key: item, index, app});
            } else if (widget) {
                if (WIDGETS[widgetBase(widget)]) {
                    const size = widgetSize(profile, widget);
                    entries.push({key: `${item}@${size}`, index, widget, size});
                }
            }
        });

        // Os abertos que não estão fixados vão sempre para o fim, depois de
        // um separador; soltar algo ali cai no fim da lista do perfil.
        if (profile.items.includes(RUNNING) && running.length > 0) {
            const index = profile.items.length;
            entries.push({key: 'separator', index, separator: true});
            running.forEach(app => entries.push({key: `open:${app.get_id()}`, index, app}));
        }

        const layoutKey = entries.map(e => e.key).join('\n');
        if (!force && layoutKey === this._layoutKey)
            return;
        this._layoutKey = layoutKey;

        this._hidePlaceholder();
        this._itemBox.remove_all_children();
        const usedApps = new Set();

        for (const entry of entries) {
            let actor = null;
            if (entry.separator) {
                actor = this._separator ??= new St.Widget({
                    style_class: 'gprdock-separator',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                actor.style = `height: ${Math.round(this.tileSize * 0.6)}px;`;
            } else if (entry.app) {
                const id = entry.app.get_id();
                usedApps.add(id);
                actor = this._appItems.get(id) ?? this._createAppItem(entry.app);
            } else {
                actor = this._widgets.get(entry.widget) ?? this._createWidget(entry.widget);
            }
            if (!actor)
                continue;
            if (entry.widget)
                actor.setSize(entry.size);
            actor._entry = entry;
            this._itemBox.add_child(actor);
        }

        for (const [id, actor] of this._appItems) {
            if (!usedApps.has(id)) {
                this._appItems.delete(id);
                actor.destroy();
            }
        }

        const size = this.tileSize;
        this._showApps.style = `width: ${size}px; height: ${size}px;`;
    }

    _createAppItem(app) {
        const item = createAppItem(app, this.settings, this._appSpread, {
            adoptMenu: menu => this.adoptMenu(menu),
            duplicate: target => this._duplicateWebApp(target),
            remove: target => this._removeWebAppCopy(target),
            chooseIcon: target => {
                this.settings.set_string('prefs-page', `icon:${target.get_id()}`);
                this._openPreferences();
            },
        });
        this._appItems.set(app.get_id(), item);
        item.appIcon.connect('menu-state-changed', () => {
            this._preview?.hide();
            this._onHoverChanged();
        });
        item.appIcon.connect('notify::hover', () => {
            if (item.appIcon.hover && !this._dragging)
                this._preview?.enter(item);
            else
                this._preview?.leave(item);
        });
        item.appIcon.connect('clicked', () => this._preview?.hide());
        item.setBadge(this._badges?.count(app) ?? 0);
        this._watchDragOut(item.appIcon._draggable, item,
            () => appItem(app.get_id()));
        return item;
    }

    _createWidget(name) {
        let widget = null;
        try {
            widget = new WIDGETS[widgetBase(name)](this, name);
        } catch (e) {
            console.error(`gprdock: widget "${name}" falhou ao iniciar`, e);
            return null;
        }
        this._widgets.set(name, widget);

        // O que se arrasta é uma cópia; o widget fica no lugar, esmaecido.
        widget._delegate = {
            gprdockWidget: name,
            getDragActor: () => new Clutter.Clone({
                source: widget,
                width: widget.width,
                height: widget.height,
            }),
            getDragActorSource: () => widget,
        };
        const draggable = DND.makeDraggable(widget, {dragActorOpacity: 220});
        draggable.connect('drag-begin', () => this._onDragBegin());
        draggable.connect('drag-end', () => this._onDragEnd());
        this._watchDragOut(draggable, widget, () => widgetItem(name));
        return widget;
    }

    _clearItems() {
        this._itemBox.remove_all_children();
        this._widgets.forEach(w => w.destroy());
        this._widgets.clear();
        this._appItems.forEach(a => a.destroy());
        this._appItems.clear();
        this._layoutKey = null;
    }

    _syncDots() {
        this._dots.destroy_all_children();
        this._dots.visible = this.profiles.count > 1;

        this.profiles.list.forEach((profile, index) => {
            const dot = new St.Button({
                style_class: 'gprdock-dot',
                accessible_name: profile.name,
                x_align: Clutter.ActorAlign.CENTER,
            });
            if (index === this.profiles.index) {
                dot.add_style_class_name('gprdock-dot-active');
                // O ponto do perfil novo dá uma pulsada ao assumir.
                dot.set_pivot_point(0.5, 0.5);
                dot.set_scale(0.6, 0.6);
                dot.ease({
                    scale_x: 1,
                    scale_y: 1,
                    duration: 260,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK,
                });
            }
            dot.connect('clicked', () => this.profiles.switchTo(index));
            this._dots.add_child(dot);
        });
    }

    _applyThemeTo(actor) {
        const current = this.profiles.current.theme;
        for (const [id] of THEMES) {
            if (id === current)
                actor.add_style_class_name(`gprdock-theme-${id}`);
            else
                actor.remove_style_class_name(`gprdock-theme-${id}`);
        }
    }

    // O vidro atrás dos widgets (ver GlassStrip): onde cada um está agora.
    // Chamado sempre que o dock muda de tamanho, de lugar ou de conteúdo, e
    // a cada quadro enquanto ele desliza.
    _syncGlassStrip() {
        const glass = GLASS_THEMES.has(this.profiles.current.theme);
        if (!glass) {
            this._glassStrip?.destroy();
            this._glassStrip = null;
            return;
        }
        this._glassStrip ??= new GlassStrip(this._container, GLASS_RADIUS);
        const shapes = !this.actor.visible ? [] : this._itemBox.get_children()
            .filter(child => child.has_style_class_name?.('gprdock-widget') &&
                !child.has_style_class_name('gprdock-w-separator') && child.mapped)
            .map(child => [...child.get_transformed_position(), ...child.get_transformed_size()]);
        this._glassStrip.update(shapes);
    }

    _applyTheme() {
        this._themedActors.forEach(actor => this._applyThemeTo(actor));
        this._queueReposition();
        this._menus.forEach(menu => this._syncGlass(menu));
        // Só os que estão na tela: redesenhar um widget fora dela gera erro.
        this._itemBox.get_children().forEach(child => child.queue_redraw_all?.());
    }

    // Uma foto da faixa do dock como está agora: é ela que sai de cena
    // enquanto o dock de verdade, já com o perfil novo, entra. A foto leva
    // junto o fundo que está atrás do dock, e por isso só serve quando a
    // área de trabalho desliza também (o fundo dela vai embora igual).
    _createGhost() {
        if (!this.settings.get_boolean('bind-workspaces') || !this._container.mapped ||
            !this._revealed || Main.overview.visible)
            return null;
        const [x, y] = this._container.get_transformed_position();
        const {width, height} = this._container;
        let content = null;
        try {
            content = global.stage.paint_to_content(
                new Mtk.Rectangle({x: Math.round(x), y: Math.round(y), width, height}),
                this._container.get_resource_scale(), null, Clutter.PaintFlag.NO_CURSORS);
        } catch (e) {
            console.warn('gprdock: sem a foto do dock para a troca de perfil', e);
            return null;
        }
        const ghost = new Clutter.Actor({content, width, height});
        this._container.add_child(ghost);
        return ghost;
    }

    // direction: +1 quando o perfil novo vem da direita (como a área de
    // trabalho seguinte), -1 quando vem da esquerda.
    _slide(direction, ghost) {
        this._ghost?.destroy();
        this._ghost = ghost;
        this.actor.remove_transition('translation-x');
        this.actor.remove_transition('opacity');
        this.actor.opacity = 255;

        if (!ghost) {
            this.actor.translation_x = direction * NUDGE_DISTANCE * this._scale;
            this.actor.opacity = 90;
            this.actor.ease({
                translation_x: 0,
                opacity: 255,
                duration: NUDGE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return;
        }

        const monitor = this.monitor;
        const distance = (monitor?.width ?? this._container.width) + SLIDE_GAP * this._scale;
        const transition = {
            duration: SLIDE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        };
        ghost.ease({
            translation_x: -direction * distance,
            ...transition,
            onStopped: () => {
                ghost.destroy();
                if (this._ghost === ghost)
                    this._ghost = null;
            },
        });
        this.actor.translation_x = direction * distance;
        this.actor.ease({translation_x: 0, ...transition});
    }

    _showFlash(text) {
        const monitor = this.monitor;
        if (!monitor || !this._container.visible)
            return;

        this._flash.text = text;
        this._flash.show();
        this._flash.set_position(
            Math.round(monitor.x + (monitor.width - this._flash.width) / 2),
            Math.round(this._container.y - this._flash.height));
        this._flash.remove_all_transitions();
        this._flash.opacity = 255;

        if (this._settleId)
            GLib.source_remove(this._settleId);
        if (this._flashId)
            GLib.source_remove(this._flashId);
        this._flashId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FLASH_TIME, () => {
            this._flashId = 0;
            this._flash.ease({
                opacity: 0,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._flash.hide(),
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- Arrastar e soltar: reordenar, fixar, desafixar ----------

    // Item que a origem do arrasto representa, ou null se não é coisa do dock.
    _draggedItem(source) {
        if (source?.app instanceof Shell.App)
            return appItem(source.app.get_id());
        if (source?.gprdockWidget)
            return widgetItem(source.gprdockWidget);
        return null;
    }

    // Onde o item cairia: posição entre os atores do dock e na lista do perfil.
    _dropPosition(x) {
        // x vem em coordenadas do dock; se ele está encolhido, a tela não.
        const stageX = this.actor.get_transformed_position()[0] + x * this.actor.scale_x;
        const children = this._itemBox.get_children().filter(c => c !== this._placeholder);

        let child = children.findIndex(c => {
            const [cx] = c.get_transformed_position();
            return stageX < cx + c.get_transformed_size()[0] / 2;
        });
        if (child < 0)
            child = children.length;

        let index = this.profiles.current.items.length;
        if (child < children.length)
            index = children[child]._entry.index;
        else if (children.length > 0)
            index = children.at(-1)._entry.index + 1;
        return {child, index};
    }

    _showPlaceholder(childIndex) {
        this._placeholder.style = `height: ${this.tileSize - 12}px;`;
        if (this._placeholder.get_parent())
            this._itemBox.remove_child(this._placeholder);
        this._itemBox.insert_child_at_index(this._placeholder, childIndex);
    }

    _hidePlaceholder() {
        if (this._placeholder.get_parent())
            this._itemBox.remove_child(this._placeholder);
    }

    handleDragOver(source, _actor, x) {
        if (!this._draggedItem(source))
            return DND.DragMotionResult.CONTINUE;
        this._showPlaceholder(this._dropPosition(x).child);
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, _actor, x) {
        const item = this._draggedItem(source);
        if (!item)
            return false;
        const {index} = this._dropPosition(x);
        this._hidePlaceholder();
        this.profiles.placeItem(item, index);
        return true;
    }

    _onDragBegin() {
        if (this._dragging)
            return;
        this._dragging = true;
        this._preview?.hide();
        DND.addDragMonitor(this._dragMonitor);
    }

    _onDragMotion(event) {
        // Saiu de cima do dock: some a marca de onde o item cairia.
        if (!this.actor.contains(event.targetActor))
            this._hidePlaceholder();
        return DND.DragMotionResult.CONTINUE;
    }

    _onDragEnd() {
        if (!this._dragging)
            return;
        this._dragging = false;
        DND.removeDragMonitor(this._dragMonitor);
        this._hidePlaceholder();
        this._onHoverChanged();
    }

    // Soltar um item do dock longe dele (sem que nada o aceite) tira o item
    // do perfil: desafixa o app ou esconde o widget.
    _watchDragOut(draggable, actor, getItem) {
        let droppedOut = false;
        draggable.connect('drag-begin', () => {
            droppedOut = false;
            actor.opacity = DRAG_SOURCE_OPACITY;
        });
        draggable.connect('drag-cancelled', () => {
            const [, y] = global.get_pointer();
            droppedOut = y < this._container.y - DRAG_OUT_DISTANCE * this._scale;
        });
        draggable.connect('drag-end', () => {
            actor.opacity = 255;
            if (droppedOut)
                this.profiles.removeItem(getItem());
        });
    }

    // ---------- Trocar de perfil arrastando o fundo ou rolando ----------

    _step(direction, time) {
        if (this.profiles.step(direction))
            this._switchTime = time;
    }

    // Arrastar o fundo do dock para a esquerda avança de perfil. Em cima de
    // um ícone ou widget o arrasto é para reordenar, então não conta.
    _onCaptured(event) {
        const type = event.type();

        if (type === Clutter.EventType.BUTTON_PRESS) {
            this._swipe = event.get_button() === Clutter.BUTTON_PRIMARY &&
                this._onBackground(event)
                ? {x: event.get_coords()[0], done: false} : null;
        } else if (type === Clutter.EventType.MOTION) {
            if (!this._swipe || this._swipe.done)
                return Clutter.EVENT_PROPAGATE;
            if (!(event.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
                this._swipe = null;
                return Clutter.EVENT_PROPAGATE;
            }

            const dx = event.get_coords()[0] - this._swipe.x;
            if (Math.abs(dx) >= SWIPE_DISTANCE * this._scale) {
                this._swipe.done = true;
                this._step(dx < 0 ? 1 : -1, event.get_time());
            }
        } else if (type === Clutter.EventType.BUTTON_RELEASE) {
            const swiped = this._swipe?.done;
            this._swipe = null;
            // Soltar depois de um arrasto não pode virar clique no que
            // estiver embaixo do ponteiro.
            if (swiped)
                return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onScroll(event) {
        const time = event.get_time();
        let direction = 0;

        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            direction = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            direction = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            // A roda comum chega duas vezes (discreta e suave emulada).
            if (event.is_pointer_emulated())
                return Clutter.EVENT_STOP;
            if (time - this._scrollTime > SCROLL_IDLE)
                this._scrollSum = 0;
            this._scrollTime = time;

            const [dx, dy] = event.get_scroll_delta();
            this._scrollSum += Math.abs(dx) > Math.abs(dy) ? dx : dy;
            if (Math.abs(this._scrollSum) >= 1) {
                direction = Math.sign(this._scrollSum);
                this._scrollSum = 0;
            }
            break;
        }
        }

        if (direction && time - this._switchTime >= SCROLL_COOLDOWN)
            this._step(direction, time);
        return Clutter.EVENT_STOP;
    }

    // ---------- Menu do clique direito ----------

    _openMenuAt(actor) {
        // O menu aponta para quem o abriu.
        this._menu.sourceActor = actor;
        this._menu.focusActor = actor;
        this._menu.open();
    }

    // Clique direito num widget: só as opções dele.
    // `anchor` é onde o menu aponta, quando não é o próprio widget.
    openMenu(widget, anchor = widget) {
        this._menu.removeAll();

        const name = widget.widgetName;
        const label = widget.title ??
            new Map(WIDGET_LABELS).get(widgetBase(name)) ?? name;
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(label));
        for (const [size, sizeLabel] of widgetSizes(name)) {
            const item = new PopupMenu.PopupMenuItem(sizeLabel);
            item.setOrnament(size === widget.size
                ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            item.connect('activate', () => this.profiles.setWidgetSize(name, size));
            this._menu.addMenuItem(item);
        }
        widget.buildMenu?.(this._menu);
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addAction('Esconder neste perfil',
            () => this.profiles.removeItem(widgetItem(name)));

        this._openMenuAt(anchor);
    }

    // Clique direito no ícone de apps: o menu do dock em si (perfis e
    // configurações). O tema de cada perfil fica na tela de configurações.
    openDockMenu() {
        this._menu.removeAll();

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Perfis'));
        this.profiles.list.forEach((profile, index) => {
            const item = new PopupMenu.PopupMenuItem(profile.name);
            item.setOrnament(index === this.profiles.index
                ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            item.connect('activate', () => this.profiles.switchTo(index));
            this._menu.addMenuItem(item);
        });
        this._menu.addAction('Novo perfil', () => this.profiles.add());

        // Desligado, trocar de perfil muda só o dock.
        const bind = new PopupMenu.PopupSwitchMenuItem('Trocar a área de trabalho junto',
            this.settings.get_boolean('bind-workspaces'));
        bind.connect('toggled', (_item, state) =>
            this.settings.set_boolean('bind-workspaces', state));
        this._menu.addMenuItem(bind);

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        // Cada separador é um item próprio; entra no fim e vai para o lugar
        // arrastando.
        this._menu.addAction('Adicionar separador', () => this.profiles.placeItem(
            widgetItem(`separator@${GLib.uuid_string_random().slice(0, 8)}`),
            this.profiles.current.items.length));
        this._menu.addAction('Adicionar widgets…', () => {
            // A tela de configurações abre direto na galeria.
            this.settings.set_string('prefs-page', 'widgets');
            this._openPreferences();
        });
        this._menu.addAction('Configurações…', () => this._openPreferences());

        this._openMenuAt(this._showApps);
    }

    // ---------- Posição ----------

    // ---------- Ocultar automaticamente ----------

    _syncAutohide() {
        const on = this.settings.get_boolean('autohide');
        if (on === this._autohide)
            return;
        this._autohide = on;

        // Escondido, o dock não reserva espaço: as janelas usam a tela toda.
        Main.layoutManager.removeChrome(this._container);
        Main.layoutManager.addChrome(this._container, {
            affectsStruts: !on,
            trackFullscreen: true,
        });
        this._edge.visible = on;
        this._reposition();

        if (on)
            this._onHoverChanged();
        else
            this._reveal(true);
    }

    // O dock fica à mostra enquanto o cursor está nele (ou na borda), há um
    // menu dele aberto, um arrasto em curso ou a visão geral na tela.
    _wanted() {
        return this.actor.hover || this._edge.hover || this._dragging ||
            this._externalDrags.size > 0 || Boolean(this._preview?.visible) ||
            Main.overview.visible || [...this._menus].some(menu => menu.isOpen) ||
            [...this._appItems.values()].some(item => item.appIcon._menu?.isOpen);
    }

    // Um widget avisa que há um arrasto vindo de um app que ele pode receber:
    // enquanto durar, o dock não se esconde.
    setExternalDrag(widget, active) {
        if (active)
            this._externalDrags.add(widget);
        else if (!this._externalDrags.delete(widget))
            return;
        this._onHoverChanged();
    }

    _onHoverChanged() {
        if (!this._autohide)
            return;

        if (this._wanted()) {
            if (this._hideId) {
                GLib.source_remove(this._hideId);
                this._hideId = 0;
            }
            this._reveal(true);
        } else if (!this._hideId) {
            // Confere de novo no fim da espera: um menu pode ter aberto, ou o
            // cursor voltado, nesse meio-tempo.
            this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY, () => {
                if (this._wanted())
                    return GLib.SOURCE_CONTINUE;
                this._hideId = 0;
                this._reveal(false);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _reveal(show) {
        if (show === this._revealed)
            return;
        this._revealed = show;
        this._updateIconGeometry();

        this.actor.remove_transition('translation-y');
        if (show) {
            this.actor.show();
            this.actor.ease({
                translation_y: 0,
                duration: REVEAL_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this.actor.ease({
                translation_y: this._container.height,
                duration: REVEAL_TIME,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                // Fora da tela e também invisível, para não receber cliques.
                onComplete: () => this.actor.hide(),
            });
        }
    }

    // Diz ao GNOME onde fica o ícone de cada janela. É para lá que ela encolhe
    // ao minimizar e de lá que ela cresce ao voltar; sem isso a animação vai
    // para o canto da tela (ou para onde ficava um dock anterior).
    _updateIconGeometry() {
        const monitor = this.monitor;
        if (!monitor)
            return;
        const index = Main.layoutManager.monitors.indexOf(monitor);
        const tracker = Shell.WindowTracker.get_default();
        const bottom = monitor.y + monitor.height;

        const rectOf = actor => {
            const [x, y] = actor.get_transformed_position();
            const [width, height] = actor.get_transformed_size();
            // Com o dock escondido, o destino é a borda de baixo, na mesma
            // direção do ícone.
            return new Mtk.Rectangle({
                x: Math.round(x),
                y: Math.round(this._revealed ? y : bottom - 1),
                width: Math.max(1, Math.round(width)),
                height: this._revealed ? Math.max(1, Math.round(height)) : 1,
            });
        };

        for (const windowActor of global.get_window_actors()) {
            const window = windowActor.meta_window;
            // Cada janela encolhe para o dock do monitor em que ela está.
            if (window.get_monitor() !== index)
                continue;
            const app = tracker.get_window_app(window);
            const item = app ? this._appItems.get(app.get_id()) : null;
            // App sem ícone no dock: vai para o botão de apps.
            window.set_icon_geometry(rectOf(item?.get_stage() ? item : this._showApps));
        }
    }

    _queueReposition() {
        if (this._repositionLater)
            return;
        const laters = global.compositor.get_laters();
        this._repositionLater = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._repositionLater = 0;
            this._reposition();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Centraliza o dock embaixo da tela. Se ele ficou mais largo que ela,
    // encolhe por igual até caber, em vez de cortar o que sobra.
    _reposition() {
        const monitor = this.monitor;
        if (!monitor)
            return;

        const scale = this._scale;
        const [, width] = this.actor.get_preferred_width(-1);
        const [, height] = this.actor.get_preferred_height(-1);
        const available = monitor.width - 2 * SIDE_MARGIN * scale;
        const fit = Math.min(1, available / Math.max(1, width));

        // A faixa mantém a altura cheia, para a área útil das janelas não
        // mudar quando o dock encolhe; ele fica apoiado embaixo.
        const stripHeight = Math.round(height + (PAD_TOP + PAD_BOTTOM) * scale);
        this._container.set_size(monitor.width, stripHeight);
        this._container.set_position(monitor.x, monitor.y + monitor.height - stripHeight);

        const edge = EDGE_HEIGHT * scale;
        this._edge.set_size(monitor.width, edge);
        this._edge.set_position(monitor.x, monitor.y + monitor.height - edge);

        this.actor.set_pivot_point(0, 0);
        this.actor.set_scale(fit, fit);
        this._pendingIconGeometry = true;
        this.actor.set_position(
            Math.round((monitor.width - width * fit) / 2),
            Math.round(PAD_TOP * scale + height * (1 - fit)));

        // As posições na tela só valem depois deste quadro ser montado.
        global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            if (this._container && this._pendingIconGeometry) {
                this._pendingIconGeometry = false;
                this._updateIconGeometry();
            }
            if (this._container)
                this._syncGlassStrip();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._onDragEnd();
        if (this._hideId)
            GLib.source_remove(this._hideId);
        Main.layoutManager.removeChrome(this._edge);
        this._edge.destroy();
        if (this._repositionLater)
            global.compositor.get_laters().remove(this._repositionLater);
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._appSystem.disconnectObject(this);
        AppFavorites.getAppFavorites().disconnectObject(this);
        Shell.WindowTracker.get_default().disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        this.settings.disconnectObject(this);
        this.profiles.disconnect(this._profilesListener);

        if (this._dash) {
            delete this._dash._adjustIconSize;
            this._dash.set_height(-1);
            this._dash.show();
        }

        if (this._flashId)
            GLib.source_remove(this._flashId);
        this._flash.destroy();
        this._ghost?.destroy();
        this._ghost = null;
        this._glassStrip?.destroy();
        this._glassStrip = null;

        // As janelas deixam de apontar para um dock que não existe mais.
        global.get_window_actors().forEach(a => a.meta_window.set_icon_geometry(null));
        this._appSpread.destroy();
        this._preview?.destroy();
        this._preview = null;
        this._badges?.destroy();
        this._badges = null;
        this._clearItems();
        this._placeholder.destroy();
        this._separator?.destroy();
        // O menu se desliga dos sinais de quem ele acha que é a origem; tem
        // de ser a original, e não o último widget em que ele abriu.
        this._menu.sourceActor = this.actor;
        this._menu.destroy();

        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();
        this._container = null;
        this._themedActors.clear();
    }
}
