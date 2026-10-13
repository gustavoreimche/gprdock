import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup';

// Atenção: este arquivo roda fora do GNOME Shell (num processo GTK), onde não
// existem as extensões que o shell acrescenta ao JavaScript, como Math.clamp.
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    ARCHIVE_SUFFIX, createTemplate, customInfo, customName, exportWidget,
    inspectArchive, installArchive, listCustom, removeWidget,
} from './custom.js';
import {
    customGicon, importToLibrary, isIconFile, libraryDir, listLibrary, readAppIcons,
    removeFromLibrary, saveToLibrary, setAppIcon,
} from './iconLibrary.js';
import {
    THEMES, WIDGET_INFO, WIDGET_LABELS, RUNNING, appItem, widgetItem, itemApp,
    itemWidget, loadProfiles, parseProfiles, widgetBase, widgetParam, widgetSize, widgetSizes,
} from './profiles.js';

// O que vai junto com os perfis num arquivo exportado: as listas a que os
// itens deles se referem. Os tokens das contas ficam no chaveiro e não saem.
const EXPORTED_KEYS = ['collections', 'bookmarks', 'shortcuts', 'git-accounts',
    'auto-profile-rules'];

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
// Mesmo esquema que o widget de Git usa para ler os tokens do chaveiro (o
// nome é o de antes da extensão virar gprdock; ver widgets/git.js).
const TOKEN_SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.primodock.token', Secret.SchemaFlags.NONE,
    {account: Secret.SchemaAttributeType.STRING});

