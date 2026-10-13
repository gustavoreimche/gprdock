import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

import {Widget, isCancelled, runCommand} from './base.js';
import {registerClass} from '../registerClass.js';

const note = (menu, text) => menu.addMenuItem(
    new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false}));

function title(menu, text) {
    const item = new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false});
    item.label.add_style_class_name('gprdock-panel-title');
    menu.addMenuItem(item);
}

// ---------- VPN ----------

const VPN_REFRESH_SECONDS = 20;
const VPN_PEERS_LISTED = 15;
const NETSKOPE = '/opt/netskope/stagent';
// O acesso às aplicações privadas (NPA) vale por um prazo; perto do fim o
// Netskope pede para entrar de novo. Ele não informa esse prazo por comando:
// o que há é o log, onde cada renovação registra quantos segundos faltam.
const NETSKOPE_NPA_LOGS = ['npadebuglog.log', 'npadebuglog.1.log']
    .map(name => `${NETSKOPE}/logs/${name}`);
const REAUTH_LINE = /^\[[^\]]*?(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)\.\d+ ([+-]\d\d:\d\d)\].*Next re-auth prompt after \[(\d+)\] seconds/;
const REAUTH_REFRESH_MS = 2 * 60 * 1000;
const REAUTH_WARN_MINUTES = 30;
const WARP_STATES = {
    Connected: 'conectado',
    Connecting: 'conectando…',
    Disconnected: 'desconectado',
    Paused: 'em pausa',
    Unregistered: 'sem cadastro',
    RegistrationMissing: 'sem cadastro',
};
const WARP_MODES = {
    'warp': 'WARP',
    'warp+doh': 'WARP com DNS sobre HTTPS',
    'warp+dot': 'WARP com DNS sobre TLS',
    'doh': 'Só DNS sobre HTTPS',
    'dot': 'Só DNS sobre TLS',
    'proxy': 'Proxy local',
    'tunnel_only': 'Só o túnel',
};
const WARP_PROTOCOLS = {masque: 'MASQUE', wireguard: 'WireGuard'};
const TAILSCALE_ADMIN = 'https://login.tailscale.com/admin/machines';
const SYSTEMS = {linux: 'Linux', windows: 'Windows', macOS: 'macOS', iOS: 'iOS', android: 'Android'};
// O conserto de quando o Netskope para de autenticar: reinicia o serviço
// (pede a senha), derruba a janela dele, que costuma ser quem trava, e
// reinicia a bandeja. A janela só volta se estava aberta antes.
const NETSKOPE_RESTART = `
ui=$(pgrep -x stAgentUI >/dev/null && echo 1)
pkexec systemctl restart stagentd || exit 1
pkill -x stAgentUI
systemctl --user restart stagentapp.service
sleep 3
if [ -n "$ui" ] && ! pgrep -x stAgentUI >/dev/null; then
    setsid ${NETSKOPE}/stAgentUI >/dev/null 2>&1 &
fi
exit 0`;

