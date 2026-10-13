# gprdock

Dock flutuante para o GNOME Shell 50 com widgets vivos, inspirado no
[PrimoDock](https://dock.oprimo.dev/) (que só existe para macOS e Windows).

## O que tem

- **Perfis**: cada um com seus apps fixados, widgets, ordem e tema, ligado a
  uma área de trabalho (as janelas do outro perfil saem da frente).
- **Apps e widgets misturados**, na ordem que você quiser; os apps abertos que
  não estão fixados entram numa posição que você escolhe.
- **Apps abertos não fixados** ficam sempre no fim do dock, depois de um
  separador.
- **Arrastar e soltar**: reordena, fixa (inclusive a partir da grade de apps)
  e, soltando fora do dock, desafixa.
- **Galeria de widgets** com preview: clique direito no ícone de apps,
  "Adicionar widgets…".
- **Em todos os monitores** (opcional, Configurações › Ajustes): um dock em
  cada tela, com os mesmos itens; cada janela minimiza para o dock da tela
  em que está.
- **Ocultar automaticamente** (opcional): o dock some e volta quando o cursor
  encosta na borda de baixo.
- **Prévia das janelas**: parar o cursor num app com mais de uma janela mostra
  as miniaturas; clicar numa traz a janela, o X fecha.
- **Contador de notificações** no ícone do app (avisos na lista do GNOME, o
  contador que o app publica e o "(3)" do título de apps web).
- **Troca automática de perfil** numa hora do dia ou ao conectar numa rede, e
  **exportar/importar** os perfis num arquivo (Configurações).
- **Widgets**, cada um em forma quadrada ou retangular (e grande, de 3
  espaços, em música, clima, versículo e Git): prateleira, mascote, Docker, favoritos, atalhos, coleções
  de apps, lembretes, conversor, área de transferência, emoji, conta-gotas,
  capturas de tela, Downloads, música,
  calendário, relógio, clima, bateria, atividade, rede, pomodoro, timer,
  cronômetro, contagem regressiva, progresso do tempo, beber água, nota,
  versículo do dia (NVI), GitHub e GitLab, uso do Claude (um widget por conta:
  cada pasta `~/.claude-*` com login vira um cartão na galeria) e Jarvis.
- **Temas**, um por perfil (Configurações › Perfis): Vidro, Papel, Neon,
  Floating, Nord, Dracula, Poente, Grafite e Menta.
- **Separadores**: clique direito no ícone de apps, "Adicionar separador";
  arraste para o lugar, solte fora do dock para tirar.
- **Tela de configurações**: clique direito no ícone de apps, "Configurações…"
  (ou `gnome-extensions prefs gprdock@gpr`).
- Na visão geral (tecla Super) o dock continua e substitui o dash do GNOME.

## Instalar

### Pelo repositório APT (Ubuntu, com atualização automática)

```bash
curl -fsSL https://gustavoreimche.github.io/gprdock/gprdock.gpg | sudo tee /usr/share/keyrings/gprdock.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/gprdock.gpg] https://gustavoreimche.github.io/gprdock stable main" | sudo tee /etc/apt/sources.list.d/gprdock.list
sudo apt update && sudo apt install gprdock
```

Depois saia e entre na sessão e ative a extensão:

```bash
gnome-extensions enable gprdock@gpr
```

As versões novas chegam com as atualizações do sistema. Para lançar uma,
aumente o número em `packaging/VERSION` e envie para a `main`: o GitHub Actions
monta o `.deb`, publica a release e refaz o repositório APT.

### A partir do código

```bash
./install.sh   # symlink + schema; não muda nada na sessão em uso
./ativar.sh    # desliga o dash-to-panel e liga o dock
```

Depois, saia e entre na sessão: no Wayland o GNOME Shell só carrega extensão
nova no login.

Para voltar ao que era: `./uninstall.sh` (o dash-to-panel volta com as mesmas
configurações).

## Atualizar sem sair da sessão

```bash
./reload.sh
```

Recarrega o código do dock na sessão em uso: o dock pisca e volta com o que
está nesta pasta (código, estilos, chaves novas de configuração, widgets
novos). Serve para tudo, menos para mudanças no `extension.js`, que é só o
carregador; essas ainda pedem sair e entrar na sessão.

Como funciona: o GNOME Shell guarda o código de uma extensão em memória pelo
endereço do arquivo. O `reload.sh` grava uma versão nova nas configurações, e
o `extension.js` importa o resto por um link simbólico com essa versão no
nome (em `~/.cache/gprdock/`), o que faz o shell ler tudo de novo. Cada
recarga deixa a versão anterior do código na memória até o fim da sessão; em
uso normal isso é irrelevante, mas depois de dezenas de recargas vale relogar.

Para acrescentar um widget: crie a classe em `widgets/` (use `registerClass`
de `registerClass.js`, não `GObject.registerClass`), registre-a em `WIDGETS`
no `dock.js` e em `WIDGET_INFO` no `profiles.js`, e rode `./reload.sh`.

## Modo dev

```bash
sudo apt install mutter-dev-bin   # uma vez
./dev.sh
```

Abre um GNOME Shell separado, numa janela, com o dock carregado desta pasta e
configurações próprias em `.dev/`. Nada toca a sessão em uso. Depois de mudar
o código, feche a janela e rode de novo.

## Usar

| Para | Faça |
|---|---|
| Trocar de perfil | Roda do mouse ou dois dedos sobre o dock; arrastar o fundo do dock para o lado; clicar nas bolinhas; ou trocar de área de trabalho |
| Criar perfil | Clique direito no ícone de apps, "Novo perfil" (nasce como cópia do atual) |
| Reordenar | Arraste o ícone ou o widget dentro do dock |
| Fixar | Arraste um app aberto, ou da grade de apps, para o dock |
| Desafixar / esconder widget | Arraste para fora do dock e solte |
| Trocar tema | Configurações › Perfis |
| Tudo o mais | "Configurações…": nome e itens de cada perfil, tamanho, cidade do clima, pomodoro, clique em app com várias janelas |

| Widget | Clique | Clique direito |
|---|---|---|
| Música | Traz a janela do player; botões controlam a faixa | Opções do widget |
| Calendário | Abre o calendário do painel do topo | Opções do widget |
| Clima, bateria, Claude | Abre o painel de detalhes | Opções do widget |
| Atividade | Abre o monitor do sistema | Opções do widget |
| Pomodoro | Inicia / pausa | Zera e volta ao foco |
| Jarvis | Faz ouvir, ou interrompe se estiver ouvindo/falando | Abre o painel web |
| Timer, cronômetro | Inicia / pausa | Zera |
| Beber água | Soma um copo | Tira um copo |
| Versículo, Git, progresso, contagem, nota | Abre o painel de detalhes | Opções do widget |
| Favoritos, coleção, lembretes, conversor | Abre o painel (lembretes e conversor com campo de texto) | Opções do widget |
| Atalhos | Com um atalho só, roda o comando; com vários, abre a lista | Opções do widget |
| Prateleira | Abre a lista do que está guardado: abrir, mostrar na pasta, copiar, tirar | Opções do widget |
| Mascote | Faz festa (no tile ou no próprio bicho, quando passeia) | Opções do widget, bicho e passeio |
| Docker | Abre a lista de contêineres por projeto do Compose; cada um tem iniciar, parar e reiniciar | Opções do widget |
| Claude Code | Abre a lista de sessões do terminal; clicar numa traz o terminal dela | Opções do widget |
| Próxima reunião | Abre os compromissos de hoje e amanhã (agenda das Contas Online do GNOME) | Opções do widget |
| VPN | Abre cada VPN com os detalhes e as ações dela: Netskope (gateway, configuração, quanto falta para o novo login, reiniciar), Tailscale (máquinas da rede, copiar endereço, conectar, desconectar, saída) e as do NetworkManager | Opções do widget |
| Atalhos do sistema | Abre os interruptores: estilo escuro, luz noturna, Wi-Fi, Bluetooth e manter acordado | Opções do widget |
| Armazenamento | Abre o uso de cada disco; clicar num abre a pasta | Opções do widget |
| Relógio mundial | Abre a hora nas cidades escolhidas em Configurações › Ajustes | Opções do widget |
| Gravador de voz | Começa e para a gravação do microfone (fica em Música/Gravações de voz) | Últimas gravações e a pasta |
| Saída de som | Abre a lista de saídas para trocar; clique do meio silencia | Opções do widget |
| Microfone | Liga e desliga o microfone | Opções do widget e escolha da entrada |
| Não perturbe | Liga e desliga as notificações na tela | Opções do widget e "iniciar o pomodoro junto" |
| Portas em uso | Abre a lista de portas com processo seu: abrir no navegador, copiar, encerrar | Opções do widget |

**Clique do meio** num widget abre o programa ou a página a que ele se refere:
Git (pedidos de revisão da conta), versículo
(BibleGateway), Claude (página de uso), Jarvis (painel web), música (o player),
calendário, clima, relógio, atividade, bateria e rede (os apps do GNOME),
Downloads e capturas (a pasta).

Favoritos, atalhos e coleções são criados em Configurações › Conteúdo. Cada
coleção vira um widget próprio, que aparece na galeria depois de criada. Os
lembretes ficam guardados no próprio dock, sem sincronizar com nenhum serviço.

**Prateleira**: arraste arquivos (ou links) de qualquer app até o widget para
deixá-los à mão; ele guarda só o endereço, o arquivo continua onde estava.
Também dá para guardar o que estiver copiado no Arquivos. Para usar, "Copiar"
(ou "Copiar tudo") e cole no destino: o GNOME Shell não consegue iniciar um
arrasto para dentro de um app.

**Mascote**: gato, cachorro, coelho ou passarinho (clique direito no widget), passeando
em cima do dock (sem ocupar lugar nele) ou parado no tile. Segue o cursor com os olhos, dorme depois de um minuto e meio sem
teclado nem mouse, sua quando o processador passa de 85% e faz festa no clique.

Nos widgets em que o clique direito não tem outra função, ele abre as opções
do próprio widget: forma e esconder. O menu do dock (perfis, galeria de
widgets e configurações) fica no clique direito do ícone de apps.

## Widgets personalizados

Dá para criar um widget sem mexer no código do dock: uma pasta em
`~/.config/gprdock/widgets/` com um `manifest.json` e um script (em qualquer
linguagem) que escreve o que mostrar. Em Configurações › Widgets ›
**Widgets personalizados** você cria um a partir de um modelo, exporta para um
arquivo `.gprwidget` e instala o de outra pessoa.

O passo a passo, os campos do manifest e os exemplos estão em
[docs/widgets-personalizados.md](docs/widgets-personalizados.md).

## Contas do GitHub e do GitLab

Em Configurações › Contas, adicione quantas contas quiser (GitHub, GitHub
Enterprise, gitlab.com ou um GitLab próprio). O token de cada conta fica no
chaveiro do GNOME, nunca no GSettings. O widget soma os pull/merge requests
que esperam a sua revisão e os seus que estão abertos; na forma grande mostra
também o mapa de atividade das últimas 26 semanas.

O mesmo widget acompanha os **pipelines**: o último que você disparou em cada
um dos 8 projetos mexidos por último na conta, se for dos últimos 7 dias
(GitLab CI e GitHub Actions). O tile ganha "1 ✗" ou "2 ◐" e fica vermelho
quando algum falha, o painel lista cada um com link, e uma notificação sai na
hora em que um pipeline passa a falhar. No GitHub, o token granular precisa
também de "Actions: read"; sem isso, o resto do widget segue funcionando.

Com duas ou mais contas, cada perfil pode escolher quais o widget mostra
(Configurações › Perfis › "Contas no widget de Git"); sem escolha, mostra
todas somadas.

Para ter um widget separado por conta, lado a lado no mesmo perfil, a galeria
mostra, depois do cartão "GitHub e GitLab", um cartão "Git: <nome da conta>"
para cada conta cadastrada.

## Clique em app aberto

O padrão é o modo inteligente: com várias janelas do app, abre a visão do
Super só com elas, para escolher; com uma só, minimiza se está em foco e
restaura se não está. Os pontos embaixo do ícone mostram quantas janelas o
app tem (até 4). Em Configurações › Ajustes dá para trocar por alternar,
lista de janelas, minimizar, fechar, nova janela ou só focar, separadamente
para o clique e para o clique do meio.

## Apps web (WhatsApp, Teams...)

Um app web instalado pelo navegador só tem uma janela. Fixado em mais de um
perfil, o clique num perfil em que ele não está traz a janela para lá, em vez
de levar você até ela.

Para ter o mesmo app com **sessões separadas** (outro login, outra janela),
clique direito no ícone dele › "Duplicar com sessão isolada". O dock cria um
segundo atalho, "<nome> (<perfil>)", que abre o mesmo endereço com dados de
navegador só dele (em `~/.local/share/gprdock/web/`), e o fixa no perfil em
uso. A cópia começa sem login. "Apagar esta cópia e a sessão dela", no menu
da cópia, remove o atalho e manda os dados para a lixeira.

## Áreas de trabalho

A troca de perfil desliza para o lado junto com a área de trabalho. Para
trocar só o dock, desligue "Trocar a área de trabalho junto" no menu do dock
(clique direito no botão de apps) ou "Um perfil por área de trabalho" em
Configurações › Ajustes.

Com "um perfil por área de trabalho" ligado (padrão), a extensão desliga as
áreas de trabalho dinâmicas do GNOME e fixa a quantidade, porque as dinâmicas
apagam as áreas vazias e os perfis mudariam de número. Os valores anteriores
ficam guardados e voltam quando a extensão é desligada.

## Troca automática de perfil

Em Configurações › Ajustes, cada regra muda o perfil no momento em que a
condição passa a valer: numa hora do dia (opcionalmente só de segunda a
sexta) ou ao conectar numa conexão do NetworkManager, pelo nome dela (o do
Wi-Fi, o da VPN, ou o da interface: `sta0` é o túnel do Netskope). Depois
disso dá para trocar à mão; o dock não insiste.

## Widget do Claude

Lê o token OAuth do Claude Code em `~/.claude/.credentials.json` e consulta
`api.anthropic.com/api/oauth/usage` a cada 5 minutos. O endpoint não é
documentado e pode mudar. O token é usado só no cabeçalho dessa chamada: não
é guardado, logado nem gravado. Se estiver expirado, o widget espera o Claude
Code renová-lo.

## Desenvolver

No Wayland não dá para recarregar extensão na sessão em uso. Para testar, suba
um shell isolado (`gnome-shell --headless --virtual-monitor 1600x900` dentro de
`dbus-run-session`, com `XDG_CONFIG_HOME` e `XDG_DATA_HOME` apontando para uma
pasta temporária) e reinicie-o a cada mudança.

## Licença

GPL-3.0-or-later. Veja [LICENSE](LICENSE).
