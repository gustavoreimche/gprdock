import Soup from 'gi://Soup';

import {Widget, httpGet, isCancelled} from './base.js';
import {registerClass} from '../registerClass.js';

// Versículo do dia do BibleGateway, na Nova Versão Internacional.
const VOTD_URL = 'https://www.biblegateway.com/votd/get/?format=json&version=NVI-PT';
const RETRY_SECONDS = 60;
const REFRESH_SECONDS = 2 * 60 * 60;
const ENTITIES = {
    amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', hellip: '…',
};

// O texto vem em HTML: sai o título da seção, as marcações e as entidades.
function plainText(html) {
    return html
        .replace(/<h\d[^>]*>.*?<\/h\d>/gis, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match)
        .replace(/\s+/g, ' ')
        .trim();
}

export const VerseWidget = registerClass(
class VerseWidget extends Widget {
    onMiddleClick() {
        return this.openUri(this._link || 'https://www.biblegateway.com/versions/Nova-Versao-Internacional-NVI-Biblia/');
    }

    setup() {
        this._session = new Soup.Session({timeout: 15});
        this._day = null;
        this._verse = null;
        this.createPanel();
        this.setPanelLines([['Carregando o versículo do dia…']]);

        this._fetch();
        this.every(REFRESH_SECONDS, () => this._fetch());
    }

    async _fetch() {
        const today = new Date().toDateString();
        if (this._day === today)
            return;

        try {
            const response = await httpGet(this._session, VOTD_URL, null, this.cancellable);
            if (response.status !== 200)
                throw new Error(`HTTP ${response.status}`);
            const {votd} = JSON.parse(response.text);
            const text = plainText(votd.content || votd.text);
            const reference = plainText(votd.display_ref || votd.reference);
            const link = plainText(votd.permalink ?? '');

            this._day = today;
            this._link = link;
            this._verse = {text, reference};
            this.refresh();
            const lines = [
                [`${reference} · NVI`, 'gprdock-panel-title'],
                [text, 'gprdock-panel-text'],
            ];
            if (link)
                lines.push(['Abrir no BibleGateway', null, () => this.openUri(link)]);
            this.setPanelLines(lines);
        } catch (e) {
            if (isCancelled(e))
                return;
            // Mantém o versículo já mostrado; só avisa se ainda não há nenhum.
            if (!this._day)
                this.setPanelLines([['Não foi possível buscar o versículo agora']]);
            this.retryIn(RETRY_SECONDS, () => this._fetch());
        }
    }

    // Na forma grande não há legenda: a referência vai no fim do texto, que
    // assim ganha a altura toda do tile para quebrar em linhas.
    refresh() {
        const verse = this._verse;
        const view = {icon: 'accessories-dictionary-symbolic'};
        if (!verse) {
            Object.assign(view, {caption: 'Versículo do dia', value: '…', short: ''});
        } else if (this.large) {
            view.value = `${verse.text} (${verse.reference}, NVI)`;
        } else {
            Object.assign(view, {
                caption: `${verse.reference} · NVI`,
                value: verse.text,
                short: verse.reference,
            });
        }
        this.display(view);
    }

    onDestroy() {
        this._session.abort();
    }
});
