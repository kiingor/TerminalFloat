'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

/** `~/Obsidian/X` é a forma natural de escrever um caminho no macOS/Linux. */
function expandHome(p) {
  const s = String(p || '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

const IGNORED_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.smart-env', '.space']);
const STOPWORDS = new Set([
  'a', 'o', 'as', 'os', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas', 'um',
  'uma', 'para', 'por', 'com', 'que', 'e', 'ou', 'meu', 'minha', 'meus', 'minhas', 'qual',
  'quais', 'onde', 'como', 'the', 'of', 'to', 'in', 'is', 'my', 'what', 'where',
]);

const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');
const norm = (s) => (s || '').normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();

function terms(query) {
  return [...new Set(norm(query).split(/[^a-z0-9_]+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t)))];
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

class Vault {
  constructor({ id, name, root, writable = true, sensitive = false }) {
    this.id = id;
    this.name = name;
    this.root = path.resolve(expandHome(root));
    this.writable = writable;
    this.sensitive = sensitive;
    this.notes = new Map(); // relPath -> { relPath, title, folder, mtime, size, content, normContent, normTitle }
    this.error = null;
    this.watcher = null;
  }

  exists() {
    try {
      return fs.statSync(this.root).isDirectory();
    } catch {
      return false;
    }
  }

  /** Converte um caminho vindo do modelo em caminho absoluto validado dentro do cofre. */
  resolve(relPath) {
    const cleaned = String(relPath || '').replace(/^[\\/]+/, '').replace(/\\/g, '/');
    if (!cleaned) throw new Error('Caminho vazio.');
    const abs = path.resolve(this.root, cleaned);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Caminho fora do cofre "${this.name}": ${relPath}`);
    }
    return abs;
  }

  toRel(abs) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  async reindex() {
    if (!this.exists()) {
      this.error = `Pasta não encontrada: ${this.root}`;
      this.notes.clear();
      return this;
    }
    this.error = null;
    const next = new Map();

    const walk = async (dir) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          await walk(abs);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          try {
            const [content, stat] = await Promise.all([fsp.readFile(abs, 'utf8'), fsp.stat(abs)]);
            const relPath = this.toRel(abs);
            const title = path.basename(relPath, '.md');
            next.set(relPath, {
              relPath,
              title,
              folder: path.dirname(relPath) === '.' ? '' : path.dirname(relPath),
              mtime: stat.mtimeMs,
              size: stat.size,
              content,
              normContent: norm(content),
              normTitle: norm(`${title} ${relPath}`),
            });
          } catch {
            /* arquivo ilegível — ignora */
          }
        }
      }
    };

    await walk(this.root);
    this.notes = next;
    return this;
  }

  watch(onChange) {
    if (!this.exists() || this.watcher) return;
    let timer = null;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        if (filename && !String(filename).toLowerCase().endsWith('.md')) return;
        clearTimeout(timer);
        timer = setTimeout(async () => {
          await this.reindex();
          onChange?.(this.id);
        }, 400);
      });
      this.watcher.on('error', () => {});
    } catch {
      /* sem watcher: o índice é atualizado nas escritas e no início */
    }
  }

  close() {
    try {
      this.watcher?.close();
    } catch {
      /* noop */
    }
    this.watcher = null;
  }

  search(query, limit = 6) {
    const ts = terms(query);
    const phrase = norm(query).trim();
    const results = [];

    for (const note of this.notes.values()) {
      let score = 0;
      let matched = 0;
      for (const t of ts) {
        const inTitle = countOccurrences(note.normTitle, t);
        const inBody = countOccurrences(note.normContent, t);
        if (inTitle || inBody) matched++;
        score += inTitle * 12 + Math.min(inBody, 20) * 1.5;
      }
      if (phrase.length >= 4) score += countOccurrences(note.normContent, phrase) * 6;
      if (!score) continue;
      // Notas que batem em todos os termos vêm bem na frente das parciais.
      if (ts.length > 1 && matched === ts.length) score *= 2.2;
      results.push({ note, score });
    }

    results.sort((a, b) => b.score - a.score || b.note.mtime - a.note.mtime);
    return results.slice(0, limit).map(({ note, score }) => ({
      vault: this.id,
      vaultName: this.name,
      sensitive: this.sensitive,
      path: note.relPath,
      title: note.title,
      score: Math.round(score),
      modified: new Date(note.mtime).toISOString(),
      excerpt: this.excerpt(note, ts, phrase),
    }));
  }

  excerpt(note, ts, phrase) {
    let at = phrase.length >= 4 ? note.normContent.indexOf(phrase) : -1;
    if (at < 0) {
      for (const t of ts) {
        at = note.normContent.indexOf(t);
        if (at >= 0) break;
      }
    }
    if (at < 0) at = 0;
    const start = Math.max(0, at - 140);
    const slice = note.content.slice(start, start + 420).replace(/\s+/g, ' ').trim();
    return (start > 0 ? '…' : '') + slice + (start + 420 < note.content.length ? '…' : '');
  }

  async read(relPath) {
    const abs = this.resolve(relPath.endsWith('.md') ? relPath : `${relPath}.md`);
    const content = await fsp.readFile(abs, 'utf8');
    return { vault: this.id, path: this.toRel(abs), content };
  }

  list(folder = '') {
    const prefix = norm(String(folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
    return [...this.notes.values()]
      .filter((n) => !prefix || norm(n.relPath).startsWith(prefix))
      .sort((a, b) => a.relPath.localeCompare(b.relPath))
      .map((n) => ({ path: n.relPath, title: n.title, modified: new Date(n.mtime).toISOString() }));
  }

  async write(relPath, content, mode = 'create') {
    if (!this.writable) throw new Error(`Cofre "${this.name}" está em modo somente leitura.`);
    const withExt = relPath.endsWith('.md') ? relPath : `${relPath}.md`;
    const abs = this.resolve(withExt);
    const existed = fs.existsSync(abs);

    if (mode === 'create' && existed) {
      throw new Error(`Já existe uma nota em "${this.toRel(abs)}". Use mode="overwrite" ou "append".`);
    }
    if ((mode === 'append' || mode === 'overwrite') && !existed && mode === 'append') {
      // append em arquivo inexistente = criar
      mode = 'create';
    }

    await fsp.mkdir(path.dirname(abs), { recursive: true });
    if (mode === 'append') {
      const current = await fsp.readFile(abs, 'utf8');
      const sep = current.endsWith('\n') ? '' : '\n';
      await fsp.writeFile(abs, `${current}${sep}${content}\n`, 'utf8');
    } else {
      await fsp.writeFile(abs, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
    }

    const stat = await fsp.stat(abs);
    const finalContent = await fsp.readFile(abs, 'utf8');
    const rel = this.toRel(abs);
    const title = path.basename(rel, '.md');
    this.notes.set(rel, {
      relPath: rel,
      title,
      folder: path.dirname(rel) === '.' ? '' : path.dirname(rel),
      mtime: stat.mtimeMs,
      size: stat.size,
      content: finalContent,
      normContent: norm(finalContent),
      normTitle: norm(`${title} ${rel}`),
    });

    return { vault: this.id, path: rel, mode, created: !existed, bytes: stat.size };
  }
}

class VaultSet {
  constructor(configs) {
    this.vaults = configs.filter((v) => v.enabled !== false).map((v) => new Vault(v));
  }

  get(id) {
    const v = this.vaults.find((x) => x.id === id);
    if (!v) {
      throw new Error(`Cofre desconhecido: "${id}". Disponíveis: ${this.vaults.map((x) => x.id).join(', ')}`);
    }
    return v;
  }

  async reindexAll() {
    await Promise.all(this.vaults.map((v) => v.reindex()));
    return this;
  }

  watchAll(onChange) {
    for (const v of this.vaults) v.watch(onChange);
  }

  closeAll() {
    for (const v of this.vaults) v.close();
  }

  search(query, { vault, limit = 6 } = {}) {
    const targets = vault ? [this.get(vault)] : this.vaults;
    return targets
      .flatMap((v) => v.search(query, limit))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  summary() {
    return this.vaults.map((v) => ({
      id: v.id,
      name: v.name,
      root: v.root,
      notes: v.notes.size,
      writable: v.writable,
      sensitive: v.sensitive,
      error: v.error,
    }));
  }
}

module.exports = { Vault, VaultSet, expandHome };
