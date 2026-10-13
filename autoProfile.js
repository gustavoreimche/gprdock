import GLib from 'gi://GLib';
import NM from 'gi://NM';

const CHECK_SECONDS = 20;

// Regras gravadas em 'auto-profile-rules':
//   {id, type: 'time', value: 'HH:MM', weekdays, profile}   naquela hora
//   {id, type: 'network', value: '<conexão>', profile}      ao conectar nela
// `profile` é o id do perfil. A conexão é o nome que o NetworkManager dá: o
// do Wi-Fi, o da VPN, ou o da interface (sta0 é o túnel do Netskope).
export function parseRules(json) {
    try {
        const list = JSON.parse(json);
        return Array.isArray(list) ? list.filter(rule => rule?.profile &&
            ['time', 'network'].includes(rule.type) && typeof rule.value === 'string') : [];
    } catch {
        return [];
    }
}

// Troca de perfil sozinho, pela hora ou pela rede. Cada regra vale no momento
// em que a condição passa a ser verdadeira: depois disso você pode trocar à
// mão e o dock não insiste.
export class AutoProfile {
    constructor(settings, profiles) {
        this._settings = settings;
        this._profiles = profiles;
        this._lastCheck = new Date();
        this._active = null;    // conexões ativas na última vez que olhou
        this._client = null;
        this._destroyed = false;

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CHECK_SECONDS, () => {
            this._checkTime();
            return GLib.SOURCE_CONTINUE;
        });

        NM.Client.new_async(null, (_source, result) => {
            try {
                const client = NM.Client.new_finish(result);
                if (this._destroyed)
                    return;
                this._client = client;
                this._active = this._connections();
                client.connectObject('notify::active-connections',
                    () => this._checkNetwork(), this);
            } catch (e) {
                console.warn('gprdock: sem o NetworkManager, as regras de rede não valem', e);
            }
        });
    }

    get _rules() {
        return parseRules(this._settings.get_string('auto-profile-rules'));
    }

    _switch(rule) {
        const index = this._profiles.list.findIndex(p => p.id === rule.profile);
        if (index >= 0)
            this._profiles.switchTo(index);
    }

    // Vale a regra cuja hora ficou entre a última olhada e agora. Depois de
    // suspender, só as do último intervalo contam: nada de trocar por causa
    // de uma hora que passou com a máquina dormindo.
    _checkTime() {
        const now = new Date();
        const since = this._lastCheck;
        this._lastCheck = now;
        if (now - since > 3 * CHECK_SECONDS * 1000)
            return;

        for (const rule of this._rules.filter(r => r.type === 'time')) {
            const match = rule.value.match(/^(\d{1,2}):(\d{2})$/);
            if (!match)
                continue;
            const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
                Number(match[1]), Number(match[2]));
            const weekend = now.getDay() === 0 || now.getDay() === 6;
            if (at > since && at <= now && !(rule.weekdays && weekend))
                this._switch(rule);
        }
    }

    _connections() {
        return new Set(this._client.get_active_connections()
            .filter(c => c.get_state() === NM.ActiveConnectionState.ACTIVATED ||
                c.get_state() === NM.ActiveConnectionState.ACTIVATING)
            .map(c => c.get_id()));
    }

    _checkNetwork() {
        const active = this._connections();
        const before = this._active ?? active;
        this._active = active;
        for (const rule of this._rules.filter(r => r.type === 'network')) {
            const name = rule.value.trim();
            if (active.has(name) && !before.has(name))
                this._switch(rule);
        }
    }

    destroy() {
        this._destroyed = true;
        GLib.source_remove(this._timerId);
        this._client?.disconnectObject(this);
        this._client = null;
    }
}
