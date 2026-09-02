'use strict';

const api = window.dulse;
const $ = (sel) => document.querySelector(sel);

const els = {
  body: document.body,
  bubble: $('#bubble'),
  bubbleBtn: $('#bubble-btn'),
  messages: $('#messages'),
  input: $('#input'),
  send: $('#btn-send'),
  vaultbar: $('#vaultbar'),
  settings: $('#settings'),
  resize: $('#resize'),
};

let config = null;
let vaults = [];
let busy = false;
let hotkeyActive = null;
let platform = 'win32';
let userDataPath = '';
let turn = null; // bloco do assistente sendo construído

const isMac = () => platform === 'darwin';

/**
 * Traduz o acelerador do Electron ('CommandOrControl+Shift+Space') para o que
 * o usuário vê no teclado: `⌘⇧Espaço` no Mac, `Ctrl+Shift+Espaço` no resto.
 */
function formatHotkey(accelerator) {
  const names = isMac()
    ? { CommandOrControl: '⌘', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Space: 'Espaço' }
    : { CommandOrControl: 'Ctrl', Command: 'Win', Cmd: 'Win', Control: 'Ctrl', Alt: 'Alt', Option: 'Alt', Shift: 'Shift', Space: 'Espaço' };
  const parts = String(accelerator || '').split('+').map((p) => names[p] || p);
  return isMac() ? parts.join('') : parts.join('+');
}

// ------------------------------------------------------------------ utilidades

function autoScroll(force = false) {
  const m = els.messages;
  const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 90;
  if (force || nearBottom) m.scrollTop = m.scrollHeight;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setBusy(next) {
  busy = next;
  els.body.classList.toggle('busy', next);
  els.bubble.classList.toggle('busy', next);
  els.send.disabled = !next && !els.input.value.trim();
  // Enquanto o agente trabalha, o pet medita.
  petPlay(next ? 'busy' : 'idle');
}

function showEmptyState() {
  els.messages.replaceChildren();
  const box = el('div', 'empty');
  box.append(
    'Converse com as suas anotações do Obsidian.',
    document.createElement('br'),
    document.createElement('br')
  );
  const names = vaults.filter((v) => !v.error).map((v) => v.name);
  const strong = el('strong', null, names.length ? names.join(' · ') : 'nenhum cofre carregado');
  box.append(strong);
  els.messages.append(box);
}

// ------------------------------------------------------------------- o pet

// Dois lugares mostram o pet: a bolha (janela recolhida) e o cabeçalho do chat
// (janela aberta). Ambos seguem o mesmo estado — só um deles está visível por
// vez, então tocar nos dois é mais simples do que descobrir qual.
let petSprites = [];

/**
 * Animador de spritesheet. Os números vêm do pet.json, não do código: trocar de
 * pet passa a ser trocar a pasta `renderer/pet`.
 */
function createSprite(node, manifest) {
  const anims = manifest.animations || {};
  const entries = Object.values(anims);
  if (!entries.length) return null;

  const cols = Math.max(1, ...entries.map((a) => a.frames || 1));
  const rows = Math.max(1, ...entries.map((a) => (a.row || 0) + 1));

  // Amplia a folha para que um quadro ocupe exatamente o elemento.
  node.style.backgroundSize = `${cols * 100}% ${rows * 100}%`;

  let current = null;
  let index = 0;
  let timer = null;

  // Em background-position percentual, o valor alinha o mesmo ponto relativo da
  // imagem e do elemento — então a coluna c fica em c/(cols-1), não em c*100%.
  const show = (row, col) => {
    const x = cols > 1 ? (col / (cols - 1)) * 100 : 0;
    const y = rows > 1 ? (row / (rows - 1)) * 100 : 0;
    node.style.backgroundPosition = `${x}% ${y}%`;
  };

  const step = () => {
    const anim = anims[current];
    if (!anim) return;
    show(anim.row || 0, index);
    const wait = anim.frameDurationsMs?.[index] ?? Math.round(1000 / (manifest.fps || 8));
    index = (index + 1) % Math.max(1, anim.frames || 1);
    timer = setTimeout(step, wait);
  };

  return {
    play(name) {
      if (!anims[name] || current === name) return;
      current = name;
      index = 0;
      clearTimeout(timer);
      step();
    },
  };
}

// Os nomes no manifesto descrevem um pet que corre; a arte deste é outra —
// "running" é a meditação e "running-left/right" são reverências.
const PET_ANIMATION = {
  idle: 'idle',
  busy: 'running',
  dragRight: 'running-right',
  dragLeft: 'running-left',
};

function petPlay(state) {
  const animation = PET_ANIMATION[state] || PET_ANIMATION.idle;
  for (const sprite of petSprites) sprite.play(animation);
}

async function loadPet() {
  try {
    const manifest = await (await fetch('pet/pet.json')).json();
    petSprites = [$('#pet'), $('#pet-mark')]
      .filter(Boolean)
      .map((node) => createSprite(node, manifest))
      .filter(Boolean);
    petPlay('idle');
  } catch {
    /* sem pet o app funciona igual — só fica sem o desenho */
  }
}

// ----------------------------------------------------------- copiar segredos

function flash(node, label) {
  const original = label ? node.textContent : null;
  node.classList.add('done');
  if (label) node.textContent = label;
  clearTimeout(node._flash);
  node._flash = setTimeout(() => {
    node.classList.remove('done');
    if (original !== null) node.textContent = original;
  }, 1400);
}

/**
 * Coloca "copiar" em cada bloco de código e torna código inline longo
 * clicável — é assim que tokens e senhas saem daqui sem seleção manual.
 */
function decorateCode(root) {
  for (const pre of root.querySelectorAll('pre:not([data-copy])')) {
    pre.dataset.copy = '1';
    const btn = el('button', 'copy-btn', 'copiar');
    btn.type = 'button';
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      api.copy(pre.querySelector('code')?.textContent ?? pre.textContent);
      flash(btn, 'copiado');
    });
    pre.append(btn);
  }

  for (const code of root.querySelectorAll('code:not([data-copy])')) {
    code.dataset.copy = '1';
    if (code.closest('pre')) continue;
    const value = code.textContent || '';
    // Curto demais é palavra de código comum, não credencial.
    if (value.length < 16 || /\s/.test(value)) continue;
    code.classList.add('copyable');
    code.title = 'clique para copiar';
    code.addEventListener('click', () => {
      api.copy(code.textContent);
      flash(code);
    });
  }
}

