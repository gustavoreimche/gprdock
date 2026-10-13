# PrimoDock GNOME: desenho

Data: 2026-10-12

## Objetivo

Ter no Ubuntu (GNOME Shell 50, Wayland) um dock no estilo do PrimoDock: barra
flutuante embaixo, com apps fixados e widgets vivos. O painel padrão do GNOME
fica no topo; o dash-to-panel é desativado.

## Decisões

- **Extensão própria, do zero.** No GNOME com Wayland só uma extensão do shell
  consegue se ancorar na tela e reservar espaço. Um fork do Ubuntu Dock traria
  ~600 KB de código alheio para manter; duas extensões separadas nunca
  pareceriam uma peça só.
- **Widgets:** música, calendário, clima, bateria, atividade, pomodoro, Claude.
- **Uso do Claude com percentual real**, pelo endpoint não documentado de uso,
  com o token do Claude Code lido a cada consulta.
- **Três temas:** Vidro (padrão), Papel e Neon. Só mudam cores, borda e sombra.
- **Fora da primeira versão:** ambientes, mascote, preview de janelas,
  auto-ocultar, tela de preferências.

## Arquitetura

| Arquivo | Papel |
|---|---|
| `extension.js` | Liga e desliga o dock |
| `dock.js` | Barra, faixa que reserva espaço, temas, menu de temas |
| `appIcons.js` | Favoritos + apps abertos, reaproveitando o `AppIcon` do shell |
| `widgets/base.js` | Base dos tiles: tamanho, cliques, timers, painel, limpeza |
| `widgets/gauges.js` | Anel e barra desenhados com Cairo, cor vinda do CSS |
| `widgets/*.js` | Um arquivo por widget |
| `stylesheet.css` | Forma comum e um bloco por tema |

O dock flutua, então não encosta na borda e sozinho não geraria área
reservada. Por isso ele fica dentro de uma faixa invisível de borda a borda,
registrada com `affectsStruts`; é ela que empurra as janelas maximizadas.

## Dados dos widgets

| Widget | Fonte | Atualização |
|---|---|---|
| Música | MPRIS no D-Bus de sessão | Sinais |
| Calendário | Relógio do sistema | 30 s |
| Clima | Open-Meteo | 30 min |
| Bateria | UPower `DisplayDevice` | Sinais |
| Atividade | `/proc/stat`, `/proc/meminfo` | 2 s |
| Pomodoro | Timer interno, estado em GSettings | 1 s enquanto roda |
| Claude | `api.anthropic.com/api/oauth/usage` | 5 min |

Regras comuns: toda E/S é assíncrona; falha vira estado neutro no tile e nova
tentativa no ciclo seguinte; erro transitório não apaga a última leitura boa.

## Testes

Feitos num GNOME Shell headless isolado (dconf e dados próprios):

- Área útil: 900 px de tela, 32 do painel, 92 do dock, 776 para janelas; janela
  maximizada termina exatamente onde a faixa do dock começa.
- Tela cheia esconde o dock; sair dela o traz de volta.
- Visão geral esconde o dock sem mudar a área útil.
- App aberto fora dos favoritos aparece com indicador de "rodando".
- Música com player MPRIS falso: faixa, play/pause e saída do player.
- Pomodoro: fim de fase, contagem de ciclos, zerar, sobrevive a desligar e
  ligar a extensão.
- Falhas: credencial ausente, HTTP 429 do endpoint do Claude, coordenada
  inválida no clima.
- Cinco ciclos de ativar/desativar sem erro no log nem ator sobrando.