function readAccounts(settings) {
    try {
        const list = JSON.parse(settings.get_string('git-accounts'));
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

const accountName = account => account.name || account.host || account.type;

// Listas guardadas em GSettings como JSON (favoritos, atalhos, coleções).
function readList(settings, key) {
    try {
        const list = JSON.parse(settings.get_string(key));
        return Array.isArray(list) ? list.filter(item => item && typeof item === 'object') : [];
    } catch {
        return [];
    }
}

// Nome de um widget para mostrar; 'git@<conta>' vira "Git: <nome da conta>"
// e 'collection@<id>', "Coleção: <nome>".
function widgetTitle(name, settings) {
    const label = new Map(WIDGET_LABELS).get(widgetBase(name)) ?? name;
    const param = widgetParam(name);
    if (!param || widgetBase(name) === 'separator')
        return label;
    if (widgetBase(name) === 'custom')
        return customInfo(param)?.name ?? `Widget removido (${param})`;
    if (widgetBase(name) === 'claude')
        return `Uso do Claude: ${param.replace(/^\.claude-?/, '')}`;
    if (widgetBase(name) === 'collection') {
        const collection = readList(settings, 'collections').find(c => c.id === param);
        return `Coleção: ${collection ? collection.name || 'sem nome' : 'removida'}`;
    }
    const account = readAccounts(settings).find(a => a.id === param);
    return `Git: ${account ? accountName(account) : 'conta removida'}`;
}

// Tira de todos os perfis um widget que deixou de existir (conta ou coleção
// removida).
function forgetWidget(settings, name) {
    const shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
    const [profiles] = loadProfiles(settings, shellSettings);
    for (const profile of profiles) {
        profile.items = profile.items.filter(item => item !== widgetItem(name));
        delete profile.sizes[name];
    }
    settings.set_string('profiles', JSON.stringify(profiles));
}

function iconButton(iconName, tooltip, onClick) {
    const button = new Gtk.Button({
        icon_name: iconName,
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    button.connect('clicked', onClick);
    return button;
}

// ---------- Perfis ----------

class ProfilesPage {
    constructor(settings, window, openGallery) {
        this._openGallery = openGallery;
        this._settings = settings;
        this._shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
        this._window = window;
        this._groups = [];
        this._expanded = new Set();

        this.page = new Adw.PreferencesPage({
            title: 'Perfis',
            icon_name: 'view-paged-symbolic',
        });

        // O dock também edita os perfis (fixar um app, trocar o tema pelo
        // menu); o que não saiu daqui redesenha a página.
        const id = this._settings.connect('changed::profiles', () => {
            if (this._settings.get_string('profiles') !== this._written)
                this._rebuild();
        });
        window.connect('close-request', () => {
            this._settings.disconnect(id);
            return false;
        });

        this._rebuild();
    }

    _read() {
        const [profiles, seeded] = loadProfiles(this._settings, this._shellSettings);
        if (seeded)
            this._write(profiles);
        return profiles;
    }

    _write(profiles) {
        this._written = JSON.stringify(profiles);
        this._settings.set_string('profiles', this._written);
    }

    // Sempre relê antes de gravar, para não passar por cima de uma mudança
    // feita pelo dock enquanto esta janela estava aberta.
    _update(id, change, {rebuild = false} = {}) {
        const profiles = this._read();
        const profile = profiles.find(p => p.id === id);
        if (!profile)
            return;
        change(profile, profiles);
        this._write(profiles);
        if (rebuild)
            this._rebuild();
    }

    _rebuild() {
        this._groups.forEach(group => this.page.remove(group));
        this._groups = [];

        const profiles = this._read();
        profiles.forEach((profile, index) =>
            this._addGroup(this._buildProfile(profile, index, profiles.length)));

        const actions = new Adw.PreferencesGroup();
        const add = new Adw.ButtonRow({
            title: 'Novo perfil',
            start_icon_name: 'list-add-symbolic',
        });
        add.connect('activated', () => this._addProfile());
        actions.add(add);
        this._addGroup(actions);

        const backup = new Adw.PreferencesGroup({
            title: 'Cópia dos perfis',
            description: 'Um arquivo com os perfis, coleções, favoritos, atalhos e contas ' +
                '(sem os tokens), para guardar ou levar a outra máquina',
        });
        const exportRow = new Adw.ButtonRow({
            title: 'Exportar…',
            start_icon_name: 'document-save-symbolic',
        });
        exportRow.connect('activated', () => this._export());
        const importRow = new Adw.ButtonRow({
            title: 'Importar…',
            start_icon_name: 'document-open-symbolic',
        });
        importRow.connect('activated', () => this._import());
        backup.add(exportRow);
        backup.add(importRow);
        this._addGroup(backup);
    }

    _toast(text) {
        this._window.add_toast(new Adw.Toast({title: text}));
    }

    _export() {
        const dialog = new Gtk.FileDialog({
            title: 'Exportar perfis',
            initial_name: 'gprdock-perfis.json',
        });
        dialog.save(this._window, null, (_dialog, result) => {
            let file = null;
            try {
                file = dialog.save_finish(result);
            } catch {
                return;     // cancelado
            }
            const data = {gprdock: 1, profiles: this._read(), settings: {}};
            for (const key of EXPORTED_KEYS)
                data.settings[key] = this._settings.get_string(key);
            try {
                file.replace_contents(new TextEncoder().encode(JSON.stringify(data, null, 2)),
                    null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                this._toast(`Perfis exportados para ${file.get_basename()}`);
            } catch (e) {
                this._toast(`Não foi possível gravar o arquivo: ${e.message}`);
            }
        });
    }

    _import() {
        const filter = new Gtk.FileFilter({name: 'Perfis do gprdock (JSON)'});
        filter.add_pattern('*.json');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        const dialog = new Gtk.FileDialog({title: 'Importar perfis', filters});
        dialog.open(this._window, null, (_dialog, result) => {
            let data = null;
            try {
                const [, contents] = dialog.open_finish(result).load_contents(null);
                data = JSON.parse(new TextDecoder().decode(contents));
            } catch (e) {
                if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    this._toast('Este arquivo não pôde ser lido como perfis do gprdock');
                return;
            }
            const profiles = parseProfiles(JSON.stringify(data?.profiles ?? null));
            if (!profiles) {
                this._toast('Este arquivo não tem perfis do gprdock');
                return;
            }

            const current = this._read().length;
            const confirm = new Adw.AlertDialog({
                heading: 'Substituir os perfis?',
                body: `${current === 1 ? 'O perfil atual será trocado' : `Os ${current} perfis atuais serão trocados`}` +
                    ` ${profiles.length === 1 ? 'pelo perfil' : `pelos ${profiles.length} perfis`} do arquivo` +
                    ' (' + profiles.map(p => p.name).join(', ') + '). Coleções, favoritos, atalhos e ' +
                    'contas também passam a ser os do arquivo.',
            });
            confirm.add_response('cancel', 'Cancelar');
            confirm.add_response('replace', 'Substituir');
            confirm.set_response_appearance('replace', Adw.ResponseAppearance.DESTRUCTIVE);
            confirm.connect('response', (_confirm, response) => {
                if (response !== 'replace')
                    return;
                for (const key of EXPORTED_KEYS) {
                    if (typeof data.settings?.[key] === 'string')
                        this._settings.set_string(key, data.settings[key]);
                }
                this._write(profiles);
                this._rebuild();
                this._toast('Perfis importados');
            });
            confirm.present(this._window);
        });
    }

    _addGroup(group) {
        this.page.add(group);
        this._groups.push(group);
    }

    _buildProfile(profile, index, total) {
        const {id} = profile;
        const group = new Adw.PreferencesGroup({
            title: GLib.markup_escape_text(profile.name, -1),
            description: this._settings.get_boolean('bind-workspaces')
                ? `Área de trabalho ${index + 1}` : `Perfil ${index + 1}`,
        });

        if (total > 1) {
            group.set_header_suffix(iconButton('user-trash-symbolic',
                'Excluir este perfil', () => this._confirmDelete(profile)));
        }

        const name = new Adw.EntryRow({
            title: 'Nome',
            text: profile.name,
            show_apply_button: true,
        });
        name.connect('apply', () => {
            const text = name.text.trim();
            if (text)
                this._update(id, p => (p.name = text), {rebuild: true});
        });
        group.add(name);

        const theme = new Adw.ComboRow({
            title: 'Tema',
            model: Gtk.StringList.new(THEMES.map(([, label]) => label)),
            selected: Math.max(0, THEMES.findIndex(([tid]) => tid === profile.theme)),
        });
        theme.connect('notify::selected', () =>
            this._update(id, p => (p.theme = THEMES[theme.selected][0])));
        group.add(theme);

        group.add(this._buildItems(profile));
        this._buildWidgets(profile, group);
        this._buildGitAccounts(profile, group);
        return group;
    }

    _trackExpanded(row, key) {
        row.expanded = this._expanded.has(key);
        row.connect('notify::expanded', () => {
            if (row.expanded)
                this._expanded.add(key);
            else
                this._expanded.delete(key);
        });
    }

    // Os widgets são escolhidos na galeria; aqui fica só o atalho para ela
    // e a opção dos apps abertos, que não é um widget.
    _buildWidgets(profile, group) {
        const {id} = profile;
        const count = profile.items.filter(item => itemWidget(item) !== null).length;
        const gallery = new Adw.ActionRow({
            title: 'Widgets',
            subtitle: `${count} neste perfil`,
            activatable: true,
        });
        gallery.add_suffix(new Gtk.Label({label: 'Abrir a galeria'}));
        gallery.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        gallery.connect('activated', () => this._openGallery(id));
        group.add(gallery);

        const running = new Adw.SwitchRow({
            title: 'Apps abertos não fixados',
            subtitle: 'Ficam no fim do dock, depois de um separador',
            active: profile.items.includes(RUNNING),
        });
        running.connect('notify::active', () => {
            this._update(id, p => {
                p.items = p.items.filter(entry => entry !== RUNNING);
                if (running.active)
                    p.items.push(RUNNING);
            }, {rebuild: true});
        });
        group.add(running);
    }

    // Quais contas o widget de Git mostra neste perfil. Sem nenhuma marcada
    // vale o padrão: todas.
    _buildGitAccounts(profile, group) {
        let accounts = [];
        try {
            accounts = JSON.parse(this._settings.get_string('git-accounts'));
        } catch {
            // Sem contas cadastradas.
        }
        if (!Array.isArray(accounts) || accounts.length < 2)
            return;

        const {id} = profile;
        const chosen = Array.isArray(profile.gitAccounts) ? profile.gitAccounts : [];
        const subtitle = list => list.length === 0
            ? 'Todas as contas' : `${list.length} de ${accounts.length} contas`;
        const expander = new Adw.ExpanderRow({
            title: 'Contas no widget de Git',
            subtitle: subtitle(chosen),
        });
        this._trackExpanded(expander, `${id}:git`);

        for (const account of accounts) {
            const row = new Adw.SwitchRow({
                title: GLib.markup_escape_text(account.name || account.host || account.type, -1),
                subtitle: account.type === 'github' ? 'GitHub' : 'GitLab',
                active: chosen.includes(account.id),
            });
            row.connect('notify::active', () => {
                this._update(id, p => {
                    const list = new Set(Array.isArray(p.gitAccounts) ? p.gitAccounts : []);
                    if (row.active)
                        list.add(account.id);
                    else
                        list.delete(account.id);
                    p.gitAccounts = [...list];
                    expander.subtitle = subtitle(p.gitAccounts);
                });
            });
            expander.add_row(row);
        }
        group.add(expander);
    }

    // Tudo o que está no dock, na ordem em que aparece.
    _buildItems(profile) {
        const {id} = profile;
        const expander = new Adw.ExpanderRow({
            title: 'Itens do dock',
            subtitle: `${profile.items.length} itens, na ordem em que aparecem`,
        });
        this._trackExpanded(expander, `${id}:items`);

        const move = (from, to) => this._update(id, p => {
            const [item] = p.items.splice(from, 1);
            p.items.splice(to, 0, item);
        }, {rebuild: true});
        profile.items.forEach((item, index) => {
            const appId = itemApp(item);
            const widget = itemWidget(item);
            const row = new Adw.ActionRow();
            let icon = null;

            if (appId) {
                const info = GioUnix.DesktopAppInfo.new(appId);
                row.title = GLib.markup_escape_text(info?.get_name() ?? appId, -1);
                row.subtitle = info ? 'App fixado' : 'App não instalado';
                icon = new Gtk.Image({pixel_size: 32});
                if (info?.get_icon())
                    icon.gicon = info.get_icon();
                else
                    icon.icon_name = 'application-x-executable-symbolic';
            } else if (widget) {
                row.title = GLib.markup_escape_text(widgetTitle(widget, this._settings), -1);
                row.subtitle = 'Widget';
                icon = new Gtk.Image({icon_name: 'view-grid-symbolic', pixel_size: 24});
            } else {
                row.title = 'Apps abertos não fixados';
                row.subtitle = 'Entram aqui, nesta posição';
                icon = new Gtk.Image({icon_name: 'view-more-horizontal-symbolic', pixel_size: 24});
            }
            icon.width_request = 32;
            row.add_prefix(icon);

            const up = iconButton('go-up-symbolic', 'Mover para a esquerda',
                () => move(index, index - 1));
            up.sensitive = index > 0;
            const down = iconButton('go-down-symbolic', 'Mover para a direita',
                () => move(index, index + 1));
            down.sensitive = index < profile.items.length - 1;
            row.add_suffix(up);
            row.add_suffix(down);
            row.add_suffix(iconButton('list-remove-symbolic', 'Tirar do dock',
                () => this._update(id, p => p.items.splice(index, 1), {rebuild: true})));
            expander.add_row(row);
        });

        const add = new Adw.ButtonRow({
            title: 'Fixar um app…',
            start_icon_name: 'list-add-symbolic',
        });
        const pinned = profile.items.map(itemApp).filter(Boolean);
        add.connect('activated', () => this._chooseApp(pinned, appId =>
            this._update(id, p => {
                if (p.items.includes(appItem(appId)))
                    return;
                // Entra depois do último app fixado.
                const last = p.items.findLastIndex(i => itemApp(i) !== null);
                p.items.splice(last + 1, 0, appItem(appId));
            }, {rebuild: true})));
        expander.add_row(add);
        return expander;
    }

    _chooseApp(alreadyPinned, onChosen, title = 'Fixar um app') {
        const dialog = new Adw.Dialog({
            title,
            content_width: 420,
            content_height: 560,
        });

        const search = new Gtk.SearchEntry({
            placeholder_text: 'Buscar app',
            margin_start: 12,
            margin_end: 12,
            margin_bottom: 8,
        });
        const list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
            margin_start: 12,
            margin_end: 12,
            margin_bottom: 12,
            valign: Gtk.Align.START,
        });

        const apps = Gio.AppInfo.get_all()
            .filter(app => app.should_show() && !alreadyPinned.includes(app.get_id()))
            .sort((a, b) => a.get_name().localeCompare(b.get_name()));
        for (const app of apps) {
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(app.get_name(), -1),
                activatable: true,
            });
            row.add_prefix(new Gtk.Image({gicon: app.get_icon(), pixel_size: 32}));
            row._search = app.get_name().toLowerCase();
            row.connect('activated', () => {
                onChosen(app.get_id());
                dialog.close();
            });
            list.append(row);
        }

        list.set_filter_func(row => row._search.includes(search.text.toLowerCase()));
        search.connect('search-changed', () => list.invalidate_filter());

        const view = new Adw.ToolbarView();
        view.add_top_bar(new Adw.HeaderBar());
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(search);
        box.append(new Gtk.ScrolledWindow({
            child: list,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        }));
        view.set_content(box);
        dialog.set_child(view);
        dialog.present(this._window);
        search.grab_focus();
    }

    // O perfil novo nasce como cópia do que está em uso no dock.
    _addProfile() {
        const profiles = this._read();
        const current = profiles[Math.min(Math.max(this._settings.get_int('current-profile'), 0), profiles.length - 1)];
        const names = new Set(profiles.map(p => p.name));
        let n = profiles.length + 1;
        while (names.has(`Perfil ${n}`))
            n++;

        profiles.push({
            id: GLib.uuid_string_random(),
            name: `Perfil ${n}`,
            theme: current.theme,
            sizes: {...current.sizes},
            items: [...current.items],
        });
        this._write(profiles);
        this._rebuild();
    }

    _confirmDelete(profile) {
        const dialog = new Adw.AlertDialog({
            heading: `Excluir "${profile.name}"?`,
            body: this._settings.get_boolean('bind-workspaces')
                ? 'As janelas abertas nele passam para o perfil vizinho. Nenhuma é fechada.'
                : 'O tema e os itens deste perfil serão perdidos.',
        });
        dialog.add_response('cancel', 'Cancelar');
        dialog.add_response('delete', 'Excluir');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_dialog, response) => {
            if (response !== 'delete')
                return;
            const profiles = this._read().filter(p => p.id !== profile.id);
            if (profiles.length === 0)
                return;
            this._write(profiles);
            this._rebuild();
        });
        dialog.present(this._window);
    }
}

// ---------- Galeria de widgets ----------

// Pastas de configuração do Claude Code com login, além da padrão (~/.claude).
function claudeAccountDirs() {
    const home = GLib.get_home_dir();
    const found = [];
    try {
        const dir = GLib.Dir.open(home, 0);
        for (let name = dir.read_name(); name !== null; name = dir.read_name()) {
            if (/^\.claude-[\w.-]+$/.test(name) && GLib.file_test(
                GLib.build_filenamev([home, name, '.credentials.json']), GLib.FileTest.EXISTS))
                found.push(name);
        }
        dir.close();
    } catch {
        // Sem acesso à pasta pessoal: fica só a conta padrão.
    }
    return found.sort();
}