// -------------------------------------------------------------- renderização

function addUserMessage(text) {
  els.messages.querySelector('.empty')?.remove();
  const node = el('div', 'msg user', text);
  els.messages.append(node);
  autoScroll(true);
}

function startAssistantTurn() {
  els.messages.querySelector('.empty')?.remove();
  const node = el('div', 'msg assistant');
  els.messages.append(node);
  turn = { node, textEl: null, textRaw: '', thinkEl: null, tools: new Map(), frame: null };
  autoScroll(true);
  return turn;
}

function ensureTurn() {
  return turn || startAssistantTurn();
}

function appendText(delta) {
  const t = ensureTurn();
  if (!t.textEl) {
    t.textEl = el('div', 'seg-text');
    t.textRaw = '';
    t.node.append(t.textEl);
  }
  t.textRaw += delta;
  // Re-renderiza o markdown num frame de animação — respostas de chat são
  // curtas o bastante para isso ser mais barato que um parser incremental.
  if (!t.frame) {
    t.frame = requestAnimationFrame(() => {
      t.frame = null;
      if (t.textEl) {
        t.textEl.innerHTML = window.md.render(t.textRaw);
        decorateCode(t.textEl);
      }
      autoScroll();
    });
  }
}

function appendThinking(delta) {
  if (config && config.showThinking === false) return;
  const t = ensureTurn();
  if (!t.thinkEl) {
    const details = el('details', 'seg-think');
    const summary = el('summary', null, 'raciocínio');
    const body = el('div', 'body');
    details.append(summary, body);
    t.node.append(details);
    t.thinkEl = body;
  }
  t.thinkEl.textContent += delta;
  autoScroll();
}

const TOOL_LABELS = {
  search_vault: 'buscando',
  read_note: 'lendo',
  list_notes: 'listando',
  write_note: 'gravando',
};

function toolArgument(name, input) {
  if (!input) return '';
  if (name === 'search_vault') return input.query || '';
  if (name === 'read_note' || name === 'write_note') return input.path || '';
  if (name === 'list_notes') return input.folder || input.vault || '';
  return '';
}

