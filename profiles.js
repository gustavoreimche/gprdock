import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {customInfo} from './custom.js';

export const THEMES = [
    ['vidro', 'Vidro'],
    ['papel', 'Papel'],
    ['neon', 'Neon'],
    ['floating', 'Floating'],
    ['nord', 'Nord'],
    ['dracula', 'Dracula'],
    ['poente', 'Poente'],
    ['grafite', 'Grafite'],
    ['menta', 'Menta'],
];
export const DEFAULT_THEME = THEMES[0][0];

// [nome, rótulo, forma padrão, descrição para a galeria]
export const WIDGET_INFO = [
    ['music', 'Música', 'wide', 'O que está tocando, com os controles. Qualquer player.'],
    ['calendar', 'Calendário', 'square', 'A data de hoje; o clique abre o calendário.'],
    ['clock', 'Relógio', 'square', 'A hora, com o dia no retângulo.'],
    ['worldclock', 'Relógio mundial', 'wide', 'A hora em outras cidades, com a diferença para a sua.'],
    ['weather', 'Clima', 'square', 'Temperatura e previsão de 3 dias da cidade escolhida.'],
    ['battery', 'Bateria', 'square', 'A carga e quanto tempo ela ainda dá.'],
    ['storage', 'Armazenamento', 'square', 'Quanto do disco já foi; no painel, cada disco.'],
    ['activity', 'Atividade', 'wide', 'Processador e memória em uso, ao vivo.'],
    ['network', 'Rede', 'wide', 'O que está descendo e subindo agora.'],
    ['pomodoro', 'Pomodoro', 'wide', 'Foco, pausa curta e pausa longa, com os ciclos do dia.'],
    ['timer', 'Timer', 'wide', 'Contagem regressiva com anel de progresso.'],
    ['stopwatch', 'Cronômetro', 'wide', 'Conta para cima; clique inicia e pausa.'],
    ['countdown', 'Contagem regressiva', 'wide', 'Quantos dias faltam para a data que importa.'],
    ['timeprogress', 'Progresso do tempo', 'square', 'Quanto do dia, da semana, do mês e do ano já foi.'],
    ['water', 'Beber água', 'square', 'Um copo por clique, até a meta do dia.'],
    ['note', 'Nota', 'wide', 'Um recado que fica no dock.'],
    ['verse', 'Versículo do dia', 'wide', 'O versículo do dia na NVI; o clique mostra inteiro.'],
    ['clipboard', 'Área de transferência', 'wide', 'O histórico do que você copiou; clique copia de novo.'],
    ['emoji', 'Emoji', 'square', 'Os que você mais usa, a um clique.'],
    ['colorpicker', 'Conta-gotas', 'square', 'Pega qualquer cor da tela e copia o código.'],
    ['screenshots', 'Capturas de tela', 'square', 'As últimas capturas, para abrir direto.'],
    ['files', 'Downloads', 'square', 'O que chegou por último na pasta Downloads.'],
    ['bookmarks', 'Favoritos', 'square', 'Os sites que você abre todo dia, um clique cada.'],
    ['shortcuts', 'Atalhos', 'square', 'Roda um comando ou script seu com um clique.'],
    ['collection', 'Coleção de apps', 'square', 'Um ícone que guarda um grupo de apps.'],
    ['reminders', 'Lembretes', 'wide', 'Uma lista curta do que não esquecer; clique conclui.'],
    ['converter', 'Conversor', 'square', 'Comprimento, peso, temperatura e dados.'],
    ['shelf', 'Prateleira', 'square', 'Guarda arquivos arrastados de qualquer app para usar depois.'],
    ['meeting', 'Próxima reunião', 'wide', 'O próximo compromisso da agenda e quanto falta para ele.'],
    ['focus', 'Não perturbe', 'square', 'Um clique silencia as notificações; pode iniciar o pomodoro junto.'],
    ['toggles', 'Atalhos do sistema', 'square', 'Estilo escuro, luz noturna, Wi-Fi, Bluetooth e manter acordado.'],
    ['voicememo', 'Gravador de voz', 'square', 'Um clique grava o microfone; outro para e guarda.'],
    ['audio', 'Saída de som', 'square', 'Troca entre caixa, fone e HDMI; mostra o volume.'],
    ['mic', 'Microfone', 'square', 'Um clique liga e desliga o microfone.'],
    ['vpn', 'VPN', 'square', 'Netskope (com o prazo do novo login), Tailscale (com as máquinas da rede) e outras.'],
    ['ports', 'Portas em uso', 'square', 'Seus servidores locais: abrir no navegador ou encerrar.'],
    ['docker', 'Docker', 'square', 'Contêineres rodando; iniciar, parar e reiniciar pelo painel.'],
    ['git', 'GitHub e GitLab', 'square', 'Revisões pendentes, seus PRs/MRs abertos e seus pipelines, de várias contas.'],
    ['claudecode', 'Claude Code', 'wide', 'Sessões do Claude Code no terminal: trabalhando ou esperando por você.'],
    ['claude', 'Uso do Claude', 'square', 'Quanto do plano já foi e quando zera.'],
    ['jarvis', 'Jarvis', 'wide', 'Estado do assistente; clique faz ouvir.'],
    ['mascot', 'Mascote', 'square', 'Gato, cachorro, coelho ou passarinho: segue o cursor, dorme, sua, faz festa e passeia pelo dock.'],
    ['engine', 'Wallpaper vivo', 'wide', 'O wallpaper do GprEngine: pausar, trocar e abrir a galeria.'],
];
// O separador não está na galeria: entra pelo menu do dock.
export const WIDGET_LABELS = [...WIDGET_INFO.map(([name, label]) => [name, label]),
    ['separator', 'Separador'], ['custom', 'Widget personalizado']];