function ago(time) {
    const minutes = Math.floor((Date.now() - time) / 60000);
    if (minutes < 1)
        return 'agora';
    if (minutes < 60)
        return `há ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `há ${hours} h` : `há ${Math.floor(hours / 24)} d`;
}

// "3 h 58 min", "12 min".
function duration(ms) {
    const minutes = Math.max(0, Math.round(ms / 60000));
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// Uma máquina da rede do Tailscale. O nome na rede (o do MagicDNS) diz mais
// que o do aparelho: um iPhone se apresenta como "localhost".
function tailscaleMachine(node) {
    const dns = (node.DNSName ?? '').replace(/\.$/, '');
    const seen = Date.parse(node.LastSeen ?? '');
    return {
        name: dns.split('.')[0] || node.HostName || 'sem nome',
        dns,
        ip: node.TailscaleIPs?.[0] ?? '',
        system: SYSTEMS[node.OS] ?? node.OS ?? '',
        online: Boolean(node.Online),
        seen: seen > 0 ? seen : 0,
        exitNode: Boolean(node.ExitNode),
        canExit: Boolean(node.ExitNodeOption),
    };
}

// As VPNs desta máquina e se estão de pé: Netskope, Cloudflare, Tailscale e as do
// NetworkManager (OpenVPN, WireGuard...). Só aparecem as que existem. No
// painel, cada uma abre com os detalhes e as ações dela; as máquinas da rede
// do Tailscale vêm listadas embaixo.
//
// Cada VPN vira {id, name, up, detail, info: [linhas], ...}; `detail` é o
// resumo de uma linha e `info`, o que aparece ao abrir.
export const VpnWidget = registerClass(
class VpnWidget extends Widget {
    setup() {
        this._links = [];
        this._busy = null;      // id da VPN com um comando em curso
        this._reauth = {at: 0, checked: 0};     // prazo do Netskope e quando foi lido
        this._reauthWarned = 0;
        const panel = this.createPanel();
        // Aberto, o painel não é refeito: fecharia o submenu em uso.
        panel.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._fetch(true);
            else
                this._buildPanel();
        });
        this._fetch();
        this.every(VPN_REFRESH_SECONDS, () => this._fetch());
    }

    // Quando vence o acesso do Netskope (ms), ou 0 se o log não diz.
    async _netskopeReauth(force) {
        if (!force && Date.now() - this._reauth.checked < REAUTH_REFRESH_MS)
            return this._reauth.at;
        let at = 0;
        for (const log of NETSKOPE_NPA_LOGS) {
            try {
                // O grep sai com erro quando não acha nada: é só tentar o
                // log anterior.
                const lines = await runCommand(
                    ['grep', '-a', 'Next re-auth prompt after', log], this.cancellable);
                const match = lines.trim().split('\n').at(-1).match(REAUTH_LINE);
                if (match) {
                    at = Date.parse(`${match[1]}T${match[2]}${match[3]}`) + Number(match[4]) * 1000;
                    break;
                }
            } catch (e) {
                if (isCancelled(e))
                    throw e;
            }
        }
        this._reauth = {at, checked: Date.now()};
        return at;
    }

    async _netskope(force) {
        const nsdiag = `${NETSKOPE}/nsdiag`;
        if (!GLib.file_test(nsdiag, GLib.FileTest.IS_EXECUTABLE))
            return null;
        const link = {id: 'netskope', name: 'Netskope', up: false, info: []};
        try {
            const output = await runCommand([nsdiag, '-f'], this.cancellable);
            const field = name => output.match(new RegExp(`^${name}:: (.*?)\\.?$`, 'm'))?.[1] ?? '';
            link.up = field('Tunnel status') === 'NSTUNNEL_CONNECTED';
            link.detail = link.up ? 'conectado'
                : field('Client status') === 'disable' ? 'cliente desativado' : 'túnel desconectado';
            link.reauthAt = link.up ? await this._netskopeReauth(force) : 0;
            link.info = [
                ['Organização', field('Orgname')],
                ['Gateway', [field('Gateway'), field('Gateway IP')].filter(Boolean).join(' · ')],
                ['Configuração', field('Config')],
                ['Tráfego', field('Traffic Mode')],
                ['Protocolo', field('Tunnel Protocol')],
                ['Cliente', field('Client version')],
            ].filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            link.detail = 'serviço parado';
        }
        return link;
    }

    async _tailscale() {
        if (!GLib.find_program_in_path('tailscale'))
            return null;
        const link = {id: 'tailscale', name: 'Tailscale', up: false, info: [], peers: []};
        try {
            const status = JSON.parse(
                await runCommand(['tailscale', 'status', '--json'], this.cancellable));
            link.up = status.BackendState === 'Running';
            link.needsLogin = status.BackendState === 'NeedsLogin';
            link.authUrl = status.AuthURL ?? '';
            if (!link.up) {
                link.detail = link.needsLogin ? 'fora da conta' : 'desconectado';
                return link;
            }
            link.self = status.Self ? tailscaleMachine(status.Self) : null;
            link.peers = Object.values(status.Peer ?? {}).map(tailscaleMachine)
                .sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
            link.exit = link.peers.find(peer => peer.exitNode) ?? null;
            const online = link.peers.filter(peer => peer.online).length;
            link.detail = `${online} de ${link.peers.length} no ar` +
                (link.exit ? ` · saída por ${link.exit.name}` : '');
            link.info = [
                status.CurrentTailnet?.Name && `Rede: ${status.CurrentTailnet.Name}`,
                ...(status.Health ?? []).map(problem => `⚠ ${problem}`),
            ].filter(Boolean);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            link.detail = 'serviço parado';
        }
        return link;
    }

    // O cliente da Cloudflare (WARP / Zero Trust).
    async _warp() {
        if (!GLib.find_program_in_path('warp-cli'))
            return null;
        const link = {id: 'warp', name: 'Cloudflare', up: false, info: []};
        // --accept-tos: sem ele, a primeira chamada fica esperando um "sim".
        const warp = async (...args) => JSON.parse(await runCommand(
            ['warp-cli', '--accept-tos', '--json', ...args], this.cancellable));
        try {
            const {status, reason} = await warp('status');
            link.up = status === 'Connected';
            link.detail = WARP_STATES[status] ?? status ?? 'desconectado';
            if (link.up && reason && reason !== 'NetworkHealthy')
                link.detail += ' · rede com problema';
        } catch (e) {
            if (isCancelled(e))
                throw e;
            link.detail = 'serviço parado';
            return link;
        }
        // Os detalhes são um extra: sem eles, o estado aparece do mesmo jeito.
        try {
            const {settings} = await warp('settings');
            link.locked = Boolean(settings?.switch_locked);
            link.info = [
                ['Organização', settings?.organization],
                ['Modo', WARP_MODES[settings?.operation_mode] ?? settings?.operation_mode],
                ['Protocolo', WARP_PROTOCOLS[settings?.warp_tunnel_protocol] ?? settings?.warp_tunnel_protocol],
            ].filter(([, value]) => typeof value === 'string' && value)
                .map(([label, value]) => `${label}: ${value}`);
        } catch (e) {
            if (isCancelled(e))
                throw e;
        }
        return link;
    }

    async _networkManager() {
        try {
            const output = await runCommand(
                ['nmcli', '-t', '-f', 'NAME,TYPE,DEVICE', 'connection', 'show', '--active'],
                this.cancellable);
            return output.split('\n')
                .map(line => line.match(/^(.*):(vpn|wireguard):(.*)$/))
                .filter(Boolean)
                .map(([, name, type, device]) => ({
                    id: `nm:${name}`,
                    name,
                    connection: name,
                    up: true,
                    detail: 'conectada',
                    info: [`Tipo: ${type === 'wireguard' ? 'WireGuard' : 'VPN do NetworkManager'}`,
                        device && `Interface: ${device}`].filter(Boolean),
                }));
        } catch (e) {
            if (isCancelled(e))
                throw e;
            return [];
        }
    }

    // `force` relê o prazo do Netskope em vez de usar o da última leitura.
    async _fetch(force = false) {
        try {
            const [netskope, warp, tailscale, others] = await Promise.all([this._netskope(force),
                this._warp(), this._tailscale(), this._networkManager()]);
            this._links = [netskope, warp, tailscale, ...others].filter(Boolean);
        } catch {
            return;     // cancelado ao destruir o widget
        }
        this.refresh();
    }

    // Roda um comando de uma VPN; enquanto dura, ela aparece como ocupada.
    async _run(id, argv, done, failure) {
        if (this._busy)
            return;
        this._busy = id;
        this.refresh();
        try {
            await runCommand(argv, this.cancellable);
            if (done)
                Main.notify('VPN', done);
        } catch (e) {
            if (isCancelled(e))
                return;
            Main.notify('VPN', `${failure}: ${e.message}`);
        }
        this._busy = null;
        this._fetch(true);
    }

    // Quanto falta para o Netskope pedir login de novo: null se não se sabe.
    _reauthLeft() {
        const at = this._links.find(l => l.id === 'netskope')?.reauthAt;
        return at ? at - Date.now() : null;
    }

    _copy(text) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        Main.notify('VPN', `Copiado: ${text}`);
    }

    refresh() {
        const links = this._links;
        const up = links.filter(l => l.up);
        const down = links.filter(l => !l.up);
        const left = this._reauthLeft();
        const expired = left !== null && left <= 0;
        const soon = left !== null && !expired && left <= REAUTH_WARN_MINUTES * 60000;

        this.display({
            icon: up.length > 0 ? 'network-vpn-symbolic' : 'network-vpn-disconnected-symbolic',
            caption: left === null || down.length > 0 ? 'VPN'
                : expired ? 'Netskope: login vencido' : `Netskope: login em ${duration(left)}`,
            value: this._busy ? 'Aguarde…'
                : links.length === 0 ? 'Nenhuma'
                    : down.length === 0 ? up.map(l => l.name).join(' · ')
                        : `${down.map(l => l.name).join(' · ')} fora`,
            short: links.length === 0 ? '—' : down.length > 0 ? 'fora'
                : expired ? 'login' : soon ? duration(left) : 'ok',
        });
        for (const [name, on] of [['gprdock-state-alert', down.length > 0 || expired],
            ['gprdock-state-warn', down.length === 0 && soon]]) {
            if (on)
                this.add_style_class_name(name);
            else
                this.remove_style_class_name(name);
        }
        // Um aviso só por prazo, quando ele entra na reta final.
        const at = links.find(l => l.id === 'netskope')?.reauthAt ?? 0;
        if (soon && this._reauthWarned !== at) {
            this._reauthWarned = at;
            Main.notify('Netskope', `O acesso vence em ${duration(left)}: ele vai pedir login de novo.`);
        }
        if (!this._panel.isOpen)
            this._buildPanel();
    }

    _linkActions(link, menu) {
        if (link.id === 'netskope') {
            menu.addAction('Reiniciar o Netskope', () => this._run(link.id,
                ['sh', '-c', NETSKOPE_RESTART],
                'Netskope reiniciado. O túnel leva alguns segundos para voltar.',
                'O Netskope não foi reiniciado'));
        } else if (link.id === 'warp') {
            // Com o botão travado pela organização, o cliente recusa.
            if (link.locked)
                note(menu, 'Ligar e desligar está travado pela organização');
            else if (link.up)
                menu.addAction('Desconectar', () => this._run(link.id,
                    ['warp-cli', '--accept-tos', 'disconnect'], null, 'Não foi possível desconectar'));
            else
                menu.addAction('Conectar', () => this._run(link.id,
                    ['warp-cli', '--accept-tos', 'connect'], null, 'Não foi possível conectar'));
        } else if (link.id === 'tailscale') {
            const tailscale = (args, failure) =>
                this._run(link.id, ['tailscale', ...args], null, failure);
            if (link.self?.ip) {
                menu.addAction(`Copiar o endereço desta máquina (${link.self.ip})`,
                    () => this._copy(link.self.ip));
            }
            if (link.exit) {
                menu.addAction(`Parar de sair por ${link.exit.name}`,
                    () => tailscale(['set', '--exit-node='], 'Não foi possível tirar a saída'));
            }
            if (link.up) {
                menu.addAction('Desconectar', () => tailscale(['down'], 'Não foi possível desconectar'));
            } else if (link.needsLogin && link.authUrl) {
                menu.addAction('Entrar na conta…', () => this.openUri(link.authUrl));
            } else {
                menu.addAction('Conectar', () => tailscale(['up'], 'Não foi possível conectar'));
            }
            menu.addAction('Abrir o painel de máquinas', () => this.openUri(TAILSCALE_ADMIN));
        } else if (link.connection) {
            menu.addAction('Desconectar', () => this._run(link.id,
                ['nmcli', 'connection', 'down', link.connection], null,
                'Não foi possível desconectar'));
        }
    }

    _buildPanel() {
        const panel = this._panel;
        panel.removeAll();
        title(panel, 'VPN');
        if (this._links.length === 0)
            note(panel, 'Nenhuma VPN encontrada nesta máquina');

        for (const link of this._links) {
            const item = new PopupMenu.PopupSubMenuMenuItem(
                `${link.up ? '●' : '○'}  ${link.name} · ` +
                `${this._busy === link.id ? 'aguarde…' : link.detail}` +
                (link.reauthAt ? ` · login em ${duration(link.reauthAt - Date.now())}` : ''));
            if (link.reauthAt) {
                const left = link.reauthAt - Date.now();
                const hour = new Date(link.reauthAt).toLocaleTimeString('pt-BR',
                    {hour: '2-digit', minute: '2-digit'});
                note(item.menu, left > 0
                    ? `Novo login em ${duration(left)}, às ${hour}`
                    : `Login vencido às ${hour}: o Netskope deve pedir para entrar`);
            }
            link.info.forEach(line => note(item.menu, line));
            this._linkActions(link, item.menu);
            panel.addMenuItem(item);
        }

        const tailscale = this._links.find(l => l.id === 'tailscale');
        if (!tailscale?.up || tailscale.peers.length === 0)
            return;
        panel.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Máquinas do Tailscale'));
        for (const peer of tailscale.peers.slice(0, VPN_PEERS_LISTED)) {
            const item = new PopupMenu.PopupSubMenuMenuItem(
                `${peer.online ? '●' : '○'}  ${peer.name}${peer.exitNode ? ' · saída' : ''}`);
            note(item.menu, [peer.system, peer.ip,
                peer.online ? 'no ar' : peer.seen ? `vista ${ago(peer.seen)}` : 'fora do ar']
                .filter(Boolean).join(' · '));
            if (peer.ip)
                item.menu.addAction('Copiar o endereço', () => this._copy(peer.ip));
            if (peer.dns)
                item.menu.addAction('Copiar o nome', () => this._copy(peer.dns));
            if (peer.canExit && peer.online && !peer.exitNode) {
                item.menu.addAction('Sair para a internet por ela', () => this._run('tailscale',
                    ['tailscale', 'set', `--exit-node=${peer.ip}`], null,
                    'Não foi possível usar a saída'));
            }
            panel.addMenuItem(item);
        }
        if (tailscale.peers.length > VPN_PEERS_LISTED)
            note(panel, `… e mais ${tailscale.peers.length - VPN_PEERS_LISTED}`);
    }
});

// ---------- Som ----------

function streamName(stream) {
    const port = stream.get_port()?.human_port;
    const name = stream.get_description() || stream.get_name() || 'Dispositivo';
    return port && !name.includes(port) ? `${name} · ${port}` : name;
}

// Segue um fluxo de áudio (a saída ou a entrada padrão) e avisa quando o
// volume ou o mudo dele mudam.
class StreamWatch {
    constructor(onChange) {
        this._onChange = onChange;
        this._stream = null;
    }

    get stream() {
        return this._stream;
    }

    set(stream) {
        if (stream === this._stream)
            return;
        this._stream?.disconnectObject(this);
        this._stream = stream;
        stream?.connectObject(
            'notify::volume', () => this._onChange(),
            'notify::is-muted', () => this._onChange(),
            'notify::port', () => this._onChange(), this);
        this._onChange();
    }

    destroy() {
        this._stream?.disconnectObject(this);
        this._stream = null;
    }
}

// Por onde o som sai: o painel troca entre caixa, fone, HDMI e Bluetooth.
// Clique do meio silencia.
export const AudioWidget = registerClass(
class AudioWidget extends Widget {
    setup() {
        this._control = Volume.getMixerControl();
        this._watch = new StreamWatch(() => this.refresh());
        this.createPanel();
        this._control.connectObject(
            'state-changed', () => this._sync(),
            'default-sink-changed', () => this._sync(),
            'stream-added', () => this.refresh(),
            'stream-removed', () => this.refresh(), this);
        this._sync();
    }

    _sync() {
        this._watch.set(this._control.get_default_sink());
    }

    onMiddleClick() {
        const stream = this._watch.stream;
        stream?.change_is_muted(!stream.is_muted);
        return Boolean(stream);
    }

    refresh() {
        const stream = this._watch.stream;
        const level = stream ? stream.volume / this._control.get_vol_max_norm() : 0;
        const muted = !stream || stream.is_muted || level === 0;
        const percent = Math.round(level * 100);

        this.display({
            icon: muted ? 'audio-volume-muted-symbolic'
                : level < 0.34 ? 'audio-volume-low-symbolic'
                    : level < 0.67 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic',
            caption: !stream ? 'Som' : stream.is_muted ? 'Som · mudo' : `Som · ${percent}%`,
            value: stream ? streamName(stream) : 'Sem saída',
            short: !stream ? '—' : stream.is_muted ? 'mudo' : `${percent}%`,
        });

        const panel = this._panel;
        if (!panel)
            return;
        panel.removeAll();
        title(panel, 'Saída de som');
        const sinks = this._control.get_sinks();
        if (sinks.length === 0)
            note(panel, 'Nenhuma saída de som');
        for (const sink of sinks) {
            const item = new PopupMenu.PopupMenuItem(streamName(sink));
            item.setOrnament(sink === stream ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            item.connect('activate', () => this._control.set_default_sink(sink));
            panel.addMenuItem(item);
        }
        if (stream) {
            panel.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            panel.addAction(stream.is_muted ? 'Ligar o som' : 'Silenciar',
                () => stream.change_is_muted(!stream.is_muted));
        }
    }

    onDestroy() {
        this._control.disconnectObject(this);
        this._watch.destroy();
    }
});

// O microfone: um clique liga e desliga. A entrada em uso se escolhe pelo
// clique direito.
export const MicWidget = registerClass(
class MicWidget extends Widget {
    setup() {
        this._control = Volume.getMixerControl();
        this._watch = new StreamWatch(() => this.refresh());
        this._control.connectObject(
            'state-changed', () => this._sync(),
            'default-source-changed', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        this._watch.set(this._control.get_default_source());
    }

    onClick() {
        const stream = this._watch.stream;
        stream?.change_is_muted(!stream.is_muted);
    }

    refresh() {
        const stream = this._watch.stream;
        const muted = !stream || stream.is_muted;
        this.display({
            icon: muted ? 'microphone-sensitivity-muted-symbolic' : 'audio-input-microphone-symbolic',
            caption: 'Microfone',
            value: !stream ? 'Sem microfone' : muted ? 'Mudo' : 'Ligado',
            short: !stream ? '—' : muted ? 'mudo' : 'on',
        });
        if (stream && !muted)
            this.add_style_class_name('gprdock-state-live');
        else
            this.remove_style_class_name('gprdock-state-live');
    }

    buildMenu(menu) {
        const sources = this._control.get_sources();
        if (sources.length === 0)
            return;
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Entrada'));
        for (const source of sources) {
            const item = new PopupMenu.PopupMenuItem(streamName(source));
            item.setOrnament(source === this._watch.stream
                ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            item.connect('activate', () => this._control.set_default_source(source));
            menu.addMenuItem(item);
        }
    }

    onDestroy() {
        this._control.disconnectObject(this);
        this._watch.destroy();
    }
});

// ---------- Não perturbe ----------

// Um clique silencia os avisos na tela (o "Não perturbe" do GNOME). Pode
// começar o pomodoro junto: ligado, cada foco é um ciclo.
export const FocusWidget = registerClass(
class FocusWidget extends Widget {
    setup() {
        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._notifications.connectObject('changed::show-banners', () => this.refresh(), this);
    }

    get _on() {
        return !this._notifications.get_boolean('show-banners');
    }

    onClick() {
        const on = !this._on;
        this._notifications.set_boolean('show-banners', !on);
        if (on && this._settings.get_boolean('focus-pomodoro'))
            this._startPomodoro();
    }

    // O pomodoro guarda o estado dele nas configurações e segue o que estiver
    // lá: funciona mesmo que o widget dele não esteja neste perfil.
    _startPomodoro() {
        let state = null;
        try {
            state = JSON.parse(this._settings.get_string('pomodoro-state'));
        } catch {
            // Nunca usado: começa um foco do zero.
        }
        if (state?.running)
            return;
        const seconds = this._settings.get_int('pomodoro-focus-minutes') * 60;
        if (state?.phase !== 'focus') {
            state = {
                phase: 'focus',
                remaining: seconds,
                cycles: state?.cycles ?? 0,
                day: state?.day ?? new Date().toLocaleDateString('sv-SE'),
            };
        }
        state.running = true;
        state.endsAt = Math.floor(Date.now() / 1000) + (state.remaining || seconds);
        this._settings.set_string('pomodoro-state', JSON.stringify(state));
    }

    refresh() {
        const on = this._on;
        this.display({
            icon: on ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic',
            caption: 'Não perturbe',
            value: on ? 'Ligado' : 'Desligado',
            short: on ? 'on' : 'off',
        });
        if (on)
            this.add_style_class_name('gprdock-state-warn');
        else
            this.remove_style_class_name('gprdock-state-warn');
    }

    buildMenu(menu) {
        const pomodoro = new PopupMenu.PopupSwitchMenuItem('Iniciar o pomodoro junto',
            this._settings.get_boolean('focus-pomodoro'));
        pomodoro.connect('toggled', (_item, state) =>
            this._settings.set_boolean('focus-pomodoro', state));
        menu.addMenuItem(pomodoro);
    }

    onDestroy() {
        this._notifications.disconnectObject(this);
    }
});

// ---------- Portas em uso ----------

const PORTS_REFRESH_SECONDS = 15;
const PORTS_LISTED = 20;

function processInfo(pid) {
    let command = '';
    let folder = '';
    try {
        const [, contents] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
        command = new TextDecoder().decode(contents).replaceAll('\0', ' ').trim();
    } catch {
        // O processo acabou de sair.
    }
    try {
        folder = GLib.file_read_link(`/proc/${pid}/cwd`);
    } catch {
        // Idem, ou é de outro usuário.
    }
    return {command, folder};
}

// Os seus processos que estão ouvindo em alguma porta TCP (servidores de
// desenvolvimento e afins), com abrir no navegador e encerrar.
export const PortsWidget = registerClass(
class PortsWidget extends Widget {
    setup() {
        this._ports = [];
        this._error = null;
        const panel = this.createPanel();
        // Aberto, o painel não é refeito: fecharia o submenu em uso.
        panel.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._fetch();
            else
                this._buildPanel();
        });
        this._fetch();
        this.every(PORTS_REFRESH_SECONDS, () => this._fetch());
    }

    async _fetch() {
        try {
            const output = await runCommand(['ss', '-ltnpH'], this.cancellable);
            const seen = new Map();
            for (const line of output.split('\n')) {
                // Só aparecem com processo as portas de quem é deste usuário.
                const owner = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
                const local = line.trim().split(/\s+/)[3] ?? '';
                const port = Number(local.slice(local.lastIndexOf(':') + 1));
                if (!owner || !port)
                    continue;
                const host = local.slice(0, local.lastIndexOf(':'));
                const key = `${port}/${owner[2]}`;
                const entry = seen.get(key) ?? {port, name: owner[1], pid: Number(owner[2]), local: true};
                // Ouvindo só em 127.0.0.1 ou ::1, a porta não sai da máquina.
                entry.local &&= /^(127\.|\[::1\])/.test(host);
                seen.set(key, entry);
            }
            this._ports = [...seen.values()].sort((a, b) => a.port - b.port);
            this._error = null;
        } catch (e) {
            if (isCancelled(e))
                return;
            this._ports = [];
            this._error = e.message;
        }
        this.refresh();
    }

    refresh() {
        const ports = this._ports;
        this.display({
            icon: 'network-server-symbolic',
            caption: ports.length === 1 ? '1 porta em uso' : `${ports.length} portas em uso`,
            value: this._error ? 'Indisponível'
                : ports.length === 0 ? 'Nenhuma'
                    : ports.slice(0, 3).map(p => p.port).join(' · ') + (ports.length > 3 ? ' …' : ''),
            short: this._error ? '—' : `${ports.length}`,
        });
        if (!this._panel.isOpen)
            this._buildPanel();
    }

    _buildPanel() {
        const panel = this._panel;
        panel.removeAll();
        title(panel, 'Portas em uso');
        if (this._error) {
            note(panel, `Não foi possível consultar: ${this._error}`);
            return;
        }
        if (this._ports.length === 0) {
            note(panel, 'Nenhum processo seu está ouvindo em uma porta');
            return;
        }

        for (const entry of this._ports.slice(0, PORTS_LISTED)) {
            const item = new PopupMenu.PopupSubMenuMenuItem(
                `${entry.port}  ·  ${entry.name}${entry.local ? '' : '  ·  na rede'}`);
            item.menu.connect('open-state-changed', (_menu, open) => {
                if (!open || item._filled)
                    return;
                item._filled = true;
                const {command, folder} = processInfo(entry.pid);
                const short = command.length > 70 ? `${command.slice(0, 70)}…` : command;
                const about = new PopupMenu.PopupMenuItem(
                    [short, folder && `em ${folder.replace(GLib.get_home_dir(), '~')}`]
                        .filter(Boolean).join('\n') || `processo ${entry.pid}`,
                    {reactive: false, can_focus: false});
                item.menu.addMenuItem(about, 0);
            });
            item.menu.addAction('Abrir no navegador',
                () => this.openUri(`http://localhost:${entry.port}`));
            item.menu.addAction('Copiar o endereço', () => St.Clipboard.get_default()
                .set_text(St.ClipboardType.CLIPBOARD, `http://localhost:${entry.port}`));
            item.menu.addAction(`Encerrar ${entry.name}`, () => this._kill(entry));
            panel.addMenuItem(item);
        }
        if (this._ports.length > PORTS_LISTED)
            note(panel, `… e mais ${this._ports.length - PORTS_LISTED}`);
    }

    async _kill(entry) {
        try {
            await runCommand(['kill', `${entry.pid}`], this.cancellable);
        } catch (e) {
            if (!isCancelled(e))
                Main.notify('Portas', `Não foi possível encerrar ${entry.name}: ${e.message}`);
        }
        this._fetch();
    }
});
