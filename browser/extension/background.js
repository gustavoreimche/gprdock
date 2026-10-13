// Um link clicado num app web (WhatsApp, Teams...) abre numa aba da janela do
// navegador usada por último, que pode estar em outro perfil do gprdock, e o
// GNOME leva você para lá. Aqui a aba é trazida de volta: vai para a janela
// do navegador que está no perfil de onde o clique partiu ou, se lá não
// houver nenhuma, para uma janela nova.
//
// O navegador não sabe de áreas de trabalho; quem sabe é o dock. A conversa
// com ele passa por um programa auxiliar (browser/gprdock-links-host), que o
// navegador só chama se o browser/install.sh o tiver registrado.

const HOST = 'io.github.gustavoreimche.gprdock';
// ms para a janela que recebeu a aba vir para a frente.
const FOCUS_TIME = 250;
// ms que se espera uma janela ganhar o foco depois de o dock chamá-la.
const RAISE_TIME = 600;
const POLL_TIME = 40;

const ask = message => chrome.runtime.sendNativeMessage(HOST, message);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A janela comum deste usuário do navegador que está em foco, fora `except`;
// null se nenhuma ganhar o foco a tempo.
async function raised(except) {
    for (let waited = 0; waited <= RAISE_TIME; waited += POLL_TIME) {
        const window = await chrome.windows.getLastFocused();
        if (window.focused && window.type === 'normal' && window.id !== except)
            return window;
        await sleep(POLL_TIME);
    }
    return null;
}

async function place(tab) {
    const from = await chrome.windows.get(tab.windowId);
    if (from.type !== 'normal')
        return;
    // O dock diz de que perfil o clique partiu (nenhum, se a aba não veio de
    // um app web), que janelas do navegador há nele e onde a aba caiu.
    let reply = await ask({action: 'query'});
    // A janela que recebeu a aba ainda não veio para a frente: o dock só
    // sabe onde ela está depois disso.
    if (reply?.landed === 'app') {
        await sleep(FOCUS_TIME);
        reply = await ask({action: 'query'});
    }
    if (!reply || reply.origin === null || reply.origin === undefined)
        return;
    // A aba caiu numa janela daquele perfil: já está no lugar.
    if (reply.landed === 'here')
        return;

    // O dock conhece as janelas daquele perfil, mas não sabe dizer qual é
    // qual para o navegador (nem de que usuário dele são). Então ele traz
    // uma para a frente, e a que o navegador vir ganhar o foco é ela.
    const away = reply.landed === 'away' ? from.id : null;
    for (const there of reply.windows) {
        await ask({action: 'settle', window: there.id});
        const target = await raised(away);
        if (!target)
            continue;       // janela de outro usuário do navegador
        if (target.id !== from.id) {
            await chrome.tabs.move(tab.id, {windowId: target.id, index: -1});
            await chrome.tabs.update(tab.id, {active: true});
        }
        return;
    }

    // Nenhuma janela deste usuário do navegador naquele perfil: o dock volta
    // para ele, e a janela nova nasce lá.
    await ask({action: 'settle', window: 0});
    await chrome.windows.create({tabId: tab.id, focused: true});
}

chrome.tabs.onCreated.addListener(tab => {
    place(tab).catch(error => console.warn('gprdock:', error?.message ?? error));
});