export const SIZES = [
    ['square', 'Quadrado'],
    ['wide', 'Retângulo'],
    ['large', 'Grande'],
];
// Só estes têm o que mostrar a mais na forma grande (3 espaços).
const LARGE_WIDGETS = new Set(['music', 'weather', 'verse', 'git']);

// Um widget pode aparecer mais de uma vez, cada vez com um parâmetro:
// 'git@<id da conta>' é o widget 'git' limitado àquela conta.
export const widgetBase = name => name.split('@')[0];
export const widgetParam = name =>
    name.includes('@') ? name.slice(name.indexOf('@') + 1) : null;

// Formas que o widget aceita, como pares [valor, rótulo].
export function widgetSizes(name) {
    if (widgetBase(name) === 'separator')
        return [];
    return SIZES.filter(([size]) => size !== 'large' || LARGE_WIDGETS.has(widgetBase(name)));
}

// Forma do widget neste perfil: a escolhida, senão a padrão dele.
export function widgetSize(profile, name) {
    const chosen = profile.sizes?.[name];
    if (widgetSizes(name).some(([size]) => size === chosen))
        return chosen;
    // Um widget personalizado diz a forma padrão dele no manifest.
    if (widgetBase(name) === 'custom')
        return customInfo(widgetParam(name))?.size ?? 'square';
    return WIDGET_INFO.find(([id]) => id === widgetBase(name))?.[2] ?? 'square';
}

// Cada perfil tem uma lista ordenada de itens, que é a ordem no dock:
//   'app:<id do .desktop>'   app fixado
//   'widget:<nome>'          widget
//   'running'                onde entram os apps abertos que não estão fixados
export const RUNNING = 'running';
export const appItem = id => `app:${id}`;
export const widgetItem = name => `widget:${name}`;
export const itemApp = item => item.startsWith('app:') ? item.slice(4) : null;
export const itemWidget = item => item.startsWith('widget:') ? item.slice(7) : null;
export const profileApps = profile => profile.items.map(itemApp).filter(Boolean);
export const profileWidgets = profile => profile.items.map(itemWidget).filter(Boolean);

function itemsFrom(apps, widgets) {
    return [...apps.map(appItem), RUNNING, ...widgets.map(widgetItem)];
}