function toolStart({ id, name, input }) {
  const t = ensureTurn();
  const node = el('div', 'tool');
  node.append(el('span', 'spin'));
  node.append(el('span', 'label', TOOL_LABELS[name] || name));
  const arg = toolArgument(name, input);
  if (arg) node.append(el('span', 'arg', arg));
  t.node.append(node);
  t.tools.set(id, node);
  // O próximo texto vira um parágrafo novo, depois do chip.
  t.textEl = null;
  autoScroll();
}

function summarizeToolResult(name, output) {
  if (!output || output.error) return output?.error ? 'falhou' : '';
  if (name === 'search_vault') {
    const n = output.results?.length || 0;
    return n ? `${n} nota${n > 1 ? 's' : ''}` : 'nada encontrado';
  }
  if (name === 'list_notes') return `${output.count} notas`;
  if (name === 'read_note') return `${Math.round((output.content?.length || 0) / 100) / 10} mil chars`;
  if (name === 'write_note') {
    if (output.written === false) return 'recusado';
    return output.created ? 'nota criada' : 'nota atualizada';
  }
  return '';
}

function toolEnd({ id, name, ok, output }) {
  const node = turn?.tools.get(id);
  if (!node) return;
  node.classList.add(ok ? 'ok' : 'fail');
  const summary = ok ? summarizeToolResult(name, output) : String(output?.error || 'erro');
  if (summary) {
    const arg = node.querySelector('.arg');
    const detail = el('span', 'arg', `· ${summary}`);
    node.insertBefore(detail, arg ? arg.nextSibling : null);
  }
  autoScroll();
}

function renderConfirm(payload) {
  const t = ensureTurn();
  const card = el('div', 'confirm');

  const modeLabel = { create: 'Criar nota', overwrite: 'Sobrescrever nota', append: 'Adicionar ao fim da nota' };
  card.append(el('div', 'head', modeLabel[payload.mode] || 'Escrever no cofre'));
  card.append(el('div', 'path', `${payload.vaultName} › ${payload.path}`));
  if (payload.sensitive) {
    card.append(el('div', 'warn-secret', 'Atenção: este é o cofre de credenciais.'));
  }

  const preview = payload.content.length > 2000 ? `${payload.content.slice(0, 2000)}\n…` : payload.content;
  card.append(el('pre', null, preview));

  const row = el('div', 'row');
  const approve = el('button', 'approve', 'Aprovar');
  const deny = el('button', 'deny', 'Recusar');
  row.append(approve, deny);
  card.append(row);

  const decide = (approved) => {
    api.respondConfirm(payload.id, approved);
    card.classList.add('resolved');
    card.append(el('div', 'verdict', approved ? '✓ Gravado no cofre.' : '✕ Escrita recusada.'));
    autoScroll();
  };
  approve.addEventListener('click', () => decide(true));
  deny.addEventListener('click', () => decide(false));

  t.node.append(card);
  t.textEl = null;
  autoScroll(true);
}

function renderError(message) {
  const t = ensureTurn();
  t.node.append(el('div', 'error', message));
  t.textEl = null;
  autoScroll(true);
}

// ------------------------------------------------------------------ conversa

async function submit() {
  if (busy) {
    api.stop();
    return;
  }
  const text = els.input.value.trim();
  if (!text) return;

  els.input.value = '';
  els.input.style.height = 'auto';
  addUserMessage(text);
  turn = null;
  setBusy(true);

  try {
    await api.send(text);
  } catch (err) {
    renderError(String(err?.message || err));
  } finally {
    setBusy(false);
    turn = null;
  }
}

api.onChatEvent((event) => {
  switch (event.type) {
    case 'turn-start':
      if (!turn) startAssistantTurn();
      break;
    case 'text':
      appendText(event.delta);
      break;
    case 'thinking':
      appendThinking(event.delta);
      break;
    case 'tool-start':
      toolStart(event);
      break;
    case 'tool-end':
      toolEnd(event);
      break;
    case 'confirm':
      renderConfirm(event);
      break;
    case 'error':
      renderError(event.message);
      setBusy(false);
      break;
    case 'stopped':
      renderError('Interrompido.');
      setBusy(false);
      break;
    case 'done':
      setBusy(false);
      autoScroll();
      break;
  }
});

// -------------------------------------------------------------------- cofres