// Minúsculas e sem acentos, para comparar o que foi digitado.
function plain(text) {
    return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

class GalleryPage {
    constructor(settings, extensionPath, window) {
        this._settings = settings;
        this._shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
        this._previews = GLib.build_filenamev([extensionPath, 'previews']);
        this._profileId = null;

        this.page = new Adw.PreferencesPage({
            title: 'Widgets',
            icon_name: 'view-grid-symbolic',
        });

        // Criar, instalar e compartilhar widgets feitos fora do dock. Fica
        // recolhido no topo: a galeria logo abaixo é comprida.
        this._window = window;
        this._docs = GLib.build_filenamev([extensionPath, 'docs', 'widgets-personalizados.md']);
        const customGroup = new Adw.PreferencesGroup();
        this._customGroup = new Adw.ExpanderRow({
            title: 'Widgets personalizados',
            subtitle: 'Criar o seu, instalar de um arquivo e compartilhar',
            icon_name: 'application-x-addon-symbolic',
            // Quem já tem algum vê a lista de cara.
            expanded: listCustom().length > 0,
        });
        customGroup.add(this._customGroup);
        this.page.add(customGroup);
        this._customRows = [];

        const target = new Adw.PreferencesGroup({
            title: 'Galeria de widgets',
            description: 'Escolha a forma e adicione ao perfil. No dock, arraste para ' +
                'mudar de lugar; solte fora dele para tirar.',
        });
        this._profileRow = new Adw.ComboRow({title: 'Adicionar ao perfil'});
        this._profileRow.connect('notify::selected', () => {
            if (this._filling)
                return;
            this._profileId = this._profiles[this._profileRow.selected]?.id ?? null;
            this._fillCards();
        });
        target.add(this._profileRow);

        // Busca por nome ou descrição, sem ligar para acentos.
        this._query = '';
        this._search = new Gtk.SearchEntry({
            placeholder_text: 'Buscar widget',
            margin_top: 12,
        });
        this._search.connect('search-changed', () => {
            this._query = plain(this._search.text);
            this._flow.invalidate_filter();
        });
        target.add(this._search);
        this.page.add(target);

        this._flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            valign: Gtk.Align.START,
            homogeneous: true,
            min_children_per_line: 1,
            max_children_per_line: 2,
            column_spacing: 12,
            row_spacing: 12,
        });
        this._flow.set_filter_func(child =>
            !this._query || (child.get_child()._searchText ?? '').includes(this._query));
        const cards = new Adw.PreferencesGroup();
        cards.add(this._flow);
        this.page.add(cards);


        const id = this._settings.connect('changed::profiles', () => this._refresh());
        const accountsId = this._settings.connect('changed::git-accounts', () => this._refresh());
        const collectionsId = this._settings.connect('changed::collections', () => this._refresh());
        window.connect('close-request', () => {
            this._settings.disconnect(id);
            this._settings.disconnect(accountsId);
            this._settings.disconnect(collectionsId);
            return false;
        });
        this._refresh();
        this._fillCustom();
    }

    selectProfile(id) {
        this._profileId = id;
        this._refresh();
    }

    _read() {
        return loadProfiles(this._settings, this._shellSettings)[0];
    }

    _update(change) {
        const profiles = this._read();
        const profile = profiles.find(p => p.id === this._profileId);
        if (!profile)
            return;
        change(profile);
        this._settings.set_string('profiles', JSON.stringify(profiles));
    }

    _refresh() {
        this._profiles = this._read();
        if (!this._profiles.some(p => p.id === this._profileId)) {
            const current = Math.min(Math.max(this._settings.get_int('current-profile'), 0), this._profiles.length - 1);
            this._profileId = this._profiles[current].id;
        }

        this._filling = true;
        this._profileRow.model = Gtk.StringList.new(this._profiles.map(p => p.name));
        this._profileRow.selected = this._profiles.findIndex(p => p.id === this._profileId);
        this._filling = false;
        this._fillCards();
    }

    _fillCards() {
        this._keepScroll();
        this._flow.remove_all();
        const profile = this._profiles.find(p => p.id === this._profileId);
        if (!profile)
            return;
        for (const [name, label, , description] of WIDGET_INFO) {
            // Uma coleção só existe com um grupo de apps: um cartão por
            // coleção criada, e nenhum genérico.
            if (name === 'collection') {
                for (const collection of readList(this._settings, 'collections')) {
                    this._flow.append(this._buildCard(profile, `collection@${collection.id}`,
                        `Coleção: ${collection.name || 'sem nome'}`,
                        'Um ícone que abre os apps desta coleção. Crie e edite na aba Conteúdo.'));
                }
                continue;
            }

            this._flow.append(this._buildCard(profile, name, label, description));
            // Uma conta do Claude por pasta de configuração com login.
            if (name === 'claude') {
                for (const dir of claudeAccountDirs()) {
                    this._flow.append(this._buildCard(profile, `claude@${dir}`,
                        `Uso do Claude: ${dir.replace(/^\.claude-?/, '')}`,
                        `A conta de ~/${dir}. Pode ficar ao lado da conta padrão.`));
                }
            }
            if (name !== 'git')
                continue;
            // Além do widget geral, um por conta, para ter vários lado a lado.
            for (const account of readAccounts(this._settings)) {
                this._flow.append(this._buildCard(profile, `git@${account.id}`,
                    `Git: ${accountName(account)}`,
                    'Só esta conta. Pode ficar ao lado de outros widgets de Git.'));
            }
        }
        for (const info of listCustom()) {
            this._flow.append(this._buildCard(profile, customName(info.id), info.name,
                info.error ? `Não carrega: ${info.error}`
                    : info.description || 'Widget personalizado.'));
        }
    }

    // ---------- Widgets personalizados ----------

    _fillCustom() {
        this._customRows.forEach(row => this._customGroup.remove(row));
        this._customRows = [];
        const add = row => {
            this._customGroup.add_row(row);
            this._customRows.push(row);
        };

        const create = new Adw.EntryRow({title: 'Criar um widget (dê um nome)', show_apply_button: true});
        create.connect('apply', () => {
            try {
                const dir = createTemplate(create.text.trim());
                create.text = '';
                this._customChanged();
                Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(dir, null), null);
                this._toast('Widget criado. Edite o widget.sh na pasta que abriu e adicione-o na galeria.');
            } catch (e) {
                this._toast(e.message);
            }
        });
        add(create);

        const install = new Adw.ActionRow({
            title: 'Instalar de um arquivo…',
            subtitle: `Um ${ARCHIVE_SUFFIX} que alguém compartilhou com você`,
            activatable: true,
        });
        install.add_suffix(new Gtk.Image({icon_name: 'document-open-symbolic'}));
        install.connect('activated', () => this._chooseArchive());
        add(install);

        const guide = new Adw.ActionRow({
            title: 'Guia: como criar um widget',
            subtitle: 'O formato do manifest, do script e exemplos prontos',
            activatable: true,
        });
        guide.add_suffix(new Gtk.Image({icon_name: 'help-browser-symbolic'}));
        guide.connect('activated', () => Gio.AppInfo.launch_default_for_uri(
            GLib.filename_to_uri(this._docs, null), null));
        add(guide);

        for (const info of listCustom()) {
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(info.name, -1),
                subtitle: GLib.markup_escape_text(
                    info.error ? `Não carrega: ${info.error}`
                        : [info.description, info.author && `por ${info.author}`]
                            .filter(Boolean).join(' · ') || info.id, -1),
            });
            const button = (icon, tooltip, action) => {
                const b = new Gtk.Button({
                    icon_name: icon, tooltip_text: tooltip,
                    valign: Gtk.Align.CENTER, css_classes: ['flat'],
                });
                b.connect('clicked', action);
                row.add_suffix(b);
            };
            button('folder-open-symbolic', 'Abrir a pasta', () =>
                Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(info.dir, null), null));
            button('document-send-symbolic', 'Exportar para compartilhar', () => this._export(info));
            button('user-trash-symbolic', 'Remover', () => this._confirmRemove(info));
            add(row);
        }
    }

    _toast(message) {
        this._window.add_toast(new Adw.Toast({title: message, timeout: 5}));
    }

    _customChanged() {
        this._fillCustom();
        this._fillCards();
    }

    _export(info) {
        const dialog = new Gtk.FileDialog({
            title: 'Exportar widget',
            initial_name: `${info.id}${ARCHIVE_SUFFIX}`,
        });
        dialog.save(this._window, null, (_dialog, result) => {
            try {
                const file = dialog.save_finish(result);
                exportWidget(info.id, file.get_path());
                this._toast(`Exportado para ${file.get_basename()}.`);
            } catch (e) {
                if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    this._toast(e.message);
            }
        });
    }

    _chooseArchive() {
        const filter = new Gtk.FileFilter({name: 'Widget do gprdock'});
        filter.add_pattern(`*${ARCHIVE_SUFFIX}`);
        filter.add_pattern('*.tar.gz');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        const dialog = new Gtk.FileDialog({title: 'Instalar widget', filters});
        dialog.open(this._window, null, (_dialog, result) => {
            try {
                this._confirmInstall(dialog.open_finish(result).get_path());
            } catch (e) {
                if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    this._toast(e.message);
            }
        });
    }

    // Um widget roda programas com as suas permissões: antes de instalar, a
    // pessoa vê de quem é e o que vem dentro.
    _confirmInstall(path) {
        const pack = inspectArchive(path);
        const dialog = new Adw.AlertDialog({
            heading: `Instalar "${pack.name}"?`,
            body: [
                pack.description,
                pack.author ? `Autor: ${pack.author}` : 'Autor não informado',
                `Arquivos: ${pack.files.join(', ')}`,
                pack.replaces ? `Substitui o widget "${pack.id}" que você já tem.` : '',
                'Um widget roda programas no seu computador com as suas permissões, ' +
                'como qualquer script. Só instale de quem você confia; na dúvida, ' +
                'abra o arquivo e leia antes.',
            ].filter(Boolean).join('\n\n'),
        });
        dialog.add_response('cancel', 'Cancelar');
        dialog.add_response('install', 'Instalar');
        dialog.set_response_appearance('install', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_d, response) => {
            if (response !== 'install')
                return;
            try {
                installArchive(path);
                this._customChanged();
                this._toast(`"${pack.name}" instalado. Adicione-o na galeria acima.`);
            } catch (e) {
                this._toast(e.message);
            }
        });
        dialog.present(this._window);
    }

    _confirmRemove(info) {
        const dialog = new Adw.AlertDialog({
            heading: `Remover "${info.name}"?`,
            body: 'A pasta do widget é apagada e ele sai de todos os perfis.',
        });
        dialog.add_response('cancel', 'Cancelar');
        dialog.add_response('remove', 'Remover');
        dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_d, response) => {
            if (response !== 'remove')
                return;
            try {
                removeWidget(info.id);
                const item = widgetItem(customName(info.id));
                const profiles = this._read();
                profiles.forEach(p => (p.items = p.items.filter(entry => entry !== item)));
                this._settings.set_string('profiles', JSON.stringify(profiles));
                this._customChanged();
            } catch (e) {
                this._toast(e.message);
            }
        });
        dialog.present(this._window);
    }

    // Refazer os cartões esvazia a lista por um instante, e a página voltaria
    // para o topo. A altura fica presa enquanto isso e a rolagem é devolvida.
    _keepScroll() {
        const adjustment = this._flow.get_ancestor(Gtk.ScrolledWindow)?.vadjustment;
        if (!adjustment || this._scrollId)
            return;
        const value = adjustment.value;
        this._flow.height_request = this._flow.get_height();
        this._scrollId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scrollId = 0;
            adjustment.value = value;
            this._flow.height_request = -1;
            return GLib.SOURCE_REMOVE;
        });
    }

    _buildCard(profile, name, label, description) {
        const item = widgetItem(name);
        const added = profile.items.includes(item);

        const card = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            css_classes: ['card'],
        });
        card._searchText = plain(`${label} ${description}`);
        const inner = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        card.append(inner);

        const picture = new Gtk.Picture({
            height_request: 72,
            can_shrink: true,
            content_fit: Gtk.ContentFit.SCALE_DOWN,
        });
        const custom = widgetBase(name) === 'custom' ? customInfo(widgetParam(name)) : null;
        const showPreview = size => {
            // Um widget personalizado pode trazer preview-<forma>.png (ou
            // só preview.png) na pasta dele.
            const candidates = custom
                ? [`preview-${size}.png`, 'preview.png'].map(f => GLib.build_filenamev([custom.dir, f]))
                : [GLib.build_filenamev([this._previews, `${widgetBase(name)}-${size}.png`])];
            const found = candidates.find(f => GLib.file_test(f, GLib.FileTest.EXISTS));
            picture.visible = Boolean(found);
            if (found)
                picture.set_filename(found);
        };
        inner.append(picture);

        inner.append(new Gtk.Label({
            label,
            xalign: 0,
            css_classes: ['heading'],
        }));
        inner.append(new Gtk.Label({
            label: description,
            xalign: 0,
            wrap: true,
            vexpand: true,
            valign: Gtk.Align.START,
            css_classes: ['dim-label', 'caption'],
        }));

        const actions = new Gtk.Box({spacing: 8});
        const sizes = widgetSizes(name);
        const size = new Gtk.DropDown({
            model: Gtk.StringList.new(sizes.map(([, sizeLabel]) => sizeLabel)),
            selected: sizes.findIndex(([value]) => value === widgetSize(profile, name)),
            tooltip_text: 'Forma do widget',
        });
        size.connect('notify::selected', () => {
            const chosen = sizes[size.selected][0];
            showPreview(chosen);
            this._update(p => (p.sizes[name] = chosen));
        });
        showPreview(sizes[size.selected][0]);

        const toggle = new Gtk.Button({
            label: added ? 'Remover' : 'Adicionar',
            hexpand: true,
            halign: Gtk.Align.END,
            css_classes: added ? [] : ['suggested-action'],
        });
        toggle.connect('clicked', () => this._update(p => {
            p.items = p.items.filter(entry => entry !== item);
            if (!added)
                p.items.push(item);
        }));
        actions.append(size);
        actions.append(toggle);
        inner.append(actions);
        return card;
    }
}

