import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup';
import St from 'gi://St';

import {Widget, httpGet, httpRequest, isCancelled} from './base.js';
import {Heatmap} from './gauges.js';
import {PIPELINE_MARKS, announceFailures, fetchPipelines} from './pipelines.js';
import {registerClass} from '../registerClass.js';

const REFRESH_SECONDS = 3 * 60;
const ACTIVITY_REFRESH_SECONDS = 30 * 60;
const LISTED = 5;
const ACTIVITY_WEEKS = 26;
const EVENT_PAGES = 30;     // até 3000 eventos do GitLab, quando não há calendário
const ACTIVITY_RETRY_SECONDS = 60;
// Depois de uma falha passageira (sem conexão, servidor com erro), a
// consulta se repete nestes intervalos, em segundos, antes de voltar a
// esperar o ciclo normal.
const RETRY_SECONDS = [10, 30, 60];
const DAY_MS = 24 * 60 * 60 * 1000;
// O último mapa de atividade fica guardado: ao ligar, ele aparece na hora,
// e uma conta fora do ar (rede ou VPN ainda subindo) não o apaga.
const ACTIVITY_CACHE = GLib.build_filenamev(
    [GLib.get_user_cache_dir(), 'gprdock', 'git-activity.json']);

const CONTRIBUTIONS_QUERY = `query {
    viewer { contributionsCollection { contributionCalendar {
        weeks { contributionDays { contributionCount date } }
    } } }
}`;

// AAAA-MM-DD no fuso local, a chave dos dias do mapa de atividade.
function dayKey(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Os tokens ficam no chaveiro do GNOME, um por conta; no GSettings vai só a
// lista de contas (tipo, nome e servidor). A tela de configurações usa este
// mesmo esquema para gravar. O nome do esquema é o de quando a extensão se
// chamava primodock: o chaveiro guarda esse nome junto de cada token, então
// trocá-lo faria os tokens já gravados deixarem de ser encontrados.
export const TOKEN_SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.primodock.token', Secret.SchemaFlags.NONE,
    {account: Secret.SchemaAttributeType.STRING});

export function parseAccounts(json) {
    try {
        const list = JSON.parse(json);
        return Array.isArray(list)
            ? list.filter(a => a?.id && ['github', 'gitlab'].includes(a.type)) : [];
    } catch {
        return [];
    }
}

export function ago(time) {
    const minutes = Math.floor((Date.now() - time) / 60000);
    if (minutes < 1)
        return 'agora';
    if (minutes < 60)
        return `há ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `há ${hours} h` : `há ${Math.floor(hours / 24)} d`;
}

function baseUrl(host, fallback) {
    host = (host || fallback).trim().replace(/\/+$/, '');
    return /^https?:\/\//.test(host) ? host : `https://${host}`;
}

// `transient`: falha que pode passar sozinha, e vale tentar de novo logo.
class AccountError extends Error {
    constructor(message, transient = false) {
        super(message);
        this.transient = transient;
    }
}

