'use strict';
const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  shell,
  screen,
  clipboard,
} = require('electron');

const config = require('./config');
const geometry = require('./geometry');
const { VaultSet } = require('./vault');
const agent = require('./agent');
const { appIcon } = require('./icon');

const BUBBLE = { width: 64, height: 69 }; // proporção do quadro do pet (192x208)
const MIN_EXPANDED = { width: 320, height: 360 };
const IS_MAC = process.platform === 'darwin';

let win = null;
let tray = null;
let vaultSet = null;
let collapsed = false;
let history = [];
let currentRun = null;
const pendingConfirms = new Map();

// ---------------------------------------------------------------- persistência

// Nomes que o app já teve, do mais recente para o mais antigo.
const LEGACY_APP_NAMES = ['Assistenlouro', 'dulse'];

/**
 * O Electron deriva a pasta de dados do nome do app, então cada renomeação
 * moveria tudo de lugar e a chave de API, o endpoint e o histórico sumiriam sem
 * aviso. Traz os dados da instalação anterior.
 *
 * Copia de UMA pasta só, nunca misturando: no Windows o safeStorage não usa a
 * DPAPI diretamente — ele cifra com uma chave aleatória guardada no 'Local
 * State' da própria pasta de dados. Um config.json de uma origem com o 'Local
 * State' de outra deixa o segredo ilegível.
 */
function migrateLegacyUserData() {
  const target = app.getPath('userData');
  // Já tem dados próprios: nada a fazer, e mexer aqui seria destrutivo.
  if (fs.existsSync(path.join(target, 'config.json'))) return;

  const parent = path.dirname(target);
  const source = LEGACY_APP_NAMES.map((name) => path.join(parent, name)).find(
    (dir) => dir !== target && fs.existsSync(path.join(dir, 'config.json'))
  );
  if (!source) return;

  for (const name of ['Local State', 'config.json', 'history.json']) {
    const from = path.join(source, name);
    const to = path.join(target, name);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.copyFileSync(from, to);
    } catch {
      /* migração é conveniência: se falhar, o app abre com os padrões */
    }
  }
}

// Executa no carregamento do módulo, antes de `whenReady`: o Chromium escreve
// o próprio 'Local State' cedo no arranque, e a partir daí a cópia seria
// descartada — a chave de API viajaria sem o segredo que a abre.
migrateLegacyUserData();

const historyFile = () => path.join(app.getPath('userData'), 'history.json');

function loadHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    if (Array.isArray(raw)) history = raw;
  } catch {
    history = [];
  }
}

/**
 * Corta o histórico mantendo ~`keep` entradas, sempre num limite de turno do
 * usuário. Cortar em qualquer ponto deixaria um `tool_result` sem o `tool_use`
 * correspondente, e a API rejeita esse par quebrado.
 */
function trimAtUserBoundary(list, keep) {
  if (list.length <= keep) return list;
  for (let i = list.length - keep; i < list.length; i++) {
    if (list[i].role === 'user') return list.slice(i);
  }
  return list.slice(-keep);
}

function saveHistory() {
  try {
    fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
    fs.writeFileSync(historyFile(), JSON.stringify(trimAtUserBoundary(history, 60)), 'utf8');
  } catch {
    /* histórico é conveniência, não bloqueia o app */
  }
}

/** Mensagens visíveis no chat (sem os pares de tool call). */
const visibleHistory = () =>
  history
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => ({ role: m.role, content: m.content }));

// ---------------------------------------------------------------------- janela

const clampToDisplay = (bounds) => geometry.clampTo(bounds, screen.getDisplayMatching(bounds).workArea);

function persistBounds() {
  if (!win || win.isDestroyed()) return;
  // O gesto terminou (roda 400ms depois do último movimento): se a janela foi
  // parar fora do alcance, puxa de volta antes de gravar essa posição.
  ensureOnScreen();
  const b = win.getBounds();
  if (!collapsed) {
    config.save({ window: { x: b.x, y: b.y, width: b.width, height: b.height } });
    return;
  }
  // Arrastou a bolha: guarda onde a janela expandida vai reaparecer, para o
  // próximo boot abrir onde ele deixou — e não na posição antiga.
  const saved = config.load().window || {};
  config.save({ window: geometry.expandedBounds(b, saved, BUBBLE, MIN_EXPANDED) });
}

