# LouroChan

Chat flutuante de desktop conectado aos seus cofres do Obsidian. Fica sempre por
cima, você arrasta pela barra de título, minimiza numa bolha e reabre com um
clique ou pelo atalho global.

A IA lê e escreve as notas direto no sistema de arquivos — não precisa de plugin
no Obsidian, e funciona com o Obsidian fechado.

## Rodando

```sh
npm install
npm start
```

Na primeira execução abra as **configurações** (engrenagem) e cole a chave de
API. Sem chave o app abre normalmente e explica o que falta ao enviar a primeira
mensagem.

Funciona em Windows e macOS com o mesmo código. O que muda entre os dois está
em [Windows e macOS](#windows-e-macos).

### Gerando o instalador

```sh
npm run dist:win   # Windows → dist/LouroChan Setup x.y.z.exe
npm run dist:mac   # macOS   → dist/LouroChan-x.y.z.dmg (e .zip)
```

Cada instalador só pode ser gerado no próprio sistema: o `.dmg` precisa ser
feito num Mac, o `.exe` no Windows. Antes de empacotar, `npm run icon` recorta o
pet em `build/icon.png`, que o electron-builder converte em `.icns`/`.ico`.

O pacote do Mac sai **sem assinatura** (não precisa de conta Apple Developer).
Isso é suficiente para usar no próprio Mac que gerou o `.dmg`. Se o arquivo for
copiado para outro Mac, o Gatekeeper reclama de "desenvolvedor não
identificado"; aí é botão direito → Abrir na primeira vez, ou:

```sh
xattr -dr com.apple.quarantine /Applications/LouroChan.app
```

## Chaves de API

| Provider | Onde pegar | Variável de ambiente equivalente |
|---|---|---|
| Claude | <https://console.anthropic.com/settings/keys> | `ANTHROPIC_API_KEY` |
| OpenAI (padrão) | <https://platform.openai.com/api-keys> | `OPENAI_API_KEY` |

### Gateway compatível com a OpenAI

O provider "OpenAI" tem um campo **Endpoint**. Preenchido, o app fala com
qualquer gateway que implemente a API da OpenAI — OmniRouter, LiteLLM, vLLM,
Ollama. Vazio, usa `api.openai.com`.

A configuração atual aponta para o OmniRouter, modelo `floating` (que roteia
para `gpt-5.6-luna-max`). Com endpoint customizado a badge do título mostra o
nome do modelo em vez de "OpenAI", e passar o mouse nela revela o endpoint.

O gateway precisa suportar **function calling com streaming** — é como o agente
busca no cofre. Se as ferramentas não dispararem, é o primeiro lugar a olhar.

A chave colada nas configurações é cifrada pelo cofre do sistema (`safeStorage`:
DPAPI no Windows, Keychain no macOS) e guardada no `config.json` da [pasta de
dados](#windows-e-macos). Se o cofre do sistema não estiver disponível, o app
grava em texto puro **e avisa isso na tela**. Variáveis de ambiente também
funcionam e têm prioridade menor que a chave salva.

Dá para alternar entre Claude e OpenAI a qualquer momento, inclusive no meio de
uma conversa — o histórico é convertido para o formato de cada um.

## Controles

| Ação | Como |
|---|---|
| Abrir | clique no ícone da bandeja, ou `Ctrl+Shift+Espaço` (`⌘⇧Espaço` no Mac) |
| Esconder | o mesmo atalho de novo, ou `Esc` |
| Mover | arraste pela barra de título (ou pela borda da bolha) |
| Minimizar | botão `—`, ou `Esc` |
| Reabrir | clique na bolha |
| Redimensionar | alça no canto inferior direito |
| Enviar | `Enter` (`Shift+Enter` quebra linha) |
| Interromper | o botão de enviar vira "parar" enquanto responde |
| Nova conversa | botão `+` |
| Copiar uma credencial | botão `copiar` no bloco de código, ou clique no código inline |

Tokens e senhas quebram em várias linhas em vez de rolar na horizontal — cabem
inteiros na tela. A quebra é só visual: o que vai para a área de transferência é
o valor original, em uma linha só.


## O pet

A bolha e o ícone do cabeçalho são o Louro Chan, animado a partir de
`src/renderer/pet/` (spritesheet + `pet.json`). Ele reage ao que o app está
fazendo:

| Estado | Animação |
|---|---|
| Parado | em pé, quadro de repouso |
| Respondendo | medita em lótus |
| Sendo arrastado | reverencia para o lado em que está sendo levado |

Os números de grade, quadros e duração vêm do `pet.json`, não do código — trocar
de pet é trocar o conteúdo dessa pasta. O ícone da bandeja é recortado do mesmo
spritesheet em tempo de execução: o quadro é cortado pelo alpha e reduzido com
média de área, senão em 16px sobraria só ruído. Se a pasta sumir, o app cai num
ícone desenhado por código e segue funcionando.

## Se a janela sumir

O app não aparece na barra de tarefas nem no Alt+Tab (é um widget flutuante),
então vale saber onde está a saída:

1. **Ícone na bandeja** — perto do relógio. No Windows 11 ícones novos entram em
   "Mostrar ícones ocultos" (a setinha `^`); arraste-o para fora uma vez e ele
   fica fixo. No Mac o ícone fica na barra de menus, no topo. Clique simples
   abre — nunca esconde; botão direito abre o menu.
2. **`Ctrl+Shift+Espaço`** (`⌘⇧Espaço` no Mac). Se outro programa já usa essa
   combinação, o app tenta alternativas sozinho e mostra a que ficou valendo nas
   configurações. Se nenhuma estiver livre, ele diz isso em vez de deixar você
   apertando à toa.
3. **Rodar `npm start` de novo** — não abre uma segunda instância, traz a
   existente de volta.

Qualquer um dos três reposiciona a janela caso ela esteja fora da tela (por
exemplo, num monitor que foi desconectado). Há também um botão **Trazer para o
centro da tela** nas configurações.

Arrastar é livre, sem prender nas bordas, mas ao soltar o app verifica se sobrou
pelo menos uma faixa alcançável na tela — se não, puxa de volta.

## Cofres

Configurados no `config.json` da pasta de dados, e ajustáveis pela tela de
configurações:

- **Filipe Lourenco**
- **Cofre de Acessos**, marcado como sensível

No Windows os dois ficam em `D:\Obsidian\<nome>`. No macOS o app procura cada
cofre pelo nome, nesta ordem, e usa a primeira pasta que existir:

1. Qualquer cofre já aberto no Obsidian cuja pasta se chame `<nome>` — lido de
   `~/Library/Application Support/obsidian/obsidian.json`, onde o Obsidian
   registra o caminho de todos os cofres
2. `~/Obsidian/<nome>`
3. `~/Documents/Obsidian/<nome>`
4. `~/Documents/<nome>`
5. `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/<nome>` (Obsidian via iCloud)
6. `~/<nome>`

Se o cofre estiver em outro lugar, a barra de cofres mostra "Pasta não
encontrada" e basta corrigir o caminho nas configurações — `~/` funciona.

As notas são indexadas em memória no boot e reindexadas sozinhas quando algo
muda em disco (`fs.watch`). A barra abaixo do título mostra a contagem por
cofre; ponto âmbar = cofre sensível.

### Cofre sensível

O "Cofre de Acessos" guarda senhas, tokens e dados de servidores. Duas coisas
valem saber:

1. **Trechos dele vão para a API da IA** sempre que a busca considerar as notas
   relevantes à pergunta. Isso é inerente a deixá-lo no escopo. Para tirá-lo,
   desmarque "ativo" nas configurações.
2. O prompt do sistema instrui o modelo a dizer *onde* está uma credencial sem
   colar o valor, a menos que você peça explicitamente.

Perguntas sobre credenciais e infraestrutura ocasionalmente encostam nos
classificadores de segurança da Anthropic. Quando isso acontece o app usa o
parâmetro `fallbacks` da API, que re-atende a requisição em outro modelo dentro
da mesma chamada; se ainda assim for recusada, a mensagem de erro explica e
sugere trocar de provider.

## Ferramentas do agente

| Ferramenta | O que faz |
|---|---|
| `search_vault` | busca por palavras-chave com ranking (título pesa mais que corpo) |
| `read_note` | lê uma nota inteira |
| `list_notes` | lista caminhos, opcionalmente filtrando por pasta |
| `write_note` | cria, sobrescreve ou acrescenta — **sempre pede aprovação** |

Toda escrita abre um cartão no chat com o caminho de destino e o conteúdo
completo antes de tocar no disco. Dá para desligar em configurações, mas o
padrão é pedir. Todo caminho vindo do modelo é resolvido e validado contra a
raiz do cofre — nada escapa da pasta.

## Estrutura

```
src/
  main.js            processo principal: janela, bandeja, atalho, IPC
  preload.js         ponte com contextIsolation
  geometry.js        matemática de posição da janela (testada em test/)
  config.js          configurações + chaves cifradas
  vault.js           índice, busca, leitura e escrita nos cofres
  tools.js           definição das ferramentas e prompt do sistema
  agent.js           laço agêntico
  providers/         adaptadores Claude e OpenAI
  renderer/          interface
scripts/
  build-icon.js      gera build/icon.png a partir do pet (roda no Electron)
```

```sh
npm test   # geometria da janela + caminhos do cofre
```

## Windows e macOS

| | Windows | macOS |
|---|---|---|
| Pasta de dados | `%APPDATA%\LouroChan` | `~/Library/Application Support/LouroChan` |
| Cofre das chaves | DPAPI | Keychain (entrada "LouroChan Safe Storage") |
| Ícone | bandeja, perto do relógio | barra de menus, no topo (18px + versão 2x para Retina) |
| Menu do ícone | botão direito | botão direito (o esquerdo sempre abre) |
| Fora da barra de tarefas | `skipTaskbar` | Dock escondido (`app.dock.hide()` + `LSUIElement` no pacote) |
| Atalho padrão | `Ctrl+Shift+Espaço` | `⌘⇧Espaço` |
| Áreas de trabalho | — | a janela segue todos os Spaces e aparece sobre apps em tela cheia |

No Mac, tomar o foco de um app "sem Dock" exige `app.focus({ steal: true })`
antes do `win.focus()` — sem isso o atalho global mostra a janela mas o teclado
continua no app anterior.

A pasta de dados é diferente em cada sistema, então chave, histórico e posição
da janela **não** viajam de um para o outro — cole a chave de novo no Mac.

## Notas

- A janela é transparente, e o Electron não desfoca o desktop atrás dela
  (`backdrop-filter` não tem backdrop para filtrar). Por isso o fundo é quase
  opaco — é o que mantém o texto legível.
- Fechar não encerra o app: ele fica na bandeja. Para sair, use o menu da
  bandeja ou "Sair do LouroChan" nas configurações.
- Ao renomear de "Dulse" para "LouroChan" a pasta de dados mudou junto.
  No primeiro boot o app copia `config.json` e `history.json` da pasta antiga,
  sem sobrescrever nada que já exista no destino.
- O histórico fica em `history.json` na pasta de dados, cortado nas últimas ~60
  entradas sempre num limite de turno, para não quebrar pares de chamada de
  ferramenta.
