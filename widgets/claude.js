import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {Widget, httpGet, isCancelled, readFile} from './base.js';
import {registerClass} from '../registerClass.js';

const REFRESH_SECONDS = 5 * 60;
const RETRY_SECONDS = 60;
const HIGH_USAGE = 80;
// Endpoint não documentado, o mesmo que o /usage do Claude Code consulta.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

// Erro cuja mensagem pode ir direto para o painel. Os transitórios (rede,
// limite de consultas) não apagam a última leitura boa.
class UsageError extends Error {
    constructor(message, transient = false) {
        super(message);
        this.transient = transient;
    }
}

function formatReset(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return '';
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay ? ` · zera às ${time}` : ` · zera ${WEEKDAYS[date.getDay()]} ${time}`;
}

export const ClaudeWidget = registerClass(
class ClaudeWidget extends Widget {
    onMiddleClick() {
        return this.openUri('https://claude.ai/settings/usage');
    }

    // Nome no menu do dock, quando o widget é de outra conta.
    get title() {
        return this._account ? `Uso do Claude: ${this._account}` : null;
    }

    get _name() {
        return this._account ? `Claude ${this._account}` : 'Claude';
    }

    setup() {
        this.createPanel();

        // 'claude' é a conta padrão (~/.claude); 'claude@<pasta>' é a conta de
        // outra pasta de configuração do Claude Code, como ~/.claude-trabalho.
        const dir = /^\.claude[\w.-]*$/.test(this.widgetParam ?? '') ? this.widgetParam : '.claude';
        this._account = dir === '.claude' ? '' : dir.replace(/^\.claude-?/, '');
        this._credentials = GLib.build_filenamev(
            [GLib.get_home_dir(), dir, '.credentials.json']);
        this._session = new Soup.Session({timeout: 15});
        this._showUnavailable('Consultando o uso…');

        this._fetch();
        this.every(REFRESH_SECONDS, () => this._fetch());
    }

    // O token é lido a cada consulta e vive só nesta função: não é guardado
    // no widget, nem escrito em log ou em disco.
    async _readToken() {
        let oauth = null;
        try {
            oauth = JSON.parse(await readFile(this._credentials, this.cancellable)).claudeAiOauth;
        } catch (e) {
            if (isCancelled(e))
                throw e;
        }
        if (!oauth?.accessToken)
            throw new UsageError('Faça login no Claude Code');
        if (oauth.expiresAt && oauth.expiresAt <= Date.now())
            throw new UsageError('Sessão expirada: abra o Claude Code para renovar');
        return oauth.accessToken;
    }

    async _fetchUsage(token) {
        let response = null;
        try {
            response = await httpGet(this._session, USAGE_URL, {
                'Authorization': `Bearer ${token}`,
                'anthropic-beta': 'oauth-2025-04-20',
            }, this.cancellable);
        } catch (e) {
            throw isCancelled(e) ? e : new UsageError('Sem conexão com a Anthropic', true);
        }

        if (response.status === 401)
            throw new UsageError('Sessão expirada: abra o Claude Code para renovar');
        if (response.status !== 200)
            throw new UsageError(`Uso indisponível agora (HTTP ${response.status})`, true);
        return JSON.parse(response.text);
    }

    async _fetch() {
        try {
            const token = await this._readToken();
            this._show(await this._fetchUsage(token));
        } catch (e) {
            if (isCancelled(e))
                return;
            const message = e instanceof UsageError ? e.message : 'Resposta inesperada';
            if (e.transient && this._lastUsage)
                this._show(this._lastUsage, message);
            else
                this._showUnavailable(message);
            // Rede fora ou sessão renovando: tenta de novo logo.
            this.retryIn(RETRY_SECONDS, () => this._fetch());
        }
    }

    _show(usage, notice = null) {
        this._lastUsage = usage;
        const session = usage.five_hour;
        const week = usage.seven_day;
        const percent = Math.round(session?.utilization ?? 0);
        const weekPercent = Math.round(week?.utilization ?? 0);

        this.display({
            ring: percent / 100,
            ringText: `${percent}%`,
            caption: `${this._name} · 5h`,
            value: `semana ${weekPercent}%`,
        });
        if (percent >= HIGH_USAGE)
            this.add_style_class_name('gprdock-claude-high');
        else
            this.remove_style_class_name('gprdock-claude-high');

        const lines = [[this.title ?? 'Uso do Claude', 'gprdock-panel-title']];
        if (session)
            lines.push([`Sessão (5h): ${percent}%${formatReset(session.resets_at)}`]);
        if (week)
            lines.push([`Semana: ${weekPercent}%${formatReset(week.resets_at)}`]);
        if (notice)
            lines.push([notice]);
        this.setPanelLines(lines);
    }

    _showUnavailable(reason) {
        this._lastUsage = null;
        this.display({ring: 0, ringText: '—', caption: this._name, value: '—'});
        this.remove_style_class_name('gprdock-claude-high');
        this.setPanelLines([
            [this.title ?? 'Uso do Claude', 'gprdock-panel-title'],
            [reason],
        ]);
    }

    onDestroy() {
        this._session.abort();
    }
});
