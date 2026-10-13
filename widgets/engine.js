import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Widget, isCancelled} from './base.js';
import {registerClass} from '../registerClass.js';

const BUS_NAME = 'dev.gpr.GprEngine';
const OBJECT_PATH = '/dev/gpr/GprEngine';
const GALLERY_APP = 'dev.gpr.GprEngine.Gallery.desktop';
const FALLBACK_ICON = 'preferences-desktop-wallpaper-symbolic';

// Controle do GprEngine (wallpapers vivos): mostra o wallpaper atual e, no
// painel, pausa, troca e abre a galeria. Sem o GprEngine rodando fica neutro.
export const EngineWidget = registerClass(
class EngineWidget extends Widget {
    setup() {
        this.createPanel();
        this._showOffline();

        Gio.DBusProxy.new(Gio.DBus.session,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
            BUS_NAME, OBJECT_PATH, BUS_NAME, this.cancellable,
            (_source, result) => {
                try {
                    this._proxy = Gio.DBusProxy.new_finish(result);
                } catch (e) {
                    if (!isCancelled(e))
                        console.warn(`gprdock: GprEngine indisponível: ${e.message}`);
                    return;
                }
                this._proxy.connectObject(
                    'g-signal', (_proxy, _sender, signal) => {
                        if (signal === 'Changed')
                            this._update();
                    },
                    'notify::g-name-owner', () => this._update(),
                    this);
                this._update();
            });
    }

    _call(method, parameters = null) {
        return new Promise((resolve, reject) => {
            this._proxy.call(method, parameters,
                Gio.DBusCallFlags.NO_AUTO_START, -1, this.cancellable,
                (proxy, result) => {
                    try {
                        resolve(proxy.call_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    // Dispara uma ação; o estado novo chega pelo sinal Changed.
    _do(method, parameters = null) {
        this._call(method, parameters).catch(e => {
            if (!isCancelled(e))
                console.warn(`gprdock: GprEngine.${method}: ${e.message}`);
        });
    }

    _showOffline() {
        this.display({icon: FALLBACK_ICON, value: '—', caption: 'Wallpaper'});
        this.setPanelLines([['GprEngine não está rodando']]);
    }

    async _update() {
        if (!this._proxy?.get_name_owner()) {
            this._showOffline();
            return;
        }

        let stats, list;
        try {
            const [statsJson] = (await this._call('Stats')).deepUnpack();
            const [listJson] = (await this._call('List')).deepUnpack();
            stats = JSON.parse(statsJson);
            list = JSON.parse(listJson);
        } catch (e) {
            // Falha passageira não apaga a última leitura boa.
            if (!isCancelled(e))
                console.warn(`gprdock: GprEngine: ${e.message}`);
            return;
        }

        const current = list.find(pkg => pkg.id === stats.current);
        const manual = stats.reasons.includes('manual');
        const view = {
            value: current?.name ?? 'Nenhum',
            caption: stats.paused ? 'Wallpaper pausado' : 'Wallpaper',
        };
        if (current?.thumbnail)
            view.gicon = Gio.FileIcon.new(Gio.File.new_for_path(current.thumbnail));
        else
            view.icon = FALLBACK_ICON;
        this.display(view);

        this.setPanelLines([
            [current?.name ?? 'Nenhum wallpaper', 'gprdock-panel-title'],
            [manual ? 'Retomar' : 'Pausar', null, () => this._do('SetPaused',
                new GLib.Variant('(bs)', [!manual, 'manual']))],
            ['Próximo', null, () => this._do('Next')],
            ['Anterior', null, () => this._do('Previous')],
            ['Abrir a galeria', null, () => this._openGallery()],
        ]);
    }

    _openGallery() {
        Shell.AppSystem.get_default().lookup_app(GALLERY_APP)?.activate();
    }

    onDestroy() {
        this._proxy?.disconnectObject(this);
        this._proxy = null;
    }
});
