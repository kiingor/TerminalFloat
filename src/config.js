'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, safeStorage } = require('electron');

/**
 * Cofres registrados no próprio Obsidian. O app grava em `obsidian.json` o
 * caminho de todo cofre já aberto, então é a fonte mais confiável de onde eles
 * moram — inclusive quando ficam fora das pastas "óbvias". Só é lido no
 * macOS/Linux; no Windows o caminho padrão é fixo e conhecido.
 */
function obsidianRegisteredVaults() {
  const registry = path.join(os.homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  try {
    const vaults = JSON.parse(fs.readFileSync(registry, 'utf8')).vaults || {};
    return Object.values(vaults)
      .map((v) => v && v.path)
      .filter((p) => typeof p === 'string' && p);
  } catch {
    return [];
  }
}

/**
 * Onde os cofres costumam morar em cada sistema. No Windows é um caminho fixo
 * conhecido; no macOS/Linux o app procura o cofre pelo nome primeiro entre os
 * cofres registrados no Obsidian e depois nas pastas mais comuns (inclusive a
 * do Obsidian via iCloud Drive), usando a primeira que existir. `folderNames`
 * são outros nomes que a pasta do cofre pode ter no disco (o Obsidian deixa o
 * nome da pasta livre, e no Mac o Cofre de Acessos vive em "Cofre"). Nada
 * disso é definitivo: a tela de configurações permite trocar o caminho, e o
 * app avisa na barra de cofres quando a pasta não é encontrada.
 */
function defaultVaultRoot(name, folderNames = []) {
  if (process.platform === 'win32') return path.join('D:\\Obsidian', name);
  const home = os.homedir();
  const fallback = path.join(home, 'Documents', 'Obsidian', name);
  const names = [name, ...folderNames];
  const registered = obsidianRegisteredVaults().filter((p) => names.includes(path.basename(p)));
  const candidates = [
    ...registered,
    ...names.flatMap((n) => [
      path.join(home, 'Obsidian', n),
      path.join(home, 'Documents', 'Obsidian', n),
      path.join(home, 'Documents', n),
      path.join(home, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents', n),
      path.join(home, n),
    ]),
  ];
  const found = candidates.find((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  return found || fallback;
}

const DEFAULTS = {
  provider: 'anthropic', // 'anthropic' | 'openai'
  anthropic: { model: 'claude-opus-5', effort: 'medium' },
  // baseURL vazio = api.openai.com. Preencha para apontar a um gateway
  // compatível com a API da OpenAI (OmniRouter, LiteLLM, Ollama, vLLM…).
  openai: { model: 'gpt-5', baseURL: '' },
  confirmWrites: true,
  showThinking: true,
  hotkey: 'CommandOrControl+Shift+Space',
  vaults: [
    {
      id: 'pessoal',
      name: 'Filipe Lourenco',
      root: defaultVaultRoot('Filipe Lourenco'),
      enabled: true,
      writable: true,
      sensitive: false,
    },
    {
      id: 'acessos',
      name: 'Cofre de Acessos',
      root: defaultVaultRoot('Cofre de Acessos', ['Cofre']),
      enabled: true,
      writable: true,
      sensitive: true,
    },
  ],
  window: { x: null, y: null, width: 400, height: 580 },
};

let cache = null;
let filePath = null;

function file() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'config.json');
  return filePath;
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    /* primeira execução */
  }
  cache = deepMerge(DEFAULTS, stored);
  return cache;
}

function save(patch) {
  cache = deepMerge(load(), patch);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

// --- chaves de API -----------------------------------------------------------
// Guardadas cifradas pelo safeStorage quando disponível (DPAPI no Windows,
// Keychain no macOS); caso contrário caem para texto puro no config.json, e o
// app avisa na tela de configurações.

function secretsAreEncrypted() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function setApiKey(provider, key) {
  const trimmed = (key || '').trim();
  if (!trimmed) return save({ secrets: { [provider]: null } });
  if (secretsAreEncrypted()) {
    return save({
      secrets: { [provider]: { enc: safeStorage.encryptString(trimmed).toString('base64') } },
    });
  }
  return save({ secrets: { [provider]: { plain: trimmed } } });
}

/**
 * Estado completo da chave de um provider.
 *
 * `failed` importa: no Windows o safeStorage cifra com uma chave que o Chromium
 * guarda no arquivo `Local State` da pasta de dados. Se essa pasta mudar sem o
 * arquivo junto, o segredo continua lá mas não abre mais. Sem sinalizar isso, o
 * app cairia calado na variável de ambiente e o usuário veria um 401 sem
 * entender por quê.
 */
function keyState(provider) {
  const entry = load().secrets?.[provider];
  let value = null;
  let failed = false;

  if (entry?.enc) {
    if (secretsAreEncrypted()) {
      try {
        value = safeStorage.decryptString(Buffer.from(entry.enc, 'base64'));
      } catch {
        failed = true;
      }
    } else {
      failed = true;
    }
  } else if (entry?.plain) {
    value = entry.plain;
  }

  const env = provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  return {
    value: value || env || null,
    failed,
    fromEnv: !value && Boolean(env),
    stored: Boolean(entry),
  };
}

function getApiKey(provider) {
  return keyState(provider).value;
}

function hasApiKey(provider) {
  return Boolean(keyState(provider).value);
}

/** Versão segura para mandar ao renderer — nunca inclui segredos. */
function publicConfig() {
  const c = load();
  const anthropic = keyState('anthropic');
  const openai = keyState('openai');
  return {
    provider: c.provider,
    anthropic: c.anthropic,
    openai: c.openai,
    confirmWrites: c.confirmWrites,
    showThinking: c.showThinking,
    hotkey: c.hotkey,
    vaults: c.vaults,
    keys: {
      anthropic: Boolean(anthropic.value),
      openai: Boolean(openai.value),
      encrypted: secretsAreEncrypted(),
      anthropicFromEnv: anthropic.fromEnv,
      openaiFromEnv: openai.fromEnv,
      anthropicFailed: anthropic.failed,
      openaiFailed: openai.failed,
    },
  };
}

module.exports = { load, save, setApiKey, getApiKey, hasApiKey, publicConfig, defaultVaultRoot, DEFAULTS };