// Lê a lista de perfis gravada em GSettings; devolve null se não servir.
// Perfis do formato antigo (listas separadas de apps e widgets) são convertidos.
export function parseProfiles(json) {
    let list = null;
    try {
        list = JSON.parse(json);
    } catch {
        return null;
    }
    if (!Array.isArray(list) || list.length === 0)
        return null;

    const themes = new Set(THEMES.map(([id]) => id));
    for (const p of list) {
        if (!p || typeof p.name !== 'string')
            return null;

        if (!Array.isArray(p.items)) {
            if (!Array.isArray(p.favorites) || !Array.isArray(p.widgets))
                return null;
            p.items = itemsFrom(p.favorites, p.widgets);
        }
        delete p.favorites;
        delete p.widgets;

        // Os pipelines foram para dentro do widget de Git.
        p.items = [...new Set(p.items.filter(item =>
            typeof item === 'string' && item !== 'widget:pipelines'))];
        p.id ||= GLib.uuid_string_random();
        if (!p.sizes || typeof p.sizes !== 'object' || Array.isArray(p.sizes))
            p.sizes = {};
        if (!themes.has(p.theme))
            p.theme = DEFAULT_THEME;
    }
    return list;
}

// Lista de perfis gravada ou, na primeira execução, um perfil "Principal"
// montado com o tema, os widgets e os apps fixados que já estavam em uso.
// Devolve [lista, foiCriada].
export function loadProfiles(settings, shellSettings) {
    const saved = parseProfiles(settings.get_string('profiles'));
    if (saved)
        return [saved, false];

    return [[{
        id: GLib.uuid_string_random(),
        name: 'Principal',
        theme: settings.get_string('theme'),
        sizes: {},
        items: itemsFrom(
            shellSettings.get_strv('favorite-apps'), settings.get_strv('widgets')),
    }], true];
}

// Aplica à lista de itens a lista de apps fixados que o GNOME passou a ter
// (alguém usou "Fixar"/"Desafixar" no menu de um ícone), mexendo o mínimo:
// os apps ocupam, na nova ordem, as mesmas posições que já ocupavam.
export function reconcileApps(items, apps) {
    const queue = [...apps];
    const result = [];
    let lastApp = -1;

    for (const item of items) {
        if (itemApp(item) === null) {
            result.push(item);
        } else if (queue.length > 0) {
            result.push(appItem(queue.shift()));
            lastApp = result.length - 1;
        }
    }

    // Apps a mais entram logo depois do último fixado.
    result.splice(lastApp + 1, 0, ...queue.map(appItem));
    return result;
}

// Perfis do dock. Os apps fixados do perfil atual são espelhados nos favoritos
// do GNOME, então "Fixar" e "Desafixar" do menu dos ícones editam só o perfil
// em uso.
export class Profiles {
    constructor(settings) {
        this._settings = settings;
        this._shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
        this._listeners = new Set();

        this._load();
        this._favoritesId = this._shellSettings.connect('changed::favorite-apps',
            () => this._onFavoritesChanged());
        // A tela de configurações roda em outro processo e edita esta chave.
        this._profilesId = this._settings.connect('changed::profiles',
            () => this._onExternalChange());
        this._applyFavorites();
    }

    get list() {
        return this._profiles;
    }

    get count() {
        return this._profiles.length;
    }

    get index() {
        return this._index;
    }

    get current() {
        return this._profiles[this._index];
    }

    // fn(event, data); eventos: 'switched', 'changed', 'added', 'removed'.
    connect(fn) {
        this._listeners.add(fn);
        return fn;
    }

    disconnect(fn) {
        this._listeners.delete(fn);
    }

    _emit(event, data = {}) {
        this._listeners.forEach(fn => fn(event, data));
    }

    _load() {
        const [profiles, seeded] = loadProfiles(this._settings, this._shellSettings);
        this._profiles = profiles;
        this._index = Math.clamp(
            this._settings.get_int('current-profile'), 0, this._profiles.length - 1);

        // Grava também quando o formato lido era o antigo.
        if (seeded || JSON.stringify(profiles) !== this._settings.get_string('profiles'))
            this._save();
        else
            this._written = this._settings.get_string('profiles');
    }

    _save() {
        this._written = JSON.stringify(this._profiles);
        this._settings.set_string('profiles', this._written);
        this._settings.set_int('current-profile', this._index);
    }