// Arrastar e redimensionar chegam na taxa do mouse, e config.save grava em
// disco de forma síncrona. Sem esperar o gesto terminar, seriam dezenas de
// escritas por segundo.
let persistTimer = null;
function persistBoundsSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistBounds, 400);
}

function createWindow() {
  const cfg = config.load();
  const saved = cfg.window || {};
  const width = saved.width || 400;
  const height = saved.height || 580;

  let position = {};
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    position = clampToDisplay({ x: saved.x, y: saved.y, width, height });
  } else {
    const area = screen.getPrimaryDisplay().workArea;
    position = { x: area.x + area.width - width - 32, y: area.y + area.height - height - 32 };
  }

  win = new BrowserWindow({
    width,
    height,
    x: position.x,
    y: position.y,
    minWidth: BUBBLE.width,
    minHeight: BUBBLE.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    icon: nativeImage.createFromBuffer(appIcon(64)),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  // No macOS cada Space (área de trabalho) tem as próprias janelas. Um widget
  // que fica preso no Space onde nasceu some ao trocar de área — e some de vez
  // quando outro app entra em tela cheia. Isto o faz acompanhar o usuário.
  if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('moved', persistBoundsSoon);
  win.on('resized', persistBoundsSoon);

  // Links externos abrem no navegador, nunca dentro da janela.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });
}

function setCollapsed(next) {
  if (!win || win.isDestroyed()) return;
  if (next === collapsed) return;

  const bounds = win.getBounds();

  // `collapsed` precisa mudar ANTES do setBounds: o próprio setBounds dispara
  // 'moved'/'resized', e com a flag antiga o handler persistiria o tamanho da
  // bolha como se fosse o tamanho da janela expandida.
  collapsed = next;

  if (next) {
    config.save({ window: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } });
    win.setBounds(clampToDisplay(geometry.collapsedBounds(bounds, BUBBLE)));
  } else {
    const saved = config.load().window || {};
    win.setBounds(clampToDisplay(geometry.expandedBounds(bounds, saved, BUBBLE, MIN_EXPANDED)));
  }

  win.webContents.send('win:state', { collapsed });
}

const workAreas = () => screen.getAllDisplays().map((d) => d.workArea);

/** Traz a janela de volta se ela ficou fora do alcance do mouse. */
function ensureOnScreen() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  if (geometry.isReachable(bounds, workAreas())) return;
  win.setBounds(clampToDisplay(bounds));
}

/**
 * Caminho único de "aparecer". Tudo que devolve a janela ao usuário passa por
 * aqui — bandeja, atalho global e segunda instância — porque cada um deles é
 * usado justamente quando ela sumiu. Nunca recolhe: quem chama quer ver.
 */
function revealWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  setCollapsed(false);
  ensureOnScreen();
  if (!win.isVisible()) win.show();
  // Reafirma: outro app em tela cheia pode ter derrubado o always-on-top.
  win.setAlwaysOnTop(true, 'floating');
  // Sem ícone no Dock o app é "de fundo" para o macOS, e `win.focus()` sozinho
  // não toma o teclado de quem está na frente. Pedir o foco do app resolve.
  if (IS_MAC) app.focus({ steal: true });
  win.focus();
  win.webContents.send('ui:focus-input');
}

function centerWindow() {
  if (!win || win.isDestroyed()) return;
  win.setBounds(geometry.centerIn(win.getBounds(), screen.getPrimaryDisplay().workArea));
  revealWindow();
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  // Só recolhe quando está visível, alcançável e em foco — ou seja, quando o
  // usuário claramente está olhando para ela e quer escondê-la.
  const visible = win.isVisible() && win.isFocused() && geometry.isReachable(win.getBounds(), workAreas());
  if (!collapsed && visible) setCollapsed(true);
  else revealWindow();
}

// ------------------------------------------------------------------------ tray

/**
 * Ícone da bandeja (Windows) / barra de menus (macOS). A barra do macOS é
 * desenhada em 2x nas telas Retina, então entrega as duas escalas: sem a
 * representação @2x o sistema esticaria o 1x e o pet viraria um borrão.
 */