function renderVaultbar() {
  els.vaultbar.replaceChildren();
  for (const v of vaults) {
    const chip = el('span', `vault-chip${v.sensitive ? ' sensitive' : ''}${v.error ? ' broken' : ''}`);
    chip.append(el('span', 'dot'));
    chip.append(el('span', null, v.error ? `${v.name}: não encontrado` : `${v.name} · ${v.notes}`));
    if (v.error) chip.title = v.error;
    els.vaultbar.append(chip);
  }
}

api.onVaultState((next) => {
  vaults = next;
  renderVaultbar();
  if (els.messages.querySelector('.empty')) showEmptyState();
  if (!els.settings.hidden) renderVaultSettings();
});

// ------------------------------------------------------------- configurações

function applyConfig(next) {
  config = next;
  // O subtítulo é fixo; qual modelo está atendendo vira tooltip do cabeçalho,
  // que é onde essa informação é consultada e não onde ela precisa gritar.
  const brand = $('#brand');
  if (brand) {
    brand.title =
      config.provider === 'openai'
        ? `${config.openai.model} via ${config.openai.baseURL || 'api.openai.com'}`
        : `${config.anthropic.model} (esforço ${config.anthropic.effort})`;
  }

  $('#anthropic-model').value = config.anthropic.model || '';
  $('#anthropic-effort').value = config.anthropic.effort || 'medium';
  $('#openai-model').value = config.openai.model || '';
  $('#openai-baseurl').value = config.openai.baseURL || '';
  $('#opt-confirm').checked = config.confirmWrites !== false;
  $('#opt-thinking').checked = config.showThinking !== false;
  // Mostra o atalho que está VALENDO, não o que está no config: outro app pode
  // ter tomado a combinação, e aí o rótulo estaria mentindo.
  const hint = $('#hotkey-hint');
  const trayName = isMac() ? 'ícone na barra de menus' : 'ícone da bandeja';
  if (hotkeyActive) {
    hint.className = 'hint';
    hint.textContent = 'Atalho global: ';
    hint.append(el('kbd', null, formatHotkey(hotkeyActive)));
    els.bubbleBtn.title = `Abrir o chat (${formatHotkey(hotkeyActive)})`;
  } else {
    hint.className = 'hint';
    hint.textContent = `Nenhum atalho global disponível — as combinações testadas já estão em uso por outro programa. Use o ${trayName} para abrir.`;
    els.bubbleBtn.title = 'Abrir o chat';
  }

  // Texto de resgate por plataforma: no Mac não existe "bandeja perto do
  // relógio" nem "ícones ocultos" — o ícone fica na barra de menus, no topo.
  const lost = $('#lost-hint');
  if (lost) {
    lost.textContent = isMac()
      ? 'Clique no ícone do LouroChan na barra de menus do macOS (no topo, perto do relógio). Rodar '
      : 'Clique no ícone do LouroChan na bandeja do Windows (perto do relógio; pode estar em "Mostrar ícones ocultos"). Rodar ';
    lost.append(el('kbd', null, 'npm start'), ' de novo também traz a janela de volta.');
  }

  for (const btn of document.querySelectorAll('#provider-switch button')) {
    btn.classList.toggle('on', btn.dataset.provider === config.provider);
  }
  for (const pane of document.querySelectorAll('.provider-pane')) {
    pane.hidden = pane.dataset.pane !== config.provider;
  }

  renderKeyState('anthropic');
  renderKeyState('openai');
}

function renderKeyState(provider) {
  const node = $(`#${provider}-key-state`);
  const has = config.keys[provider];
  const fromEnv = config.keys[`${provider}FromEnv`];
  node.className = 'key-state';

  if (config.keys[`${provider}Failed`]) {
    node.classList.add('plain');
    node.textContent =
      'A chave salva não pôde ser decifrada (a pasta de dados do app mudou). Cole a chave de novo.';
    return;
  }
  if (!has) {
    node.textContent = 'Nenhuma chave configurada.';
    return;
  }
  if (fromEnv) {
    node.classList.add('set');
    node.textContent = 'Usando a chave da variável de ambiente.';
    return;
  }
  if (config.keys.encrypted) {
    node.classList.add('set');
    node.textContent = isMac()
      ? 'Chave salva e cifrada pelo Keychain do macOS.'
      : 'Chave salva e cifrada pelo Windows (DPAPI).';
  } else {
    node.classList.add('plain');
    node.textContent = 'Chave salva em texto puro — o cofre do sistema não está disponível.';
  }
}