// Pull requests e merge requests de várias contas do GitHub e do GitLab:
// os que esperam a sua revisão e os seus que estão abertos, mais o último
// pipeline seu em cada projeto recente (fica vermelho e avisa quando um
// falha). Na forma grande, mostra também o mapa de atividade das contas
// somadas.
export const GitWidget = registerClass(
class GitWidget extends Widget {
    setup() {
        this._session = new Soup.Session({timeout: 20, user_agent: 'gprdock'});
        this._icon = new Gio.FileIcon({file: Gio.File.new_for_path(
            GLib.build_filenamev([this._dock.path, 'icons', 'git-symbolic.svg']))});
        this._results = [];
        this._activityByAccount = new Map();    // conta -> {dia: contribuições}
        this._activity = new Map();             // dia -> contribuições, contas do perfil
        this._eventSync = new Map();            // conta -> até onde os eventos foram contados
        this._heatmap = null;

        this._loadActivity();

        this.createPanel({wide: true});
        this._show();
        this._retries = 0;                      // novas tentativas já feitas depois de uma falha
        this._settings.connectObject('changed::git-accounts', () => {
            this._refetch();
            this._fetchActivity();
        }, this);
        this._refetch();
        this._fetchActivity();
        this.every(REFRESH_SECONDS, () => this._refetch());
        this.every(ACTIVITY_REFRESH_SECONDS, () => this._fetchActivity());
    }

    build(size) {
        const tile = super.build(size);
        this._heatmap = null;
        if (size !== 'large')
            return tile;

        const height = this._dock.tileSize - 14;
        const cell = height / 7;
        this._heatmap = this.trackGauge(new Heatmap({y_align: Clutter.ActorAlign.CENTER}));
        this._heatmap.style =
            `height: ${height}px; width: ${Math.round(cell * ACTIVITY_WEEKS)}px;`;

        const box = new St.BoxLayout({style_class: 'gprdock-git-large'});
        tile.x_expand = false;
        box.add_child(tile);
        box.add_child(this._heatmap);
        return box;
    }

    refresh() {
        super.refresh();
        if (this._heatmap)
            this._heatmap.weeks = this._weeks();
    }

    // Nome no menu do dock, quando o widget é de uma conta só.
    get title() {
        if (!this.widgetParam)
            return null;
        const account = parseAccounts(this._settings.get_string('git-accounts'))
            .find(a => a.id === this.widgetParam);
        return `Git: ${account?.name || account?.host || 'conta removida'}`;
    }

    // Abre os pedidos de revisão da primeira conta deste widget.
    onMiddleClick() {
        const account = parseAccounts(this._settings.get_string('git-accounts'))
            .find(a => this._inProfile(a.id));
        if (!account)
            return false;
        return this.openUri(account.type === 'github'
            ? `${baseUrl(account.host, 'github.com')}/pulls`
            : `${baseUrl(account.host, 'gitlab.com')}/dashboard/merge_requests`);
    }

    // O widget 'git@<conta>' mostra só aquela conta. O widget geral mostra as
    // que o perfil escolheu; sem escolha, todas.
    _inProfile(accountId) {
        if (this.widgetParam)
            return accountId === this.widgetParam;
        const chosen = this._dock.profiles.current.gitAccounts;
        return !Array.isArray(chosen) || chosen.length === 0 || chosen.includes(accountId);
    }

    // O dock avisa quando o perfil em uso muda.
    onProfileChanged() {
        this._show();
    }

    // As últimas semanas, de domingo a sábado, terminando em hoje.
    _weeks() {
        const today = new Date();
        const start = new Date(today.getFullYear(), today.getMonth(),
            today.getDate() - today.getDay() - 7 * (ACTIVITY_WEEKS - 1));
        const weeks = [];
        for (let day = start; day <= today; day = new Date(day.getTime() + DAY_MS)) {
            if (day.getDay() === 0)
                weeks.push([]);
            weeks.at(-1).push(this._activity.get(dayKey(day)) ?? 0);
        }
        return weeks;
    }

    _token(account) {
        return new Promise((resolve, reject) => {
            Secret.password_lookup(TOKEN_SCHEMA, {account: account.id}, this.cancellable,
                (_source, result) => {
                    try {
                        resolve(Secret.password_lookup_finish(result));
                    } catch (e) {
                        reject(isCancelled(e) ? e
                            : new AccountError('chaveiro do GNOME indisponível'));
                    }
                });
        });
    }

    async _json(url, headers) {
        let response = null;
        try {
            response = await httpGet(this._session, url, headers, this.cancellable);
        } catch (e) {
            throw isCancelled(e) ? e : new AccountError('sem conexão com o servidor', true);
        }
        if (response.status === 401 || response.status === 403)
            throw new AccountError('token recusado');
        if (response.status !== 200) {
            throw new AccountError(`erro HTTP ${response.status}`,
                response.status === 429 || response.status >= 500);
        }
        return [JSON.parse(response.text), response.headers];
    }

    async _github(account, token) {
        const host = baseUrl(account.host, 'github.com');
        const api = /\/\/(www\.)?github\.com$/.test(host)
            ? 'https://api.github.com' : `${host}/api/v3`;
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
        };
        // 'url' é a página do site com a lista inteira.
        const search = async (query, url) => {
            const [data] = await this._json(`${api}/search/issues?per_page=${LISTED}` +
                `&q=${encodeURIComponent(`is:pr is:open ${query}`)}`, headers);
            // A busca não traz a branch de destino: ela vem do PR, um a um.
            // Sem ela (consulta que falhou), o PR aparece do mesmo jeito.
            const items = [];
            for (const i of data.items ?? []) {
                let target = null;
                try {
                    if (i.pull_request?.url)
                        target = (await this._json(i.pull_request.url, headers))[0].base?.ref ?? null;
                } catch (e) {
                    if (isCancelled(e))
                        throw e;
                }
                items.push({title: i.title, url: i.html_url, target});
            }
            return {count: data.total_count ?? 0, items, url};
        };
        return {
            review: await search('review-requested:@me', `${host}/pulls/review-requested`),
            mine: await search('author:@me', `${host}/pulls`),
            pipelines: await this._pipelines(account, api, headers),
        };
    }

    // Os pipelines são um extra: se a consulta deles falhar (token sem a
    // permissão, servidor sem CI), os PRs e MRs aparecem do mesmo jeito.
    async _pipelines(account, api, headers) {
        try {
            const pipelines = await fetchPipelines(account, api, headers,
                async (url, h) => (await this._json(url, h))[0], isCancelled);
            announceFailures(account.id, pipelines);
            return pipelines;
        } catch (e) {
            if (isCancelled(e))
                throw e;
            return null;
        }
    }

    async _gitlab(account, token) {
        const host = baseUrl(account.host, 'gitlab.com');
        const api = `${host}/api/v4`;
        const headers = {'PRIVATE-TOKEN': token};
        // 'filter' é o da página do site com a lista inteira.
        const list = async (query, filter) => {
            const [data, responseHeaders] = await this._json(
                `${api}/merge_requests?state=opened&per_page=${LISTED}&${query}`, headers);
            return {
                count: Number(responseHeaders.get_one('x-total') ?? data.length),
                items: data.map(i => ({title: i.title, url: i.web_url, target: i.target_branch})),
                url: `${host}/dashboard/merge_requests?state=opened&${filter}`,
            };
        };
        const [user] = await this._json(`${api}/user`, headers);
        const username = encodeURIComponent(user.username);
        return {
            review: await list(`scope=all&reviewer_id=${user.id}`, `reviewer_username=${username}`),
            mine: await list('scope=created_by_me', `author_username=${username}`),
            pipelines: await this._pipelines(account, api, headers),
        };
    }

    // Contribuições por dia de uma conta: {dia: contagem}.
    async _githubActivity(account, token) {
        const host = baseUrl(account.host, 'github.com');
        const url = /\/\/(www\.)?github\.com$/.test(host)
            ? 'https://api.github.com/graphql' : `${host}/api/graphql`;
        const response = await httpRequest(this._session, 'POST', url,
            {'Authorization': `Bearer ${token}`}, {query: CONTRIBUTIONS_QUERY}, this.cancellable);
        if (response.status !== 200)
            return {};

        const calendar = JSON.parse(response.text)
            .data?.viewer?.contributionsCollection?.contributionCalendar;
        const days = {};
        for (const week of calendar?.weeks ?? []) {
            for (const day of week.contributionDays)
                days[day.date] = day.contributionCount;
        }
        return days;
    }

    // O calendário do perfil já vem somado por dia, com um ano inteiro. Ele
    // não faz parte da API: se o servidor não o entregar, a contagem sai dos
    // eventos da conta, que é mais cara e alcança menos tempo.
    async _gitlabActivity(account, token) {
        const host = baseUrl(account.host, 'gitlab.com');
        const api = `${host}/api/v4`;
        try {
            const [user] = await this._json(`${api}/user`, {'PRIVATE-TOKEN': token});
            const response = await httpGet(this._session,
                `${host}/users/${encodeURIComponent(user.username)}/calendar.json`,
                {'PRIVATE-TOKEN': token}, this.cancellable);
            const calendar = response.status === 200 ? JSON.parse(response.text) : null;
            if (calendar && Object.keys(calendar).length > 0) {
                this._eventSync.delete(account.id);
                return calendar;
            }
        } catch (e) {
            if (isCancelled(e))
                throw e;
        }

        return this._gitlabEventActivity(account, api, token);
    }

    // Contagem a partir dos eventos, em parcelas: uma conta muito ativa tem
    // dezenas de milhares deles no período. O que já foi contado fica
    // guardado (dias de `since` em diante estão completos, até `until`);
    // cada rodada reconta os dias recentes e avança um trecho para trás.
    async _gitlabEventActivity(account, api, token) {
        const shift = (key, n) => dayKey(new Date(new Date(`${key}T12:00:00`).getTime() + n * DAY_MS));
        const today = dayKey(new Date());
        const target = dayKey(new Date(Date.now() - ACTIVITY_WEEKS * 7 * DAY_MS));

        // Eventos depois de `after` e antes de `before` (datas de fora), do
        // mais novo para o mais velho.
        const count = async (after, before) => {
            const counts = {};
            let oldest = null;
            let complete = false;
            for (let page = 1; page <= EVENT_PAGES && !complete; page++) {
                const [events] = await this._json(
                    `${api}/events?per_page=100&page=${page}&sort=desc&after=${after}` +
                    (before ? `&before=${before}` : ''), {'PRIVATE-TOKEN': token});
                for (const event of events) {
                    oldest = dayKey(new Date(event.created_at));
                    counts[oldest] = (counts[oldest] ?? 0) + 1;
                }
                complete = events.length < 100;
            }
            // Não coube tudo: o dia mais velho pode ter vindo pela metade.
            let from = after;
            if (!complete && oldest) {
                delete counts[oldest];
                from = oldest;
            }
            return {counts, since: shift(from, 1), complete};
        };

        let sync = this._eventSync.get(account.id);
        let days = {...this._activityByAccount.get(account.id)};
        if (sync && sync.until < target)
            sync = null;

        if (sync) {
            // Os dias recentes de novo: o último podia estar pela metade.
            const recent = await count(shift(sync.until, -1), null);
            if (recent.complete) {
                for (const key of Object.keys(days)) {
                    if (key >= sync.until)
                        delete days[key];
                }
                Object.assign(days, recent.counts);
            } else {
                // Tempo demais sem consultar: recomeça.
                sync = null;
            }
        }

        if (!sync) {
            const all = await count(shift(target, -1), null);
            days = all.counts;
            sync = {since: all.since, until: today};
        } else {
            sync = {since: sync.since, until: today};
            if (sync.since > target) {
                const older = await count(shift(target, -1), sync.since);
                Object.assign(days, older.counts);
                sync.since = older.since;
            }
        }

        for (const key of Object.keys(days)) {
            if (key < target)
                delete days[key];
        }
        this._eventSync.set(account.id, sync);
        // Ainda falta um trecho: a próxima rodada vem logo.
        this._backfilling ||= sync.since > target;
        return days;
    }

    _loadActivity() {
        try {
            const [, contents] = GLib.file_get_contents(ACTIVITY_CACHE);
            const saved = JSON.parse(new TextDecoder().decode(contents));
            this._activityByAccount = new Map(Object.entries(saved.days ?? {}));
            this._eventSync = new Map(Object.entries(saved.sync ?? {}));
        } catch {
            // Primeira vez, ou arquivo estragado: começa vazio.
        }
    }

    _saveActivity() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(ACTIVITY_CACHE), 0o700);
            GLib.file_set_contents(ACTIVITY_CACHE,
                JSON.stringify({
                    days: Object.fromEntries(this._activityByAccount),
                    sync: Object.fromEntries(this._eventSync),
                }));
        } catch (e) {
            console.warn('gprdock: não foi possível guardar a atividade do Git', e);
        }
    }

    async _fetchActivity() {
        const run = this._activityRun = (this._activityRun ?? 0) + 1;
        const accounts = parseAccounts(this._settings.get_string('git-accounts'));
        const activity = new Map();
        let failed = false;
        this._backfilling = false;
        for (const account of accounts) {
            let days = null;
            try {
                const token = await this._token(account);
                if (!token)
                    continue;
                days = account.type === 'github'
                    ? await this._githubActivity(account, token)
                    : await this._gitlabActivity(account, token);
            } catch (e) {
                if (isCancelled(e))
                    return;
            }
            // Conta fora do ar, ou resposta vazia onde antes havia dados:
            // fica o que já se sabia dela, e a consulta se repete logo.
            const known = this._activityByAccount.get(account.id);
            if (!days || (Object.keys(days).length === 0 && known)) {
                failed = true;
                days = known;
            }
            if (days)
                activity.set(account.id, days);
        }
        if (run !== this._activityRun)
            return;
        this._activityByAccount = activity;
        this._saveActivity();
        this._show();

        if (this._retryId) {
            this.cancelTimer(this._retryId);
            this._retryId = 0;
        }
        if (failed || this._backfilling) {
            this._retryId = this.every(ACTIVITY_RETRY_SECONDS, () => {
                this.cancelTimer(this._retryId);
                this._retryId = 0;
                this._fetchActivity();
            });
        }
    }

    async _fetchAccount(account) {
        const name = account.name || account.host || account.type;
        const {id} = account;
        try {
            const token = await this._token(account);
            if (!token)
                throw new AccountError('sem token: informe um em Configurações');
            const data = account.type === 'github'
                ? await this._github(account, token)
                : await this._gitlab(account, token);
            return {id, name, ...data};
        } catch (e) {
            if (isCancelled(e))
                throw e;
            return {
                id,
                name,
                error: e instanceof AccountError ? e.message : 'resposta inesperada',
                transient: e instanceof AccountError && e.transient,
            };
        }
    }

    // Uma consulta pode demorar (chaveiro, rede) e terminar depois de outra
    // mais nova ter começado; nesse caso o resultado dela é descartado.
    async _fetch() {
        const run = this._fetchRun = (this._fetchRun ?? 0) + 1;
        const accounts = parseAccounts(this._settings.get_string('git-accounts'));
        try {
            const results = await Promise.all(accounts.map(a => this._fetchAccount(a)));
            if (run !== this._fetchRun)
                return;

            // Falha passageira: a consulta se repete logo, e enquanto isso
            // fica na tela o que já se sabia da conta. O erro só aparece se
            // as novas tentativas também falharem.
            const retry = results.some(r => r.transient) && this._retries < RETRY_SECONDS.length;
            this._results = results.map(result => retry && result.transient
                ? this._results.find(known => known.id === result.id && !known.error) ?? result
                : result);
            this._show();

            if (this._fetchRetryId) {
                this.cancelTimer(this._fetchRetryId);
                this._fetchRetryId = 0;
            }
            if (retry) {
                this._fetchRetryId = this.every(RETRY_SECONDS[this._retries++], () => {
                    this.cancelTimer(this._fetchRetryId);
                    this._fetchRetryId = 0;
                    this._fetch();
                });
            }
        } catch {
            // Cancelado ao destruir o widget.
        }
    }

    // Consulta de novo agora, com direito a todas as novas tentativas.
    _refetch() {
        this._retries = 0;
        this._fetch();
    }

    _show() {
        const results = this._results.filter(r => this._inProfile(r.id));
        const ok = results.filter(r => !r.error);
        const review = ok.reduce((sum, r) => sum + r.review.count, 0);
        const mine = ok.reduce((sum, r) => sum + r.mine.count, 0);
        const failed = results.length - ok.length;
        const pipelines = ok.flatMap(r => r.pipelines ?? []);
        const broken = pipelines.filter(p => p.state === 'failed').length;
        const running = pipelines.filter(p => p.state === 'running').length;
        for (const [name, on] of [['gprdock-state-alert', broken > 0],
            ['gprdock-state-working', broken === 0 && running > 0]]) {
            if (on)
                this.add_style_class_name(name);
            else
                this.remove_style_class_name(name);
        }
        // "2 ✗" (falharam) ou "1 ◐" (rodando), para o texto do tile.
        const ci = broken > 0 ? ` · ${broken} ${PIPELINE_MARKS.failed}`
            : running > 0 ? ` · ${running} ${PIPELINE_MARKS.running}` : '';

        this._activity = new Map();
        for (const [id, days] of this._activityByAccount) {
            if (!this._inProfile(id))
                continue;
            for (const [day, count] of Object.entries(days))
                this._activity.set(day, (this._activity.get(day) ?? 0) + count);
        }

        if (results.length === 0) {
            this.refresh();
            this.display({gicon: this._icon, caption: 'Git', value: 'Sem contas', short: '—'});
            this.setPanelLines([
                ['GitHub e GitLab', 'gprdock-panel-title'],
                ['Adicione uma conta em Configurações › Contas'],
            ]);
            return;
        }

        this.display({
            gicon: this._icon,
            caption: review === 1 ? '1 revisão pendente' : `${review} revisões pendentes`,
            value: `${mine} seus abertos${ci}${failed ? ' · ⚠' : ''}`,
            short: `${review}${broken > 0 ? ` ${PIPELINE_MARKS.failed}` : ''}${failed ? ' ⚠' : ''}`,
        });

        this.refresh();

        const contributions = this._weeks().flat().reduce((sum, n) => sum + n, 0);
        const lines = [[`Atividade: ${contributions} contribuições em ${ACTIVITY_WEEKS} semanas`]];
        for (const result of results) {
            lines.push([result.name, 'gprdock-panel-title']);
            if (result.error) {
                lines.push([`Não consultou: ${result.error}`]);
                lines.push(['Tentar de novo', 'gprdock-panel-text', () => this._refetch()]);
                continue;
            }
            lines.push([`Para você revisar: ${result.review.count} · Seus abertos: ${result.mine.count}`]);
            for (const item of [...result.review.items, ...result.mine.items].slice(0, LISTED))
                lines.push([`${item.title}${item.target ? `\n→ ${item.target}` : ''}`,
                    'gprdock-panel-text', () => this.openUri(item.url)]);
            // A lista não mostra todos: o que ficou de fora abre no site.
            const reviewShown = Math.min(result.review.items.length, LISTED);
            const mineShown = Math.min(result.mine.items.length, LISTED - reviewShown);
            for (const [list, shown, label] of [
                [result.review, reviewShown, 'Ver todos para revisar'],
                [result.mine, mineShown, 'Ver todos os seus']]) {
                if (list.count > shown) {
                    lines.push([`${label} (${list.count}) →`, 'gprdock-panel-text',
                        () => this.openUri(list.url)]);
                }
            }

            if (result.pipelines === null)
                lines.push(['Pipelines: não foi possível consultar']);
            else if (result.pipelines.length > 0)
                lines.push(['Pipelines seus, dos últimos 7 dias']);
            for (const p of result.pipelines ?? []) {
                lines.push([`${PIPELINE_MARKS[p.state]}  ${p.project} · ${p.ref} · ${ago(p.time)}`,
                    'gprdock-panel-text', () => this.openUri(p.url)]);
            }
        }
        this.setPanelLines(lines);
    }

    onDestroy() {
        this._settings.disconnectObject(this);
        this._session.abort();
    }
});
