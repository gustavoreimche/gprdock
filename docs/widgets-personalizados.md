# Widgets personalizados

Um widget personalizado é uma pasta em `~/.config/gprdock/widgets/` com um
`manifest.json`. Ele aparece na galeria (Configurações › Widgets) junto com os
que vêm no dock, entra em qualquer perfil e tem as formas quadrado e retângulo.

Há dois jeitos de fazer um:

| | Script | Módulo |
|---|---|---|
| Para quê | Mostrar um número ou um texto que um comando devolve | Reagir a eventos, desenhar o próprio tile, falar com o GNOME Shell |
| Linguagem | Qualquer uma (bash, Python, Node...) | JavaScript (GJS) |
| Esforço | Um arquivo de poucas linhas | Conhecer a API do dock e do GNOME Shell |

Comece pelo script: resolve quase tudo.

## Em um minuto

1. Abra Configurações › Widgets e desça até **Widgets personalizados**.
2. Em "Criar um widget", digite um nome (por exemplo `Dólar`) e confirme.
   A pasta do widget abre, já com um `manifest.json` e um `widget.sh` que
   funcionam.
3. Na galeria, logo acima, o widget novo aparece. Clique em **Adicionar**.
4. Edite o `widget.sh`. **Ao salvar, o dock recarrega o widget sozinho**: não
   precisa reiniciar nada.

## Widget de script

```
~/.config/gprdock/widgets/dolar/
├── manifest.json
└── widget.sh
```

`manifest.json`:

```json
{
  "format": 1,
  "id": "dolar",
  "name": "Dólar",
  "description": "Cotação do dólar comercial.",
  "author": "Seu nome",
  "icon": "starred-symbolic",
  "color": "#22c55e",
  "size": "wide",
  "script": "widget.sh",
  "interval": 300,
  "middleClick": {"open": "https://www.google.com/finance/quote/USD-BRL"}
}
```

`widget.sh` (precisa ser executável: `chmod +x widget.sh`):

```bash
#!/bin/bash
valor=$(curl -fsS https://economia.awesomeapi.com.br/json/last/USD-BRL | jq -r '.USDBRL.bid')
printf 'R$ %.2f\n' "$valor"      # 1ª linha: o valor em destaque
echo "Dólar comercial"           # 2ª linha: a legenda
echo "Atualizado às $(date +%H:%M)"   # demais linhas: o painel do clique
```

### Campos do manifest

| Campo | Obrigatório | O que é |
|---|---|---|
| `format` | sim | Sempre `1`. |
| `id` | sim | Igual ao nome da pasta. Letras minúsculas, números, `-` e `_`. |
| `name` | não | Nome na galeria e no painel. |
| `description`, `author` | não | Aparecem na galeria e na hora de instalar. |
| `icon` | não | Nome de um ícone do tema (`*-symbolic`). Veja os nomes no app "Icon Library" ou em `/usr/share/icons/Adwaita/symbolic`. |
| `color` | não | Cor do ícone, `#rrggbb`. |
| `size` | não | Forma padrão: `square` ou `wide`. A pessoa pode trocar. |
| `script` | um dos três | Arquivo da pasta que o dock executa. |
| `command` | um dos três | Em vez de um arquivo: uma lista (`["uptime", "-p"]`) ou um texto, que roda no `bash`. |
| `module` | um dos três | Arquivo `.js` (ver "Widget de módulo"). |
| `interval` | não | Segundos entre uma execução e outra. Padrão 60, mínimo 1. |
| `click`, `middleClick` | não | O que o clique faz (ver "Ações"). O padrão do clique é abrir o painel. |
| `wmClasses` | não | Classes de janela de um app que este widget representa: com o widget no perfil, o ícone do app aberto não aparece em dobro. |

O script roda com a pasta do widget como diretório atual e recebe:

| Variável | Valor |
|---|---|
| `GPRDOCK_WIDGET_DIR` | A pasta do widget. |
| `GPRDOCK_WIDGET_ID` | O id. |
| `GPRDOCK_WIDGET_SIZE` | `square`, `wide` ou `large`: a forma em uso. |

Se o script sair com erro, o tile mostra "Erro" e o painel traz a última linha
que ele escreveu na saída de erro.

### Saída em linhas