function renderVaultSettings() {
  const host = $('#vault-settings');
  host.replaceChildren();
  for (const v of vaults) {
    const row = el('div', `vault-row${v.error ? ' broken' : ''}`);
    const top = el('div', 'top');
    top.append(el('span', 'title', v.name));
    if (v.sensitive) top.append(el('span', 'tag', 'credenciais'));
    row.append(top);
    row.append(el('div', 'meta', v.error ? v.error : `${v.root} · ${v.notes} notas`));

    const toggles = el('div', 'toggles');
    const mk = (label, checked, onChange) => {
      const wrap = el('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = checked;
      box.addEventListener('change', () => onChange(box.checked));
      wrap.append(box, el('span', null, label));
      return wrap;
    };

    const patchVault = async (patch) => {
      const stored = config.vaults.map((cv) => (cv.id === v.id ? { ...cv, ...patch } : cv));
      vaults = await api.setVaults(stored);
      config = await api.updateConfig({});
      renderVaultbar();
      renderVaultSettings();
    };

    const stored = config.vaults.find((cv) => cv.id === v.id) || {};
    toggles.append(mk('ativo', stored.enabled !== false, (on) => patchVault({ enabled: on })));
    toggles.append(mk('permitir escrita', v.writable !== false, (on) => patchVault({ writable: on })));
    row.append(toggles);
    host.append(row);
  }
}

function openSettings() {
  renderVaultSettings();
  els.settings.hidden = false;
}

function closeSettings() {
  els.settings.hidden = true;
}

// --------------------------------------------------------------- interações

els.send.addEventListener('click', submit);

els.input.addEventListener('input', () => {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 132)}px`;
  els.send.disabled = busy ? false : !els.input.value.trim();
});

els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!els.settings.hidden) closeSettings();
    else api.collapse();
  }
});

$('#btn-new').addEventListener('click', () => {
  api.reset();
  turn = null;
  showEmptyState();
  els.input.focus();
});

$('#btn-settings').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', closeSettings);
$('#btn-collapse').addEventListener('click', () => api.collapse());
/**
 * Base de arraste da janela sem frame, usada pela bolha e pela alça de
 * redimensionar.
 *
 * Tudo aqui é síncrono, e isso é o ponto. Buscar os limites da janela por IPC
 * cria duas corridas contra um gesto rápido: os listeners acabam registrados
 * depois do mouseup (o clique se perde, e o mousemove nunca é removido — a
 * janela passa a seguir o mouse sozinha), e os movimentos que chegam antes da
 * resposta são descartados (o arraste não sai do lugar). O renderer já conhece
 * a própria janela: screenX e outerWidth vêm em DIP, a mesma unidade que
 * setPosition e setSize esperam.
 *
 * Mouse events e não Pointer Events de propósito: a janela é arrastada pelo
 * conteúdo e acompanha o cursor, então ele não escapa dos limites e a captura
 * de ponteiro não é necessária — e o caminho de mouse é o que de fato chega
 * aqui em toda entrada sintética que testei.
 */
function beginWindowDrag(event, { onDelta, onEnd, threshold = 4 }) {
  const originX = event.screenX;
  const originY = event.screenY;
  const start = {
    x: window.screenX,
    y: window.screenY,
    width: window.outerWidth,
    height: window.outerHeight,
  };
  let dragging = false;

  const onMove = (move) => {
    const dx = move.screenX - originX;
    const dy = move.screenY - originY;
    // Folga: tremida de mão ao clicar não deve virar arraste.
    if (!dragging && Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;
    dragging = true;
    // Aplicado direto, sem requestAnimationFrame. Enfileirar num frame
    // congelava o delta do instante do agendamento e descartava os movimentos
    // seguintes; pior, o rAF é estrangulado quando a janela perde o foco —
    // exatamente o que acontece ao arrastar. O IPC é barato o bastante para
    // acompanhar a taxa do mouse.
    onDelta(start, dx, dy);
  };

  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    onEnd?.(dragging);
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// A bolha inteira arrasta e a bolha inteira abre. A região de drag do Chromium
// não serve aqui: ela entrega o arraste ao sistema e engole o clique — daria
// para mover ou para abrir, nunca os dois.
//
// Abrir fica no evento `click`, não no `mouseup`: leitores de tela e
// automação acionam o botão pelo padrão Invoke, que emite `click` sem emitir
// `mousedown`. O arraste só levanta uma bandeira para o clique final ignorar.
let bubbleWasDragged = false;

els.bubbleBtn.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  beginWindowDrag(event, {
    onDelta: (start, dx, dy) => {
      api.setPosition(start.x + dx, start.y + dy);
      // Reverência para o lado em que está sendo levado.
      petPlay(dx >= 0 ? 'dragRight' : 'dragLeft');
    },
    onEnd: (dragged) => {
      bubbleWasDragged = dragged;
      petPlay(busy ? 'busy' : 'idle');
    },
  });
});

els.bubbleBtn.addEventListener('click', () => {
  if (bubbleWasDragged) {
    bubbleWasDragged = false;
    return;
  }
  api.expand();
});

$('#btn-center').addEventListener('click', () => api.center());
$('#btn-quit').addEventListener('click', () => api.quit());
$('#btn-reindex').addEventListener('click', async () => {
  vaults = await api.reindex();
  renderVaultbar();
  renderVaultSettings();
});

for (const btn of document.querySelectorAll('#provider-switch button')) {
  btn.addEventListener('click', async () => {
    applyConfig(await api.updateConfig({ provider: btn.dataset.provider }));
  });
}

const bindText = (selector, apply) => {
  const node = $(selector);
  node.addEventListener('change', async () => {
    applyConfig(await api.updateConfig(apply(node.value.trim())));
  });
};

bindText('#anthropic-model', (v) => ({ anthropic: { model: v } }));
bindText('#openai-model', (v) => ({ openai: { model: v } }));
bindText('#openai-baseurl', (v) => ({ openai: { baseURL: v.replace(/\/+$/, '') } }));

$('#anthropic-effort').addEventListener('change', async (e) => {
  applyConfig(await api.updateConfig({ anthropic: { effort: e.target.value } }));
});

$('#opt-confirm').addEventListener('change', async (e) => {
  applyConfig(await api.updateConfig({ confirmWrites: e.target.checked }));
});

$('#opt-thinking').addEventListener('change', async (e) => {
  applyConfig(await api.updateConfig({ showThinking: e.target.checked }));
});

const bindKey = (provider) => {
  const node = $(`#${provider}-key`);
  const save = async () => {
    if (!node.value) return;
    applyConfig(await api.setApiKey(provider, node.value));
    node.value = '';
  };
  node.addEventListener('change', save);
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  });
};