    _onExternalChange() {
        const json = this._settings.get_string('profiles');
        if (json === this._written)
            return;
        const updated = parseProfiles(json);
        if (!updated)
            return;

        const previous = this._profiles;
        const currentId = this.current.id;
        const ids = new Set(updated.map(p => p.id));
        const removed = previous.map((p, i) => ids.has(p.id) ? -1 : i)
            .filter(i => i >= 0).reverse();

        this._profiles = updated;
        this._written = json;
        const kept = updated.findIndex(p => p.id === currentId);
        this._index = kept >= 0 ? kept : Math.min(this._index, updated.length - 1);
        this._settings.set_int('current-profile', this._index);
        this._applyFavorites();

        removed.forEach(index => this._emit('removed', {index}));
        if (updated.length > previous.length)
            this._emit('added');
        this._emit('changed');
    }

    _applyFavorites() {
        const wanted = profileApps(this.current);
        const actual = this._shellSettings.get_strv('favorite-apps');
        if (wanted.join('\n') !== actual.join('\n'))
            this._shellSettings.set_strv('favorite-apps', wanted);
    }

    _onFavoritesChanged() {
        const actual = this._shellSettings.get_strv('favorite-apps');
        if (actual.join('\n') === profileApps(this.current).join('\n'))
            return;
        this.current.items = reconcileApps(this.current.items, actual);
        this._save();
        this._emit('changed');
    }

    _changed() {
        this._save();
        this._applyFavorites();
        this._emit('changed');
    }

    // direction: +1 (para o próximo) ou -1; usado só para animar.
    switchTo(index, direction = 0) {
        if (index < 0 || index >= this.count || index === this._index)
            return false;

        direction ||= Math.sign(index - this._index);
        this._index = index;
        this._save();
        this._applyFavorites();
        this._emit('switched', {direction});
        return true;
    }

    step(direction) {
        return this.switchTo(this._index + direction, direction);
    }

    setTheme(theme) {
        this.current.theme = theme;
        this._changed();
    }

    // Põe o item na posição `index` da lista (como ela está agora); se ele já
    // existe, é movido. Serve para fixar, reordenar e mostrar um widget.
    placeItem(item, index) {
        const items = this.current.items;
        const from = items.indexOf(item);
        index = Math.clamp(index, 0, items.length);
        if (from >= 0) {
            items.splice(from, 1);
            if (from < index)
                index--;
        }
        items.splice(index, 0, item);
        this._changed();
    }

    setWidgetSize(name, size) {
        this.current.sizes[name] = size;
        this._changed();
    }

    removeItem(item) {
        const items = this.current.items;
        const index = items.indexOf(item);
        if (index < 0)
            return;
        items.splice(index, 1);
        this._changed();
    }

    // Tira o item de todos os perfis: ele deixou de existir.
    removeItemEverywhere(item) {
        for (const profile of this._profiles)
            profile.items = profile.items.filter(entry => entry !== item);
        this._changed();
    }

    rename(name) {
        name = name.trim();
        if (!name || name === this.current.name)
            return;
        this.current.name = name;
        this._changed();
    }

    // O perfil novo nasce como cópia do atual, para ser ajustado a partir dele.
    add() {
        const names = new Set(this._profiles.map(p => p.name));
        let n = this.count + 1;
        while (names.has(`Perfil ${n}`))
            n++;

        this._profiles.push({
            id: GLib.uuid_string_random(),
            name: `Perfil ${n}`,
            theme: this.current.theme,
            sizes: {...this.current.sizes},
            items: [...this.current.items],
        });
        this._save();
        this._emit('added');
        this.switchTo(this.count - 1, 1);
    }

    removeCurrent() {
        if (this.count <= 1)
            return;

        const removed = this._index;
        this._profiles.splice(removed, 1);
        this._index = Math.min(this._index, this.count - 1);
        this._save();
        this._applyFavorites();
        this._emit('removed', {index: removed});
    }

    destroy() {
        this._shellSettings.disconnect(this._favoritesId);
        this._settings.disconnect(this._profilesId);
        this._listeners.clear();
    }
}