O jeito simples: a 1ª linha é o valor, a 2ª a legenda e as demais viram linhas
do painel que abre ao clicar.

### Saída em JSON

Para ícone que muda, anel de progresso, estado de alerta e linhas clicáveis,
escreva um objeto JSON:

```json
{
  "value": "72%",
  "short": "72",
  "caption": "Disco /home",
  "icon": "drive-harddisk-symbolic",
  "ring": 0.72,
  "state": "warn",
  "lines": [
    {"text": "Maiores pastas", "title": true},
    "Downloads: 41 GB",
    {"text": "Abrir o analisador de disco", "app": "org.gnome.baobab.desktop"},
    {"text": "Esvaziar a lixeira", "run": ["gio", "trash", "--empty"]}
  ],
  "click": "panel"
}
```

| Campo | O que faz |
|---|---|
| `value` | Texto em destaque. |
| `short` | Versão curta para a forma quadrada (cabem uns 4 caracteres). |
| `caption` | Legenda; só aparece no retângulo. |
| `icon` | Troca o ícone do manifest. |
| `ring` | De 0 a 1: desenha um anel de progresso no lugar do ícone. |
| `ringText` | Texto dentro do anel. |
| `state` | `"warn"` (âmbar) ou `"alert"` (vermelho): o tile muda de cor e pulsa. |
| `lines` | Linhas do painel: textos, ou objetos com `text`, `title` e uma ação. |
| `click` | Troca a ação do clique a partir desta execução. |

### Ações

Valem em `click` e `middleClick` do manifest, no `click` da saída e em cada
linha do painel:

| Ação | Efeito |
|---|---|
| `"panel"` | Abre o painel (o padrão do clique). |
| `{"open": "https://..."}` | Abre um endereço ou arquivo no app padrão. |
| `{"app": "org.gnome.Calculator.desktop"}` | Abre (ou traz para a frente) um app. |
| `{"run": ["comando", "arg"]}` | Roda um comando na pasta do widget e, em seguida, o script de novo. |

Exemplo de botão liga/desliga: `"click": {"run": ["./alternar.sh"]}`, com o
`widget.sh` mostrando o estado atual.

## Widget de módulo

Quando um script a cada tantos segundos não basta, o widget pode ser um módulo
JavaScript que roda dentro do dock, com a mesma API dos widgets que vêm nele.

`manifest.json`:

```json
{
  "format": 1,
  "id": "janelas",
  "name": "Janelas abertas",
  "icon": "focus-windows-symbolic",
  "size": "wide",
  "module": "widget.js"
}
```

`widget.js`:

```js
export default api => class {
    setup() {
        this.createPanel();
        global.display.connectObject('notify::focus-window', () => this.update(), this);
        this.every(10, () => this.update());
        this.update();
    }

    update() {
        const windows = global.display.list_all_windows()
            .filter(w => !w.skip_taskbar);
        this.display({
            icon: 'focus-windows-symbolic',
            value: `${windows.length}`,
            caption: 'Janelas abertas',
        });
        this.setPanelLines([
            ['Janelas abertas', 'gprdock-panel-title'],
            ...windows.map(w => [w.title ?? '', null, () => w.activate(global.get_current_time())]),
        ]);
    }

    onMiddleClick() {
        api.Main.overview.toggle();
        return true;
    }

    onDestroy() {
        global.display.disconnectObject(this);
    }
};
```

O padrão exportado é uma função que recebe `api` e devolve uma classe. As
funções da classe passam a ser as do widget: dentro delas, `this` é o widget.

### Ganchos

| Função | Quando é chamada |
|---|---|
| `setup()` | Uma vez, ao carregar. |
| `onClick()` | Clique. Sem ela, o clique abre o painel. |
| `onMiddleClick()` | Clique do meio. Devolva `true` se fez algo. |
| `onSecondaryClick()` | Clique direito. Sem ela, abre o menu do dock para o widget. |
| `onDestroy()` | Ao remover, recarregar ou desligar o dock. Desfaça aqui o que conectou. |
| `build(size)`, `refresh()` | Só para quem desenha o próprio tile (veja `widgets/base.js`). |
| `get title()` | Nome no menu do clique direito. |

### O que o widget oferece (`this`)