// ---------- Ajustes gerais e dos widgets ----------

class SettingsPage {
    constructor(settings) {
        this._settings = settings;
        this.page = new Adw.PreferencesPage({
            title: 'Ajustes',
            icon_name: 'preferences-system-symbolic',
        });

        this._buildDock();
        this._buildAutoProfile();
        this._buildWeather();
        this._buildPomodoro();
        this._buildOtherWidgets();
        this._buildJarvis();
    }

    _entry(key, title) {
        const row = new Adw.EntryRow({
            title,
            text: this._settings.get_string(key),
            show_apply_button: true,
        });
        row.connect('apply', () => this._settings.set_string(key, row.text.trim()));
        return row;
    }

    _buildOtherWidgets() {
        const timer = new Adw.PreferencesGroup({
            title: 'Timer e cronômetro',
            description: 'No dock: clique inicia ou pausa, clique direito zera',
        });
        timer.add(this._spin('timer-minutes', 'Duração do timer', 'Minutos', 1, 600));
        this.page.add(timer);

        this._buildWorldClocks();

        const countdown = new Adw.PreferencesGroup({title: 'Contagem regressiva'});
        countdown.add(this._entry('countdown-label', 'Nome (ex.: Férias)'));
        countdown.add(this._entry('countdown-date', 'Data, no formato AAAA-MM-DD'));
        this.page.add(countdown);

        const water = new Adw.PreferencesGroup({
            title: 'Beber água',
            description: 'No dock: clique soma um copo, clique direito tira um',
        });
        water.add(this._spin('water-goal', 'Meta do dia', 'Copos', 1, 30));
        this.page.add(water);

        const note = new Adw.PreferencesGroup({title: 'Nota'});
        note.add(this._entry('note-text', 'Texto do recado'));
        this.page.add(note);
    }

    // ---------- Relógio mundial ----------

    _buildWorldClocks() {
        const group = new Adw.PreferencesGroup({
            title: 'Relógio mundial',
            description: 'Cidades do widget, pelo nome do fuso: Região/Cidade ' +
                '(Europe/Lisbon, America/New_York, Asia/Tokyo). A primeira aparece no dock.',
        });
        this.page.add(group);
        let rows = [];
        const fill = () => {
            rows.forEach(row => group.remove(row));
            rows = [];
            const zones = this._settings.get_strv('world-clocks');
            for (const zone of zones) {
                const row = new Adw.ActionRow({
                    title: GLib.markup_escape_text(zone.split('/').at(-1).replaceAll('_', ' '), -1),
                    subtitle: GLib.markup_escape_text(zone, -1),
                });
                row.add_suffix(iconButton('user-trash-symbolic', 'Remover', () => {
                    this._settings.set_strv('world-clocks',
                        this._settings.get_strv('world-clocks').filter(z => z !== zone));
                    fill();
                }));
                group.add(row);
                rows.push(row);
            }

            const entry = new Adw.EntryRow({
                title: 'Adicionar fuso (ex.: Europe/Lisbon)',
                show_apply_button: true,
            });
            entry.connect('apply', () => {
                const zone = entry.text.trim();
                // Um fuso que o sistema não conhece vira UTC: é assim que se
                // percebe o erro de digitação.
                const known = zone.includes('/') &&
                    GLib.TimeZone.new_identifier(zone)?.get_identifier() === zone;
                if (!known) {
                    entry.add_css_class('error');
                    return;
                }
                this._settings.set_strv('world-clocks',
                    [...new Set([...this._settings.get_strv('world-clocks'), zone])]);
                fill();
            });
            group.add(entry);
            rows.push(entry);
        };
        fill();
    }