function trayImage() {
  const base = IS_MAC ? 18 : 16;
  const image = nativeImage.createEmpty();
  image.addRepresentation({ scaleFactor: 1, width: base, height: base, buffer: appIcon(base) });
  image.addRepresentation({ scaleFactor: 2, width: base * 2, height: base * 2, buffer: appIcon(base * 2) });
  return image;
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('LouroChan — clique para abrir o chat');
  const menu = Menu.buildFromTemplate([
    { label: 'Abrir', click: revealWindow },
    { label: 'Trazer para o centro da tela', click: centerWindow },
    { label: 'Ocultar', click: () => setCollapsed(true) },
    { type: 'separator' },
    { label: 'Nova conversa', click: () => { history = []; saveHistory(); revealWindow(); win?.webContents.send('chat:reset'); } },
    { label: 'Reindexar cofres', click: async () => { await vaultSet.reindexAll(); pushVaults(); } },
    { label: 'Abrir pasta de dados', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]);

  // Clique simples sempre abre. Alternar aqui seria a pior escolha possível:
  // a bandeja é o recurso de quem já não acha a janela.
  //
  // No macOS, um ícone com menu de contexto fixo abre o menu em QUALQUER
  // clique e nunca emite 'click'. Por isso lá o menu só é anexado ao botão
  // direito, e o esquerdo continua sendo "abrir".
  if (IS_MAC) {
    tray.on('right-click', () => tray.popUpContextMenu(menu));
  } else {
    tray.setContextMenu(menu);
  }
  tray.on('click', revealWindow);
  tray.on('double-click', revealWindow);
}

function pushVaults() {
  win?.webContents.send('vault:state', vaultSet.summary());
}

// --------------------------------------------------------------- atalho global

let activeHotkey = null;

/**
 * `globalShortcut.register` devolve false quando outro app já tomou a
 * combinação — e falhar em silêncio aqui significa o usuário apertando o
 * atalho sem entender por que nada acontece. Tenta alternativas e guarda qual
 * ficou valendo, para a tela de configurações mostrar a verdade.
 */
function registerHotkey() {
  const preferred = config.load().hotkey;
  const candidates = [preferred, 'CommandOrControl+Shift+Space', 'CommandOrControl+Alt+Space', 'CommandOrControl+Shift+J']
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);

  globalShortcut.unregisterAll();
  for (const combo of candidates) {
    try {
      if (globalShortcut.register(combo, toggleWindow)) {
        activeHotkey = combo;
        if (combo !== preferred) config.save({ hotkey: combo });
        return;
      }
    } catch {
      /* combinação inválida ou ocupada — tenta a próxima */
    }
  }
  activeHotkey = null;
}