| | |
|---|---|
| `this.display({icon, gicon, value, short, caption, ring, ringText})` | Mostra no tile. Os mesmos campos da saída em JSON. |
| `this.every(segundos, fn)` | Repete `fn`; o timer morre com o widget. Devolve um id para `this.cancelTimer(id)`. |
| `this.createPanel({wide})` | Cria o painel do clique. |
| `this.setPanelLines([[texto, classe, ação], ...])` | Preenche o painel. A classe `gprdock-panel-title` é a de título. |
| `this.launchApp('x.desktop', ...)` | Abre o primeiro app instalado da lista. |
| `this.openUri(endereço)` | Abre no app padrão. |
| `this.add_style_class_name('gprdock-state-warn')` | Estado de atenção (`-warn`) ou alerta (`-alert`). |
| `this.size`, `this.wide` | A forma em uso. |
| `this.cancellable` | Cancelado quando o widget morre: passe-o às suas chamadas assíncronas. |

### O que vem em `api`

| | |
|---|---|
| `api.manifest` | O manifest do widget (use para guardar opções suas). |
| `api.dir` | A pasta do widget. |
| `api.runCommand(argv)` | Roda um comando e devolve a saída (Promise). |
| `api.readFile(caminho)` | Lê um arquivo de texto (Promise). |
| `api.httpGet(sessão, url, cabeçalhos)` | GET com `Soup.Session`; devolve `{status, text, headers}`. |
| `api.isCancelled(erro)` | Verdadeiro se o erro é só o cancelamento do widget. |
| `api.GLib`, `Gio`, `GObject`, `St`, `Clutter`, `Shell`, `Main` | Os módulos do GNOME Shell mais usados. Os outros você importa no topo do arquivo, como em qualquer extensão. |

Regras do módulo:

- Não dê às suas funções e campos nomes que o widget já usa (`display`,
  `every`, `_panel`, `_tile`...). Os repetidos são ignorados, com um aviso no
  log. Prefixar com o nome do widget resolve.
- Salvar o arquivo recarrega o widget na hora. Um erro aparece no tile e no
  log: `journalctl --user -f -o cat /usr/bin/gnome-shell`.
- O módulo roda dentro do GNOME Shell: um laço infinito ou uma chamada
  bloqueante trava a sessão inteira. Use as versões assíncronas.

## Aparência

- `icon` e `color` no manifest cobrem o caso comum.
- `preview.png` (ou `preview-square.png` e `preview-wide.png`) na pasta vira a
  imagem do cartão na galeria. Cerca de 300 × 72 px.
- O widget ganha a classe CSS `gprdock-c-<id>`, além de `gprdock-w-custom`.

## Compartilhar

**Enviar**: em Widgets personalizados, o botão de exportar ao lado do widget
gera um arquivo `<id>.gprwidget` (é um `.tar.gz` da pasta). Mande o arquivo
para quem quiser.

**Receber**: "Instalar de um arquivo…" mostra o nome, o autor e a lista de
arquivos antes de instalar. Depois é só adicionar pela galeria.

Antes de exportar, confira se não ficou nada seu dentro da pasta: senha, token,
endereço interno. Segredos devem ficar fora, num arquivo que o script lê
(`~/.config/...`) ou no chaveiro do sistema (`secret-tool`).

### Segurança

Um widget roda com as suas permissões: um script pode ler e apagar os seus
arquivos, e um módulo roda dentro do GNOME Shell. Trate um `.gprwidget` como
trataria um programa baixado:

- instale só de quem você confia;
- na dúvida, abra antes (`tar -tzf arquivo.gprwidget` lista,
  `tar -xzf` extrai) e leia o script;
- o instalador recusa pacotes com caminhos para fora da pasta, links e
  arquivos especiais, mas não julga o que o código faz.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| O widget não aparece na galeria | Falta o `manifest.json`, ou a pasta não está em `~/.config/gprdock/widgets/`. Feche e abra as Configurações. |
| "Não carrega: ..." no cartão | O texto diz o campo errado do manifest. |
| Tile mostra "Erro" | O script saiu com erro ou não é executável (`chmod +x`). O painel mostra a mensagem. |
| O valor não atualiza | `interval` alto, ou o script demora mais que o intervalo (as execuções não se acumulam). |
| Comando funciona no terminal e não no widget | O widget não carrega o seu `.bashrc`/`.zshrc`: use caminhos completos ou defina as variáveis no próprio script. |
