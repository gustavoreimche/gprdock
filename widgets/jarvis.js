import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {Widget} from './base.js';
import {registerClass} from '../registerClass.js';

const RECONNECT_SECONDS = 5;
const MAX_LINE = 80;

// [rótulo, ícone]; o estado também vira classe CSS (gprdock-jarvis-<estado>).
const STATES = {
    offline: ['Desligado', 'microphone-disabled-symbolic'],
    loading: ['Iniciando', 'content-loading-symbolic'],
    idle: ['Pronto', 'audio-input-microphone-symbolic'],
    listening: ['Ouvindo', 'audio-input-microphone-symbolic'],
    thinking: ['Pensando', 'content-loading-symbolic'],
    speaking: ['Falando', 'audio-speakers-symbolic'],
    working: ['Trabalhando', 'system-run-symbolic'],
    muted: ['Mudo', 'microphone-sensitivity-muted-symbolic'],
};
const BUSY = new Set(['listening', 'thinking', 'speaking']);

// Estado ao vivo do Jarvis (assistente de voz local), pelo WebSocket dele.
// Clique: começa a ouvir, ou interrompe se ele estiver ouvindo/pensando/
// falando. Clique direito: abre o painel web.
export const JarvisWidget = registerClass(
class JarvisWidget extends Widget {
    onMiddleClick() {
        return this.openUri(this._url);
    }

    setup() {
        this._session = new Soup.Session();
        this._socket = null;
        this._retryId = 0;
        this._state = null;
        this._detail = '';
        this._line = '';
        this._setState('offline');

        this._settings.connectObject('changed::jarvis-url', () => this._reconnect(), this);
        this._connect();
    }

    get _url() {
        return this._settings.get_string('jarvis-url').replace(/\/+$/, '');
    }

    _connect() {
        let message = null;
        try {
            message = Soup.Message.new('GET', `${this._url.replace(/^http/, 'ws')}/ws`);
        } catch {
            // Endereço inválido: fica desligado até ser corrigido.
        }
        if (!message)
            return;

        this._session.websocket_connect_async(message, null, [],
            GLib.PRIORITY_DEFAULT, this.cancellable, (session, result) => {
                try {
                    this._socket = session.websocket_connect_finish(result);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        this._scheduleRetry();
                    return;
                }

                this._socket.connectObject(
                    'message', (_socket, type, bytes) => {
                        if (type === Soup.WebsocketDataType.TEXT)
                            this._onMessage(bytes);
                    },
                    'closed', () => {
                        this._socket = null;
                        this._scheduleRetry();
                    }, this);
            });
    }

    _scheduleRetry() {
        this._setState('offline');
        if (this._retryId)
            return;
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            RECONNECT_SECONDS, () => {
                this._retryId = 0;
                this._connect();
                return GLib.SOURCE_REMOVE;
            });
    }

    _closeSocket() {
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
        if (this._socket) {
            this._socket.disconnectObject(this);
            if (this._socket.get_state() === Soup.WebsocketState.OPEN)
                this._socket.close(Soup.WebsocketCloseCode.NORMAL, null);
            this._socket = null;
        }
    }

    _reconnect() {
        this._closeSocket();
        this._connect();
    }

    _onMessage(bytes) {
        let event = null;
        try {
            event = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        } catch {
            return;
        }

        switch (event.type) {
        case 'hello':
            this._setState(event.status?.state, event.status?.state_detail);
            break;
        case 'state':
            this._setState(event.state, event.detail);
            break;
        case 'transcript':
            this._setLine(`Você: ${event.text ?? ''}`);
            break;
        case 'reply':
            this._setLine(event.text ?? '');
            break;
        }
    }

    _setState(state, detail = '') {
        if (!STATES[state])
            state = 'offline';
        if (this._state)
            this.remove_style_class_name(`gprdock-jarvis-${this._state}`);
        this._state = state;
        this._detail = detail ?? '';
        this.add_style_class_name(`gprdock-jarvis-${state}`);
        this.refresh();
    }

    _setLine(text) {
        text = text.replace(/\s+/g, ' ').trim();
        this._line = text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text;
        this.refresh();
    }

    refresh() {
        const [label, icon] = STATES[this._state];
        const state = this._state === 'working' && this._detail ? this._detail : label;
        // Com uma fala para mostrar, o estado sobe para a linha menor.
        this.display({
            icon,
            short: label,
            caption: this._line ? state : 'Jarvis',
            value: this._line || state,
        });
    }

    onClick() {
        if (this._state === 'offline')
            return;
        // Mesmo comando do painel do Jarvis: ouvir, ou interromper.
        this._socket?.send_text(JSON.stringify(
            {type: BUSY.has(this._state) ? 'cancel' : 'listen'}));
    }

    onSecondaryClick() {
        this.openUri(this._url);
    }

    onDestroy() {
        this._settings.disconnectObject(this);
        this._closeSocket();
        this._session.abort();
    }
});
