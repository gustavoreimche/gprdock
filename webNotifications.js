import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Navegadores que mandam as notificações dos sites (e dos PWAs) em nome
// próprio: o desktop-entry vem sempre o do navegador.
const BROWSERS = /^(google-chrome|chromium|brave-browser|microsoft-edge)/;
// Os PWAs que o Chrome instala: chrome-<id do app>-<perfil>.desktop.
const PWA = /^chrome-[a-p]{32}-/;
// Partes do endereço que não dizem qual é o app.
const GENERIC = new Set(['www', 'web', 'app', 'apps', 'cloud', 'microsoft', 'office',
    'live', 'google', 'mail']);

// Separa por app as notificações que os sites mandam pelo navegador.
//
// O Chrome manda tudo como "Google Chrome", com o site na primeira linha do
// texto. E o GNOME escolhe o app pelo processo de quem mandou, que é o
// mesmo para o navegador e para todos os PWAs: cada aviso caía num deles
// meio ao acaso, misturando WhatsApp, Teams e o Chrome. Aqui o aviso vai
// para o PWA do site, quando há um instalado, e para o navegador quando não.
//
// E para não formar fila: mensagem nova da mesma conversa (mesmo título)
// substitui a anterior, e cada app deixa na fila só o banner mais recente.
export class WebNotifications {
    constructor() {
        const daemon = Main.notificationDaemon?._fdoNotificationDaemon;
        if (!daemon?.NotifyAsync || !daemon._getApp) {
            console.warn('gprdock: o GNOME mudou; as notificações dos sites ficam como estão');
            return;
        }
        this._daemon = daemon;

        // O app escolhido para o aviso que está sendo tratado agora.
        let chosen = null;
        const getApp = daemon._getApp;
        daemon._getApp = function (...args) {
            return chosen ?? getApp.apply(this, args);
        };

        const notify = daemon.NotifyAsync;
        daemon.NotifyAsync = (params, invocation) => {
            const route = this._route(params);
            if (!route)
                return notify.call(daemon, params, invocation);

            chosen = route.app;
            if (route.replaces)
                params = [params[0], route.replaces, ...params.slice(2)];
            try {
                return notify.call(daemon, params, invocation);
            } finally {
                chosen = null;
                this._trimQueue(route.app);
            }
        };
    }

    // {app, replaces} para um aviso que veio do navegador; null para os outros.
    _route(params) {
        const [, replacesId, , summary, body, , hints] = params;
        const entry = hints['desktop-entry']?.deepUnpack?.();
        if (replacesId !== 0 || typeof entry !== 'string' || !BROWSERS.test(entry))
            return null;

        const appSystem = Shell.AppSystem.get_default();
        const host = body.match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?\n/i)?.[1];
        const app = (host && this._pwaFor(host)) ?? appSystem.lookup_app(`${entry}.desktop`);
        if (!app)
            return null;

        let replaces = 0;
        for (const [id, notification] of this._daemon._notifications) {
            if (notification.source?.app === app && notification.title === summary)
                replaces = id;
        }
        return {app, replaces};
    }

    // O PWA instalado cujo nome tem uma parte do endereço: web.whatsapp.com
    // é o "WhatsApp Web", teams.cloud.microsoft é o "Microsoft Teams". Entre
    // dois do mesmo site, vale o que está aberto.
    _pwaFor(host) {
        const parts = host.toLowerCase().split('.').slice(0, -1)
            .filter(part => part.length >= 4 && !GENERIC.has(part));
        if (parts.length === 0)
            return null;

        const appSystem = Shell.AppSystem.get_default();
        const apps = appSystem.get_installed()
            .filter(info => PWA.test(info.get_id() ?? ''))
            .filter(info => parts.some(part => info.get_name().toLowerCase().includes(part)))
            .map(info => appSystem.lookup_app(info.get_id()))
            .filter(Boolean);
        return apps.find(app => app.get_state() === Shell.AppState.RUNNING) ?? apps[0] ?? null;
    }

    // Deixa na fila de banners só o aviso mais novo deste app; os outros
    // continuam na lista de notificações.
    _trimQueue(app) {
        const tray = Main.messageTray;
        const queue = tray._notificationQueue;
        if (!Array.isArray(queue))
            return;
        const mine = queue.filter(n => n.source?.app === app);
        if (mine.length < 2)
            return;
        tray._notificationQueue = queue.filter(n => n.source?.app !== app || n === mine.at(-1));
        tray.emit('queue-changed');
    }

    destroy() {
        if (!this._daemon)
            return;
        // Os originais estão no protótipo: basta tirar os desta instância.
        delete this._daemon.NotifyAsync;
        delete this._daemon._getApp;
        this._daemon = null;
    }
}