bindKey('anthropic');
bindKey('openai');

// Abrir a nota citada no explorador de arquivos.
els.messages.addEventListener('click', (event) => {
  const link = event.target.closest('.wikilink');
  if (!link) return;
  const note = link.dataset.note;
  const guess = vaults.find((v) => !v.error) || vaults[0];
  if (guess) api.revealNote(guess.id, note.endsWith('.md') ? note : `${note}.md`);
});

// Alça de redimensionamento — a janela é frameless, então isso é manual.
els.resize.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  beginWindowDrag(event, {
    threshold: 2,
    onDelta: (start, dx, dy) => api.setSize(start.width + dx, start.height + dy),
  });
});

api.onWindowState(({ collapsed }) => {
  els.body.classList.toggle('collapsed', collapsed);
  els.bubble.hidden = !collapsed;
  if (!collapsed) setTimeout(() => els.input.focus(), 40);
});

api.onReset(() => {
  turn = null;
  showEmptyState();
});

api.onFocusInput(() => els.input.focus());

// ------------------------------------------------------------------ arranque

(async function init() {
  loadPet();
  const boot = await api.bootstrap();
  vaults = boot.vaults;
  hotkeyActive = boot.hotkeyActive;
  platform = boot.platform || platform;
  userDataPath = boot.userDataPath || '';
  document.body.dataset.platform = platform;
  applyConfig(boot.config);
  renderVaultbar();

  if (boot.messages.length) {
    els.messages.replaceChildren();
    for (const msg of boot.messages) {
      if (msg.role === 'user') {
        els.messages.append(el('div', 'msg user', msg.content));
      } else {
        const node = el('div', 'msg assistant');
        const text = el('div', 'seg-text');
        text.innerHTML = window.md.render(msg.content);
        decorateCode(text);
        node.append(text);
        els.messages.append(node);
      }
    }
    autoScroll(true);
  } else {
    showEmptyState();
  }

  els.body.classList.toggle('collapsed', boot.collapsed);
  els.bubble.hidden = !boot.collapsed;
  els.send.disabled = true;
  els.input.focus();
})();
