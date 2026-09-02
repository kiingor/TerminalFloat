'use strict';
// Testes do que muda entre plataformas: expansão de `~` e o sandbox do cofre.
const assert = require('assert');
const os = require('os');
const path = require('path');
const { Vault, expandHome } = require('../src/vault');

const home = os.homedir();

// expandHome
assert.strictEqual(expandHome('~'), home);
assert.strictEqual(expandHome('~/Obsidian/X'), path.join(home, 'Obsidian', 'X'));
assert.strictEqual(expandHome('/abs/path'), '/abs/path');
assert.strictEqual(expandHome('C:\\Obsidian'), 'C:\\Obsidian');
assert.strictEqual(expandHome('~user/x'), '~user/x'); // não é o home atual: fica como está
assert.strictEqual(expandHome(''), '');

// Vault resolve o `~` na raiz
const v = new Vault({ id: 't', name: 'T', root: '~/Obsidian/T' });
assert.strictEqual(v.root, path.resolve(path.join(home, 'Obsidian', 'T')));

// e continua não deixando nada escapar da pasta
assert.throws(() => v.resolve('../fora.md'), /fora do cofre/);
assert.throws(() => v.resolve('a/../../fora.md'), /fora do cofre/);
assert.strictEqual(v.resolve('pasta/nota.md'), path.join(v.root, 'pasta', 'nota.md'));
assert.strictEqual(v.resolve('/pasta/nota.md'), path.join(v.root, 'pasta', 'nota.md'));

console.log('vault: ok');