    _spin(key, title, subtitle, min, max, step = 1) {
        const row = Adw.SpinRow.new_with_range(min, max, step);
        row.title = title;
        row.subtitle = subtitle;
        this._settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _buildDock() {
        const group = new Adw.PreferencesGroup({title: 'Dock'});
        group.add(this._spin('icon-size', 'Tamanho dos ícones',
            'Os widgets acompanham este tamanho', 24, 96, 2));

        const monitors = new Adw.SwitchRow({
            title: 'Em todos os monitores',
            subtitle: 'Um dock em cada tela, com os mesmos itens; o mascote solto fica só na principal',
        });
        this._settings.bind('all-monitors', monitors, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(monitors);

        const autohide = new Adw.SwitchRow({
            title: 'Ocultar automaticamente',
            subtitle: 'O dock some e volta quando o cursor encosta na borda de baixo; ' +
                'as janelas passam a usar a tela toda',
        });
        this._settings.bind('autohide', autohide, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(autohide);

        const bind = new Adw.SwitchRow({
            title: 'Um perfil por área de trabalho',
            subtitle: 'Trocar de perfil troca de área de trabalho, e vice-versa; ' +
                'as janelas do outro perfil saem da frente',
        });
        this._settings.bind('bind-workspaces', bind, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(bind);

        const actions = [
            ['smart', 'Inteligente: várias janelas, escolher; uma só, minimizar'],
            ['cycle', 'Alternar entre as janelas'],
            ['menu', 'Mostrar a lista de janelas'],
            ['overview', 'Expandir as janelas do app (como o Super)'],
            ['minimize', 'Minimizar'],
            ['close', 'Fechar a janela'],
            ['new-window', 'Abrir nova janela'],
            ['focus', 'Só trazer para a frente'],
        ];
        const actionRow = (key, title, subtitle) => {
            const row = new Adw.ComboRow({
                title,
                subtitle,
                model: Gtk.StringList.new(actions.map(([, label]) => label)),
                selected: Math.max(0, actions.findIndex(
                    ([value]) => value === this._settings.get_string(key))),
            });
            row.connect('notify::selected', () =>
                this._settings.set_string(key, actions[row.selected][0]));
            return row;
        };
        group.add(actionRow('click-action', 'Clique em app já aberto', ''));
        group.add(actionRow('middle-click-action', 'Clique do meio em app já aberto', ''));

        const previews = new Adw.SwitchRow({
            title: 'Prévia das janelas',
            subtitle: 'Parar o cursor num app com mais de uma janela mostra as miniaturas',
        });
        this._settings.bind('window-previews', previews, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(previews);

        const badges = new Adw.SwitchRow({
            title: 'Contador de notificações',
            subtitle: 'O número de avisos pendentes no canto do ícone do app',
        });
        this._settings.bind('notification-badges', badges, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(badges);
        this.page.add(group);
    }

    // ---------- Troca automática de perfil ----------

    _readRules() {
        return readList(this._settings, 'auto-profile-rules');
    }

    _buildAutoProfile() {
        this._autoGroup = new Adw.PreferencesGroup({
            title: 'Troca automática de perfil',
            description: 'O perfil muda sozinho numa hora do dia ou ao conectar numa rede. ' +
                'Com "um perfil por área de trabalho", a área de trabalho muda junto.',
        });
        this.page.add(this._autoGroup);
        this._autoRows = [];
        const id = this._settings.connect('changed::profiles', () => this._fillAutoProfile());
        this.page.connect('destroy', () => this._settings.disconnect(id));
        this._fillAutoProfile();
    }

    _fillAutoProfile() {
        this._autoRows.forEach(row => this._autoGroup.remove(row));
        this._autoRows = [];
        const add = row => {
            this._autoGroup.add(row);
            this._autoRows.push(row);
        };

        const [profiles] = loadProfiles(this._settings, new Gio.Settings({schema_id: 'org.gnome.shell'}));
        const rules = this._readRules();
        const save = list => {
            this._settings.set_string('auto-profile-rules', JSON.stringify(list));
            this._fillAutoProfile();
        };

        for (const rule of rules) {
            const profile = profiles.find(p => p.id === rule.profile);
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(rule.type === 'time'
                    ? `Às ${rule.value}${rule.weekdays ? ', de segunda a sexta' : ''}`
                    : `Ao conectar em ${rule.value}`, -1),
                subtitle: GLib.markup_escape_text(
                    profile ? `Muda para ${profile.name}` : 'O perfil desta regra foi removido', -1),
            });
            row.add_suffix(iconButton('user-trash-symbolic', 'Remover a regra',
                () => save(this._readRules().filter(r => r.id !== rule.id))));
            add(row);
        }

        const form = new Adw.ExpanderRow({
            title: 'Nova regra',
            icon_name: 'list-add-symbolic',
        });
        const type = new Adw.ComboRow({
            title: 'Quando',
            model: Gtk.StringList.new(['Numa hora do dia', 'Ao conectar numa rede']),
        });
        const time = new Adw.EntryRow({title: 'Hora, no formato HH:MM (ex.: 09:00)'});
        const weekdays = new Adw.SwitchRow({title: 'Só de segunda a sexta'});
        const network = new Adw.EntryRow({
            title: 'Nome da conexão (Wi-Fi, VPN; sta0 é o Netskope)',
        });
        const target = new Adw.ComboRow({
            title: 'Mudar para o perfil',
            model: Gtk.StringList.new(profiles.map(p => p.name)),
        });
        const create = new Adw.ButtonRow({title: 'Adicionar regra'});
        const syncType = () => {
            const byTime = type.selected === 0;
            time.visible = byTime;
            weekdays.visible = byTime;
            network.visible = !byTime;
        };
        type.connect('notify::selected', syncType);
        syncType();

        create.connect('activated', () => {
            const byTime = type.selected === 0;
            let value = (byTime ? time.text : network.text).trim();
            if (byTime) {
                const match = value.match(/^(\d{1,2}):(\d{2})$/);
                if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
                    time.add_css_class('error');
                    return;
                }
                value = `${match[1].padStart(2, '0')}:${match[2]}`;
            } else if (!value) {
                network.add_css_class('error');
                return;
            }
            save([...this._readRules(), {
                id: GLib.uuid_string_random().slice(0, 8),
                type: byTime ? 'time' : 'network',
                value,
                weekdays: byTime && weekdays.active,
                profile: profiles[target.selected]?.id,
            }]);
        });
        for (const row of [type, time, weekdays, network, target, create])
            form.add_row(row);
        add(form);
    }

    _buildJarvis() {
        const group = new Adw.PreferencesGroup({
            title: 'Jarvis',
            description: 'No dock: clique faz ouvir (ou interrompe), clique direito abre o painel',
        });
        const url = new Adw.EntryRow({
            title: 'Endereço',
            text: this._settings.get_string('jarvis-url'),
            show_apply_button: true,
        });
        url.connect('apply', () => this._settings.set_string('jarvis-url', url.text.trim()));
        group.add(url);
        this.page.add(group);
    }

    _buildWeather() {
        const group = new Adw.PreferencesGroup({title: 'Clima'});
        this._cityRow = new Adw.ActionRow({title: 'Cidade em uso'});
        const showCity = () => {
            const lat = this._settings.get_double('weather-latitude').toFixed(3);
            const lon = this._settings.get_double('weather-longitude').toFixed(3);
            this._cityRow.subtitle =
                `${this._settings.get_string('weather-city')} (${lat}, ${lon})`;
        };
        showCity();
        group.add(this._cityRow);

        const search = new Adw.EntryRow({
            title: 'Buscar outra cidade',
            show_apply_button: true,
        });
        group.add(search);
        this.page.add(group);

        this._results = new Adw.PreferencesGroup();
        this.page.add(this._results);
        this._resultRows = [];
        this._session = new Soup.Session({timeout: 15});

        const showResults = rows => {
            this._resultRows.forEach(row => this._results.remove(row));
            this._resultRows = rows;
            rows.forEach(row => this._results.add(row));
        };
        const message = text => showResults([new Adw.ActionRow({title: text})]);

        search.connect('apply', () => {
            const query = search.text.trim();
            if (!query)
                return;
            message('Buscando…');

            const url = `${GEOCODING_URL}?name=${encodeURIComponent(query)}` +
                '&count=6&language=pt&format=json';
            const request = Soup.Message.new('GET', url);
            this._session.send_and_read_async(request, GLib.PRIORITY_DEFAULT, null,
                (session, result) => {
                    let places = null;
                    try {
                        const bytes = session.send_and_read_finish(result);
                        if (request.status_code === 200) {
                            places = JSON.parse(
                                new TextDecoder().decode(bytes.get_data())).results ?? [];
                        }
                    } catch {
                        // Tratado abaixo como falha de busca.
                    }

                    if (!places) {
                        message('Não foi possível buscar agora');
                    } else if (places.length === 0) {
                        message('Nenhuma cidade encontrada');
                    } else {
                        showResults(places.map(place => {
                            const where = [place.admin1, place.country].filter(Boolean).join(', ');
                            const row = new Adw.ActionRow({
                                title: GLib.markup_escape_text(place.name, -1),
                                subtitle: GLib.markup_escape_text(where, -1),
                                activatable: true,
                            });
                            row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
                            row.connect('activated', () => {
                                this._settings.set_string('weather-city', place.name);
                                this._settings.set_double('weather-latitude', place.latitude);
                                this._settings.set_double('weather-longitude', place.longitude);
                                showCity();
                                search.text = '';
                                showResults([]);
                            });
                            return row;
                        }));
                    }
                });
        });
    }

    _buildPomodoro() {
        const group = new Adw.PreferencesGroup({
            title: 'Pomodoro',
            description: 'No dock: clique inicia ou pausa, clique direito zera a contagem',
        });
        group.add(this._spin('pomodoro-focus-minutes', 'Foco', 'Minutos', 1, 180));
        group.add(this._spin('pomodoro-short-minutes', 'Pausa curta', 'Minutos', 1, 60));
        group.add(this._spin('pomodoro-long-minutes', 'Pausa longa', 'Minutos', 1, 120));
        group.add(this._spin('pomodoro-cycles', 'Focos até a pausa longa', '', 1, 12));

        const reset = new Adw.ButtonRow({
            title: 'Zerar pomodoro e ciclos de hoje',
            start_icon_name: 'view-refresh-symbolic',
        });
        reset.connect('activated', () => this._settings.set_string('pomodoro-state', ''));
        group.add(reset);
        this.page.add(group);
    }
}

// ---------- Conteúdo dos widgets: favoritos, atalhos e coleções ----------

class ContentPage {
    constructor(settings, chooseApp) {
        this._settings = settings;
        this._chooseApp = chooseApp;
        this._groups = [];
        this._expanded = new Set();
        this.page = new Adw.PreferencesPage({
            title: 'Conteúdo',
            icon_name: 'view-list-symbolic',
        });
        this._rebuild();
    }

    _write(key, list) {
        this._settings.set_string(key, JSON.stringify(list));
    }

    _update(key, id, change) {
        const list = readList(this._settings, key);
        const entry = list.find(item => item.id === id);
        if (!entry)
            return;
        change(entry);
        this._write(key, list);
    }

    _rebuild() {
        this._groups.forEach(group => this.page.remove(group));
        this._groups = [];
        const add = group => {
            this.page.add(group);
            this._groups.push(group);
        };

        add(this._buildList('bookmarks', {
            title: 'Favoritos',
            description: 'Os sites que o widget de favoritos abre',
            field: 'url',
            fieldTitle: 'Endereço (ex.: github.com)',
            addLabel: 'Adicionar site',
        }));
        add(this._buildList('shortcuts', {
            title: 'Atalhos',
            description: 'Cada atalho roda um comando, como num terminal ' +
                '(ex.: ~/bin/backup.sh, ou code ~/projeto)',
            field: 'command',
            fieldTitle: 'Comando',
            addLabel: 'Adicionar atalho',
        }));
        add(this._buildCollections());
    }

    _expander(key, title) {
        const row = new Adw.ExpanderRow({title: GLib.markup_escape_text(title, -1)});
        row.expanded = this._expanded.has(key);
        row.connect('notify::expanded', () => {
            if (row.expanded)
                this._expanded.add(key);
            else
                this._expanded.delete(key);
        });
        return row;
    }

    _nameRow(key, entry, expander, fallback) {
        const name = new Adw.EntryRow({
            title: 'Nome',
            text: entry.name ?? '',
            show_apply_button: true,
        });
        name.connect('apply', () => {
            const text = name.text.trim();
            this._update(key, entry.id, e => (e.name = text));
            expander.title = GLib.markup_escape_text(text || fallback, -1);
        });
        return name;
    }

    _addButton(key, label, create) {
        const add = new Adw.ButtonRow({title: label, start_icon_name: 'list-add-symbolic'});
        add.connect('activated', () => {
            const entry = {id: GLib.uuid_string_random(), name: '', ...create};
            this._write(key, [...readList(this._settings, key), entry]);
            this._expanded.add(`${key}:${entry.id}`);
            this._rebuild();
        });
        return add;
    }

    _removeButton(key, id, afterRemove) {
        return iconButton('user-trash-symbolic', 'Remover', () => {
            this._write(key, readList(this._settings, key).filter(e => e.id !== id));
            afterRemove?.();
            this._rebuild();
        });
    }

    // Lista simples de itens com nome e um campo (endereço ou comando).
    _buildList(key, {title, description, field, fieldTitle, addLabel}) {
        const group = new Adw.PreferencesGroup({title, description});
        for (const entry of readList(this._settings, key)) {
            entry.id ||= GLib.uuid_string_random();
            const fallback = entry[field] || 'Sem nome';
            const expander = this._expander(`${key}:${entry.id}`, entry.name || fallback);
            expander.add_suffix(this._removeButton(key, entry.id));
            expander.add_row(this._nameRow(key, entry, expander, fallback));

            const value = new Adw.EntryRow({
                title: fieldTitle,
                text: entry[field] ?? '',
                show_apply_button: true,
            });
            value.connect('apply', () =>
                this._update(key, entry.id, e => (e[field] = value.text.trim())));
            expander.add_row(value);
            group.add(expander);
        }
        group.add(this._addButton(key, addLabel, {[field]: ''}));
        return group;
    }

    _buildCollections() {
        const key = 'collections';
        const group = new Adw.PreferencesGroup({
            title: 'Coleções de apps',
            description: 'Cada coleção vira um widget próprio: depois de criar, ' +
                'adicione-a ao dock pela aba Widgets',
        });

        for (const collection of readList(this._settings, key)) {
            const {id} = collection;
            const apps = Array.isArray(collection.apps) ? collection.apps : [];
            const expander = this._expander(`${key}:${id}`, collection.name || 'Sem nome');
            expander.subtitle = `${apps.length} apps`;
            expander.add_suffix(this._removeButton(key, id,
                () => forgetWidget(this._settings, `collection@${id}`)));
            expander.add_row(this._nameRow(key, collection, expander, 'Sem nome'));

            apps.forEach((appId, index) => {
                const info = GioUnix.DesktopAppInfo.new(appId);
                const row = new Adw.ActionRow({
                    title: GLib.markup_escape_text(info?.get_name() ?? appId, -1),
                });
                const icon = new Gtk.Image({pixel_size: 32});
                if (info?.get_icon())
                    icon.gicon = info.get_icon();
                else
                    icon.icon_name = 'application-x-executable-symbolic';
                row.add_prefix(icon);
                row.add_suffix(iconButton('list-remove-symbolic', 'Tirar da coleção', () => {
                    this._update(key, id, c => c.apps.splice(index, 1));
                    this._rebuild();
                }));
                expander.add_row(row);
            });

            const add = new Adw.ButtonRow({
                title: 'Adicionar app…',
                start_icon_name: 'list-add-symbolic',
            });
            add.connect('activated', () => this._chooseApp(apps, appId => {
                this._update(key, id, c => {
                    c.apps = [...Array.isArray(c.apps) ? c.apps : [], appId];
                });
                this._rebuild();
            }));
            expander.add_row(add);
            group.add(expander);
        }

        group.add(this._addButton(key, 'Nova coleção', {apps: []}));
        return group;
    }
}

// ---------- Contas do GitHub e do GitLab ----------

const ACCOUNT_TYPES = [
    ['github', 'GitHub', 'github.com'],
    ['gitlab', 'GitLab', 'gitlab.com'],
];

class AccountsPage {
    constructor(settings) {
        this._settings = settings;
        this._groups = [];
        this.page = new Adw.PreferencesPage({
            title: 'Contas',
            icon_name: 'system-users-symbolic',
        });
        this._rebuild();
    }

    _read() {
        try {
            const list = JSON.parse(this._settings.get_string('git-accounts'));
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    _update(id, change) {
        const accounts = this._read();
        const account = accounts.find(a => a.id === id);
        if (!account)
            return;
        change(account);
        this._settings.set_string('git-accounts', JSON.stringify(accounts));
    }

    _rebuild() {
        this._groups.forEach(group => this.page.remove(group));
        this._groups = [];
        const add = group => {
            this.page.add(group);
            this._groups.push(group);
        };

        const accounts = this._read();
        if (accounts.length === 0) {
            add(new Adw.PreferencesGroup({
                title: 'GitHub e GitLab',
                description: 'O widget de Git soma, de todas as contas, os pull e merge ' +
                    'requests que esperam a sua revisão e os seus que estão abertos.',
            }));
        }
        accounts.forEach(account => add(this._buildAccount(account)));

        const actions = new Adw.PreferencesGroup();
        const button = new Adw.ButtonRow({
            title: 'Adicionar conta',
            start_icon_name: 'list-add-symbolic',
        });
        button.connect('activated', () => {
            const list = this._read();
            list.push({id: GLib.uuid_string_random(), type: 'github', name: '', host: ''});
            this._settings.set_string('git-accounts', JSON.stringify(list));
            this._rebuild();
        });
        actions.add(button);
        add(actions);
    }

    // A conta saiu: saem dos perfis o widget próprio dela e a escolha dela.
    _forgetAccount(id) {
        forgetWidget(this._settings, `git@${id}`);
        const shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
        const [profiles] = loadProfiles(this._settings, shellSettings);
        for (const profile of profiles) {
            if (Array.isArray(profile.gitAccounts))
                profile.gitAccounts = profile.gitAccounts.filter(a => a !== id);
        }
        this._settings.set_string('profiles', JSON.stringify(profiles));
    }

    _buildAccount(account) {
        const {id} = account;
        const typeIndex = Math.max(0, ACCOUNT_TYPES.findIndex(([t]) => t === account.type));
        const group = new Adw.PreferencesGroup({
            title: GLib.markup_escape_text(account.name || 'Conta sem nome', -1),
        });
        group.set_header_suffix(iconButton('user-trash-symbolic', 'Remover esta conta', () => {
            Secret.password_clear(TOKEN_SCHEMA, {account: id}, null, null);
            this._settings.set_string('git-accounts',
                JSON.stringify(this._read().filter(a => a.id !== id)));
            this._forgetAccount(id);
            this._rebuild();
        }));

        const host = new Adw.EntryRow({
            text: account.host ?? '',
            show_apply_button: true,
        });
        const setHostTitle = index =>
            (host.title = `Servidor (vazio = ${ACCOUNT_TYPES[index][2]})`);
        setHostTitle(typeIndex);

        const type = new Adw.ComboRow({
            title: 'Serviço',
            model: Gtk.StringList.new(ACCOUNT_TYPES.map(([, label]) => label)),
            selected: typeIndex,
        });
        type.connect('notify::selected', () => {
            setHostTitle(type.selected);
            this._update(id, a => (a.type = ACCOUNT_TYPES[type.selected][0]));
        });
        group.add(type);

        const name = new Adw.EntryRow({
            title: 'Nome (como aparece no painel)',
            text: account.name ?? '',
            show_apply_button: true,
        });
        name.connect('apply', () => {
            this._update(id, a => (a.name = name.text.trim()));
            group.title = GLib.markup_escape_text(name.text.trim() || 'Conta sem nome', -1);
        });
        group.add(name);

        host.connect('apply', () => this._update(id, a => (a.host = host.text.trim())));
        group.add(host);

        // O token vai direto para o chaveiro do GNOME e nunca volta para a
        // tela: o campo só serve para gravar um novo.
        const token = new Adw.PasswordEntryRow({
            title: 'Token de acesso',
            show_apply_button: true,
        });
        const status = new Adw.ActionRow({title: 'Token', subtitle: 'Verificando…'});
        const showStatus = () => {
            Secret.password_lookup(TOKEN_SCHEMA, {account: id}, null, (_source, result) => {
                let saved = false;
                try {
                    saved = Boolean(Secret.password_lookup_finish(result));
                } catch {
                    // Chaveiro indisponível: tratado como "sem token".
                }
                status.subtitle = saved
                    ? 'Guardado no chaveiro do GNOME'
                    : 'Nenhum token guardado';
            });
        };
        token.connect('apply', () => {
            const value = token.text.trim();
            if (!value)
                return;
            Secret.password_store(TOKEN_SCHEMA, {account: id}, Secret.COLLECTION_DEFAULT,
                'gprdock: token de conta Git', value, null, (_source, result) => {
                    try {
                        Secret.password_store_finish(result);
                        token.text = '';
                        // Faz o widget consultar de novo com o token novo.
                        this._update(id, a => (a.tokenSavedAt = Date.now()));
                    } catch (e) {
                        status.subtitle = `Não foi possível guardar: ${e.message}`;
                        return;
                    }
                    showStatus();
                });
        });
        showStatus();
        group.add(token);
        group.add(status);

        const help = new Adw.ActionRow({
            title: 'Permissões do token',
            subtitle: 'GitHub: leitura de pull requests (escopo repo, ou "Pull requests: ' +
                'read" no token granular; para os pipelines, também "Actions: read"). ' +
                'GitLab: escopo read_api.',
        });
        group.add(help);
        return group;
    }
}

// ---------- Ícones dos apps e a biblioteca de ícones ----------

const ICON_PREVIEW = 48;
// Iconify: busca em mais de duzentas coleções de ícones de código aberto.
const ICONIFY_URL = 'https://api.iconify.design';
const ONLINE_FETCHED = 240;     // quantos a busca pede
const ONLINE_SHOWN = 72;        // quantos coloridos aparecem

const iconGicon = icon => isIconFile(icon)
    ? new Gio.FileIcon({file: Gio.File.new_for_path(icon)})
    : new Gio.ThemedIcon({name: icon});
const iconLabel = icon => isIconFile(icon) ? GLib.path_get_basename(icon) : icon;

class IconsPage {
    constructor(settings, window, chooseApp) {
        this._settings = settings;
        this._window = window;
        this._chooseApp = chooseApp;
        this._groups = [];
        this.page = new Adw.PreferencesPage({
            title: 'Ícones',
            icon_name: 'applications-graphics-symbolic',
        });

        const id = this._settings.connect('changed::app-icons', () => this._rebuild());
        window.connect('close-request', () => {
            this._settings.disconnect(id);
            return false;
        });
        this._rebuild();
    }

    _toast(text) {
        this._window.add_toast(new Adw.Toast({title: text}));
    }

    _rebuild() {
        this._groups.forEach(group => this.page.remove(group));
        this._groups = [this._buildApps(), this._buildLibrary()];
        this._groups.forEach(group => this.page.add(group));
    }

    _buildApps() {
        const group = new Adw.PreferencesGroup({
            title: 'Ícones dos apps',
            description: 'O ícone que cada app mostra no dock. Também dá para trocar ' +
                'pelo dock: clique direito no app, "Trocar ícone…"',
        });
        const icons = readAppIcons(this._settings);
        for (const [appId, icon] of Object.entries(icons)) {
            const info = GioUnix.DesktopAppInfo.new(appId);
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(info?.get_name() ?? appId, -1),
                subtitle: GLib.markup_escape_text(`${iconLabel(icon)}`, -1),
            });
            const image = new Gtk.Image({pixel_size: 32});
            image.gicon = customGicon(this._settings, appId) ?? info?.get_icon() ??
                new Gio.ThemedIcon({name: 'application-x-executable-symbolic'});
            row.add_prefix(image);
            row.add_suffix(iconButton('document-edit-symbolic', 'Trocar o ícone',
                () => this.pick(appId)));
            row.add_suffix(iconButton('edit-undo-symbolic', 'Voltar ao ícone original',
                () => setAppIcon(this._settings, appId, null)));
            group.add(row);
        }

        const add = new Adw.ButtonRow({
            title: 'Trocar o ícone de um app…',
            start_icon_name: 'list-add-symbolic',
        });
        add.connect('activated', () => this._chooseApp(Object.keys(icons),
            appId => this.pick(appId), 'Trocar o ícone de qual app?'));
        group.add(add);
        return group;
    }

    _buildLibrary() {
        const group = new Adw.PreferencesGroup({
            title: 'Biblioteca',
            description: 'As suas imagens (PNG, SVG, JPG, WebP ou ICO), prontas para ' +
                'usar em qualquer app',
        });
        const buttons = new Gtk.Box({spacing: 4});
        buttons.append(iconButton('folder-open-symbolic', 'Abrir a pasta da biblioteca', () => {
            GLib.mkdir_with_parents(libraryDir(), 0o755);
            Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(libraryDir(), null), null);
        }));
        buttons.append(iconButton('view-refresh-symbolic', 'Ler a pasta de novo',
            () => this._rebuild()));
        group.set_header_suffix(buttons);

        const paths = listLibrary();
        if (paths.length > 0) {
            const flow = new Gtk.FlowBox({
                selection_mode: Gtk.SelectionMode.NONE,
                homogeneous: true,
                max_children_per_line: 12,
                column_spacing: 4,
                row_spacing: 4,
                margin_top: 8,
                margin_bottom: 8,
                margin_start: 8,
                margin_end: 8,
            });
            for (const path of paths) {
                const overlay = new Gtk.Overlay({tooltip_text: iconLabel(path)});
                overlay.set_child(new Gtk.Image({
                    gicon: iconGicon(path),
                    pixel_size: ICON_PREVIEW,
                    margin_top: 10,
                    margin_bottom: 10,
                    margin_start: 10,
                    margin_end: 10,
                }));
                const remove = iconButton('window-close-symbolic', 'Tirar da biblioteca', () => {
                    removeFromLibrary(this._settings, path);
                    this._rebuild();
                });
                remove.css_classes = ['circular', 'osd'];
                remove.halign = Gtk.Align.END;
                remove.valign = Gtk.Align.START;
                overlay.add_overlay(remove);
                flow.append(new Gtk.FlowBoxChild({child: overlay, focusable: false}));
            }
            group.add(new Gtk.Frame({child: flow, css_classes: ['card'], margin_bottom: 12}));
        }

        const add = new Adw.ButtonRow({
            title: 'Importar imagens…',
            start_icon_name: 'list-add-symbolic',
        });
        add.connect('activated', () => this._chooseImages(true, () => this._rebuild()));
        group.add(add);
        const online = new Adw.ButtonRow({
            title: 'Buscar na internet…',
            start_icon_name: 'folder-download-symbolic',
        });
        online.connect('activated', () => this._searchOnline('', path => {
            this._toast(`${iconLabel(path)} entrou na biblioteca`);
            this._rebuild();
        }, false));
        group.add(online);
        return group;
    }

    _get(url, cancellable, onDone) {
        this._session ??= new Soup.Session({timeout: 15});
        const request = Soup.Message.new('GET', url);
        this._session.send_and_read_async(request, GLib.PRIORITY_DEFAULT, cancellable,
            (session, result) => {
                let bytes = null;
                try {
                    bytes = session.send_and_read_finish(result);
                    if (request.get_status() !== Soup.Status.OK)
                        bytes = null;
                } catch {
                    bytes = null;
                }
                if (!cancellable.is_cancelled())
                    onDone(bytes);
            });
    }

    // Busca ícones na internet (Iconify) e guarda o escolhido na biblioteca.
    // Só os coloridos: os de uma cor só são traços pretos, feitos para
    // botões, e somem num dock escuro. Com closeOnPick o diálogo fecha na
    // primeira escolha; sem, fica aberto para pegar vários.
    _searchOnline(query, onSaved, closeOnPick = true) {
        const dialog = new Adw.Dialog({
            title: 'Buscar ícones na internet',
            content_width: 560,
            content_height: 620,
        });
        let cancellable = new Gio.Cancellable();
        dialog.connect('closed', () => cancellable.cancel());

        const search = new Gtk.SearchEntry({
            placeholder_text: 'Em inglês rende mais: firefox, terminal, music…',
            search_delay: 500,
            margin_start: 12,
            margin_end: 12,
            margin_bottom: 8,
        });
        const status = new Adw.StatusPage({
            icon_name: 'system-search-symbolic',
            title: 'Busque um ícone',
            description: 'Ícones de coleções de código aberto, pelo Iconify. ' +
                'O que você escolher é baixado para a sua biblioteca.',
            vexpand: true,
        });
        const flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            homogeneous: true,
            max_children_per_line: 12,
            valign: Gtk.Align.START,
            margin_start: 6,
            margin_end: 6,
            margin_bottom: 6,
        });
        const scroll = new Gtk.ScrolledWindow({
            child: flow,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            visible: false,
        });
        const show = (title, description = '') => {
            status.title = title;
            status.description = description;
            status.visible = true;
            scroll.visible = false;
        };

        const addResult = (icon, collection) => {
            const [prefix, name] = icon.split(':');
            const image = new Gtk.Image({
                icon_name: 'content-loading-symbolic',
                pixel_size: ICON_PREVIEW,
                margin_top: 6,
                margin_bottom: 6,
                margin_start: 6,
                margin_end: 6,
            });
            const button = new Gtk.Button({
                child: image,
                css_classes: ['flat'],
                sensitive: false,
                tooltip_text: `${name}\n${collection.name ?? prefix}` +
                    `${collection.license?.title ? ` · ${collection.license.title}` : ''}`,
            });
            flow.append(new Gtk.FlowBoxChild({child: button, focusable: false}));
            this._get(`${ICONIFY_URL}/${prefix}/${name}.svg?height=256`, cancellable, bytes => {
                try {
                    image.paintable = Gdk.Texture.new_from_bytes(bytes);
                } catch {
                    // Não veio, ou não é uma imagem: fica sem poder escolher.
                    image.icon_name = 'image-missing-symbolic';
                    return;
                }
                button.sensitive = true;
                button.connect('clicked', () => {
                    try {
                        onSaved(saveToLibrary(`${prefix}-${name}.svg`, bytes.get_data()));
                    } catch (e) {
                        this._toast(`Não foi possível guardar o ícone: ${e.message}`);
                        return;
                    }
                    if (closeOnPick)
                        dialog.close();
                    else
                        button.sensitive = false;
                });
            });
        };

        const run = () => {
            // A busca anterior, e os ícones que ela ainda baixava, param aqui.
            cancellable.cancel();
            cancellable = new Gio.Cancellable();
            flow.remove_all();
            const text = search.text.trim();
            if (text.length < 2) {
                show('Busque um ícone', 'Ícones de coleções de código aberto, pelo Iconify. ' +
                    'O que você escolher é baixado para a sua biblioteca.');
                return;
            }
            show('Buscando…');
            const url = `${ICONIFY_URL}/search?query=${encodeURIComponent(text)}` +
                `&limit=${ONLINE_FETCHED}`;
            this._get(url, cancellable, bytes => {
                let found = null;
                try {
                    found = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                } catch {
                    show('A busca não respondeu', 'Confira a conexão e tente de novo.');
                    return;
                }
                const collections = found.collections ?? {};
                const icons = (found.icons ?? [])
                    .filter(icon => collections[icon.split(':')[0]]?.palette)
                    .slice(0, ONLINE_SHOWN);
                if (icons.length === 0) {
                    show('Nenhum ícone colorido com esse nome', 'Tente outro termo, em inglês.');
                    return;
                }
                status.visible = false;
                scroll.visible = true;
                icons.forEach(icon => addResult(icon, collections[icon.split(':')[0]]));
            });
        };
        search.connect('search-changed', run);

        const view = new Adw.ToolbarView();
        view.add_top_bar(new Adw.HeaderBar());
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(search);
        box.append(status);
        box.append(scroll);
        view.set_content(box);
        dialog.set_child(view);
        dialog.present(this._window);
        search.text = query;
        search.grab_focus();
    }