// ------------------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('app:bootstrap', () => ({
    config: config.publicConfig(),
    vaults: vaultSet.summary(),
    messages: visibleHistory(),
    collapsed,
    hotkeyActive: activeHotkey,
    platform: process.platform,
    userDataPath: app.getPath('userData'),
  }));

  ipcMain.handle('win:center', centerWindow);

  ipcMain.handle('config:update', (_e, patch) => {
    config.save(patch);
    return config.publicConfig();
  });

  ipcMain.handle('config:set-key', (_e, { provider, key }) => {
    config.setApiKey(provider, key);
    return config.publicConfig();
  });

  ipcMain.handle('config:set-vaults', async (_e, vaults) => {
    config.save({ vaults });
    vaultSet.closeAll();
    vaultSet = new VaultSet(config.load().vaults);
    await vaultSet.reindexAll();
    vaultSet.watchAll(pushVaults);
    pushVaults();
    return vaultSet.summary();
  });

  ipcMain.handle('vault:reindex', async () => {
    await vaultSet.reindexAll();
    pushVaults();
    return vaultSet.summary();
  });

  ipcMain.handle('vault:reveal', (_e, { vault, notePath }) => {
    try {
      const v = vaultSet.get(vault);
      shell.showItemInFolder(v.resolve(notePath));
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.on('chat:confirm-response', (_e, { id, approved }) => {
    pendingConfirms.get(id)?.(approved);
    pendingConfirms.delete(id);
  });

  // Via Electron em vez de navigator.clipboard: a página roda em file://, que
  // nem sempre conta como contexto seguro para a Clipboard API.
  ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text ?? '')));

  ipcMain.on('chat:stop', () => currentRun?.abort());

  ipcMain.on('chat:reset', () => {
    currentRun?.abort();
    history = [];
    saveHistory();
  });

  ipcMain.handle('win:collapse', () => setCollapsed(true));
  ipcMain.handle('win:expand', () => {
    setCollapsed(false);
    win?.focus();
  });
  ipcMain.handle('win:hide', () => win?.hide());
  ipcMain.handle('win:quit', () => app.quit());
  ipcMain.handle('win:get-bounds', () => win?.getBounds());
  ipcMain.handle('win:set-position', (_e, { x, y }) => {
    if (!win || win.isDestroyed()) return;
    // Sem clamp: durante o arraste, prender a janela brigaria com o mouse.
    win.setPosition(Math.round(x), Math.round(y));
    // 'moved' não é emitido para movimento programático no Windows, então a
    // posição precisa ser registrada aqui.
    persistBoundsSoon();
  });
  ipcMain.handle('win:set-size', (_e, { width, height }) => {
    if (!win || win.isDestroyed() || collapsed) return;
    const b = win.getBounds();
    win.setBounds({
      x: b.x,
      y: b.y,
      width: Math.max(Math.round(width), MIN_EXPANDED.width),
      height: Math.max(Math.round(height), MIN_EXPANDED.height),
    });
    persistBoundsSoon();
  });

  ipcMain.handle('chat:send', async (event, text) => {
    const send = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('chat:event', payload);
    };

    const cfg = config.load();
    const apiKey = config.getApiKey(cfg.provider);
    if (!apiKey) {
      send({
        type: 'error',
        message:
          cfg.provider === 'anthropic'
            ? 'Falta a chave da Anthropic. Abra as configurações (engrenagem) e cole a sua ANTHROPIC_API_KEY.'
            : 'Falta a chave da OpenAI. Abra as configurações (engrenagem) e cole a sua OPENAI_API_KEY.',
      });
      return;
    }

    const controller = new AbortController();
    currentRun = controller;
    history.push({ role: 'user', content: text });
    // Sem isto o contexto cresce indefinidamente numa sessão longa.
    history = trimAtUserBoundary(history, 60);

    try {
      await agent.run({
        history,
        config: cfg,
        apiKey,
        vaultSet,
        signal: controller.signal,
        onEvent: send,
        confirmWrite: (payload) =>
          new Promise((resolve) => {
            const id = `cfm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            pendingConfirms.set(id, resolve);
            send({ type: 'confirm', id, ...payload });
            controller.signal.addEventListener('abort', () => {
              if (pendingConfirms.delete(id)) resolve(false);
            });
          }),
      });
    } catch (err) {
      if (err?.name === 'AbortError' || controller.signal.aborted) {
        send({ type: 'stopped' });
      } else {
        send({ type: 'error', message: String(err?.message || err) });
      }
    } finally {
      currentRun = null;
      saveHistory();
      pushVaults();
    }
  });
}

// ------------------------------------------------------------------ ciclo de vida

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Rodar `npm start` de novo vira um resgate: em vez de abrir uma segunda
  // instância, traz de volta a que se perdeu.
  app.on('second-instance', revealWindow);

  // No macOS, clicar no ícone do app (Dock ou Launchpad) emite 'activate'.
  // O Dock fica escondido, mas o Launchpad e o Spotlight continuam chegando
  // aqui — e chegam de quem perdeu a janela.
  app.on('activate', () => {
    if (win) revealWindow();
  });

  app.whenReady().then(async () => {
    // É um widget de barra de menus: sem ícone no Dock nem no Cmd+Tab, como no
    // Windows ele não aparece na barra de tarefas nem no Alt+Tab. O pacote
    // também traz LSUIElement, mas isto cobre o `npm start`.
    if (IS_MAC) app.dock?.hide();

    loadHistory();
    vaultSet = new VaultSet(config.load().vaults);
    await vaultSet.reindexAll();
    vaultSet.watchAll(pushVaults);

    registerIpc();
    createWindow();
    createTray();

    registerHotkey();
  });

  app.on('window-all-closed', () => {
    /* fica na bandeja — sair é só pelo menu do tray */
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    vaultSet?.closeAll();
    saveHistory();
  });
}