    // Pede imagens ao usuário, copia para a biblioteca e chama onImported
    // com os caminhos das cópias.
    _chooseImages(multiple, onImported) {
        const filter = new Gtk.FileFilter({name: 'Imagens'});
        ['png', 'svg', 'jpg', 'jpeg', 'webp', 'ico', 'bmp', 'gif'].forEach(suffix => {
            filter.add_pattern(`*.${suffix}`);
            filter.add_pattern(`*.${suffix.toUpperCase()}`);
        });
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        const dialog = new Gtk.FileDialog({title: 'Importar imagens', filters});
        const finish = files => {
            const imported = [];
            for (const file of files) {
                try {
                    imported.push(importToLibrary(file.get_path()));
                } catch (e) {
                    this._toast(e.message);
                }
            }
            if (imported.length > 0)
                onImported(imported);
        };
        const dismissed = e => e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED);
        if (multiple) {
            dialog.open_multiple(this._window, null, (_dialog, result) => {
                try {
                    const list = dialog.open_multiple_finish(result);
                    finish(Array.from({length: list.get_n_items()}, (_, i) => list.get_item(i)));
                } catch (e) {
                    if (!dismissed(e))
                        this._toast(e.message);
                }
            });
        } else {
            dialog.open(this._window, null, (_dialog, result) => {
                try {
                    finish([dialog.open_finish(result)]);
                } catch (e) {
                    if (!dismissed(e))
                        this._toast(e.message);
                }
            });
        }
    }

    // Ícones coloridos do tema do sistema (os simbólicos são traços de uma
    // cor só, feitos para botões).
    _themeIcons() {
        this._themeNames ??= Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
            .get_icon_names()
            .filter(name => !name.endsWith('-symbolic') && !name.endsWith('-symbolic-rtl'))
            .sort((a, b) => a.localeCompare(b));
        return this._themeNames;
    }

    // Escolhe o ícone de um app: os da biblioteca primeiro, depois os do
    // tema do sistema, ou um arquivo novo (que entra na biblioteca).
    pick(appId) {
        const info = GioUnix.DesktopAppInfo.new(appId);
        const dialog = new Adw.Dialog({
            title: `Ícone de ${info?.get_name() ?? appId}`,
            content_width: 560,
            content_height: 620,
        });
        const choose = icon => {
            setAppIcon(this._settings, appId, icon);
            dialog.close();
        };

        const search = new Gtk.SearchEntry({
            placeholder_text: 'Buscar na biblioteca e nos ícones do sistema',
            margin_start: 12,
            margin_end: 12,
            margin_bottom: 8,
        });
        const filter = Gtk.CustomFilter.new(item => {
            const query = search.text.trim().toLowerCase();
            return query === '' || iconLabel(item.string).toLowerCase().includes(query);
        });
        search.connect('search-changed', () => filter.changed(Gtk.FilterChange.DIFFERENT));
        const model = new Gtk.FilterListModel({
            model: Gtk.StringList.new([...listLibrary(), ...this._themeIcons()]),
            filter,
        });

        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_factory, item) => item.set_child(new Gtk.Image({
            pixel_size: ICON_PREVIEW,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        })));
        factory.connect('bind', (_factory, item) => {
            const icon = item.item.string;
            item.child.gicon = iconGicon(icon);
            item.child.tooltip_text = iconLabel(icon);
        });
        const grid = new Gtk.GridView({
            model: new Gtk.NoSelection({model}),
            factory,
            single_click_activate: true,
            min_columns: 4,
            max_columns: 12,
            margin_start: 6,
            margin_end: 6,
        });
        grid.connect('activate', (_grid, position) => choose(model.get_item(position).string));

        const header = new Adw.HeaderBar();
        const file = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            tooltip_text: 'Usar um arquivo de imagem (entra na biblioteca)',
        });
        file.connect('clicked', () => this._chooseImages(false, ([path]) => choose(path)));
        header.pack_start(file);
        const online = new Gtk.Button({
            icon_name: 'folder-download-symbolic',
            tooltip_text: 'Buscar um ícone na internet (entra na biblioteca)',
        });
        // O id do app costuma ser o nome dele em inglês (org.gnome.Nautilus);
        // o de um app web é um código, e aí vale o nome.
        const key = appId.replace(/\.desktop$/, '').split('.').pop();
        const guess = /[a-z]{32}|^gprdock-web-/.test(key) ? info?.get_name() ?? '' : key;
        online.connect('clicked', () => this._searchOnline(
            guess.replace(/[-_]+/g, ' ').toLowerCase(), path => choose(path)));
        header.pack_start(online);
        if (appId in readAppIcons(this._settings)) {
            const reset = new Gtk.Button({
                icon_name: 'edit-undo-symbolic',
                tooltip_text: 'Voltar ao ícone original',
            });
            reset.connect('clicked', () => choose(null));
            header.pack_start(reset);
        }

        const view = new Adw.ToolbarView();
        view.add_top_bar(header);
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(search);
        box.append(new Gtk.ScrolledWindow({
            child: grid,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        }));
        view.set_content(box);
        dialog.set_child(view);
        dialog.present(this._window);
        search.grab_focus();
    }
}

export default class GprDockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(680, 820);
        const gallery = new GalleryPage(settings, this.path, window);
        const profiles = new ProfilesPage(settings, window, profileId => {
            gallery.selectProfile(profileId);
            window.set_visible_page(gallery.page);
        });
        window.add(profiles.page);
        window.add(gallery.page);
        window.add(new SettingsPage(settings).page);
        window.add(new ContentPage(settings,
            (pinned, onChosen) => profiles._chooseApp(pinned, onChosen)).page);
        const icons = new IconsPage(settings, window,
            (taken, onChosen, title) => profiles._chooseApp(taken, onChosen, title));
        window.add(icons.page);
        window.add(new AccountsPage(settings).page);

        // O dock pode pedir para abrir direto na galeria, ou na troca do
        // ícone de um app ('icon:<id do app>'); com a janela já aberta, o
        // pedido chega pela mudança da chave.
        const openRequested = () => {
            const request = settings.get_string('prefs-page');
            if (request === '')
                return;
            settings.set_string('prefs-page', '');
            if (request === 'widgets') {
                window.set_visible_page(gallery.page);
            } else if (request.startsWith('icon:')) {
                window.set_visible_page(icons.page);
                window.present();
                icons.pick(request.slice('icon:'.length));
            }
        };
        const requestId = settings.connect('changed::prefs-page', openRequested);
        window.connect('close-request', () => {
            settings.disconnect(requestId);
            return false;
        });
        // A galeria já abre escolhida; o seletor de ícone espera a janela
        // estar na tela.
        if (settings.get_string('prefs-page') === 'widgets') {
            openRequested();
        } else {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                openRequested();
                return GLib.SOURCE_REMOVE;
            });
        }
    }
}
