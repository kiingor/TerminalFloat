const assert = require('assert');
const G = require('../src/geometry');

const BUBBLE = { width: 64, height: 69 };
const MIN = { width: 320, height: 360 };
// Layout real da máquina: primário 0..1920, secundário 1920..3840
const RIGHT = { x: 1920, y: 0, width: 1920, height: 1040 };
const LEFT = { x: 0, y: 0, width: 1920, height: 1040 };

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    console.log('  ok  ', name);
    pass++;
  } catch (e) {
    console.log('  FALHA', name, '->', e.message);
    process.exitCode = 1;
  }
};

console.log('collapsedBounds');
t('bolha assume o canto superior direito', () => {
  const r = G.collapsedBounds({ x: 3145, y: 391, width: 400, height: 580 }, BUBBLE);
  assert.deepStrictEqual(r, { x: 3481, y: 391, width: 64, height: 69 });
});

console.log('expandedBounds');
t('volta ao tamanho salvo alinhando pela direita', () => {
  const r = G.expandedBounds({ x: 3481, y: 391 }, { width: 400, height: 580 }, BUBBLE, MIN);
  assert.deepStrictEqual(r, { x: 3145, y: 391, width: 400, height: 580 });
});
t('respeita o tamanho minimo', () => {
  const r = G.expandedBounds({ x: 100, y: 100 }, { width: 50, height: 50 }, BUBBLE, MIN);
  assert.strictEqual(r.width, 320);
  assert.strictEqual(r.height, 360);
});
t('sem tamanho salvo cai no minimo', () => {
  const r = G.expandedBounds({ x: 100, y: 100 }, {}, BUBBLE, MIN);
  assert.strictEqual(r.width, 320);
});

console.log('ciclo recolher -> expandir e volta ao ponto de partida');
t('idempotente', () => {
  const start = { x: 3145, y: 391, width: 400, height: 580 };
  const bubble = G.collapsedBounds(start, BUBBLE);
  const back = G.expandedBounds(bubble, { width: start.width, height: start.height }, BUBBLE, MIN);
  assert.deepStrictEqual(back, start);
});

console.log('clampTo');
t('nao deixa a bolha sair pela direita do monitor secundario', () => {
  const r = G.clampTo({ x: 3900, y: 300, width: 64, height: 69 }, RIGHT);
  assert.strictEqual(r.x, 1920 + 1920 - 64); // 3776
});
t('nao deixa sair por cima', () => {
  const r = G.clampTo({ x: 200, y: -50, width: 400, height: 580 }, LEFT);
  assert.strictEqual(r.y, 0);
});
t('nao deixa sair por baixo', () => {
  const r = G.clampTo({ x: 200, y: 2000, width: 400, height: 580 }, LEFT);
  assert.strictEqual(r.y, 1040 - 580);
});
t('janela que ja cabe fica intacta', () => {
  const b = { x: 3145, y: 391, width: 400, height: 580 };
  assert.deepStrictEqual(G.clampTo(b, RIGHT), b);
});
t('expandir perto da borda direita e depois clampear mantem visivel', () => {
  const bubbleAt = { x: 3776, y: 900 };
  const wanted = G.expandedBounds(bubbleAt, { width: 400, height: 580 }, BUBBLE, MIN);
  const r = G.clampTo(wanted, RIGHT);
  assert.ok(r.x >= RIGHT.x, `x=${r.x} saiu pela esquerda`);
  assert.ok(r.x + r.width <= RIGHT.x + RIGHT.width, 'saiu pela direita');
  assert.ok(r.y + r.height <= RIGHT.y + RIGHT.height, 'saiu por baixo');
});


console.log('\nisReachable — janela perdida fora da tela');
const AREAS = [LEFT, RIGHT];
t('janela normal e alcancavel', () => {
  assert.ok(G.isReachable({ x: 300, y: 300, width: 400, height: 580 }, AREAS));
});
t('bolha no monitor da direita e alcancavel', () => {
  assert.ok(G.isReachable({ x: 3700, y: 400, width: 64, height: 69 }, AREAS));
});
t('arrastada quase toda para fora pela direita NAO e alcancavel', () => {
  assert.ok(!G.isReachable({ x: 3830, y: 400, width: 400, height: 580 }, AREAS));
});
t('so uma nesga visivel NAO conta', () => {
  // 10px sobrando na tela, abaixo da margem de 32
  assert.ok(!G.isReachable({ x: -390, y: 300, width: 400, height: 580 }, AREAS));
});
t('borda: exatamente a margem conta', () => {
  assert.ok(G.isReachable({ x: -368, y: 300, width: 400, height: 580 }, AREAS));
});
t('num monitor que sumiu NAO e alcancavel', () => {
  // mesma janela, mas agora so existe o monitor da esquerda
  const b = { x: 2500, y: 400, width: 400, height: 580 };
  assert.ok(G.isReachable(b, AREAS));
  assert.ok(!G.isReachable(b, [LEFT]));
});
t('bolha usa a propria largura como margem, nao 32 fixo', () => {
  // bolha de 64px com 40px na tela: passa, porque 40 >= min(32,64)
  assert.ok(G.isReachable({ x: 1880, y: 400, width: 64, height: 69 }, [LEFT]));
});

console.log('\ncenterIn');
t('centraliza na area util', () => {
  const r = G.centerIn({ x: 9999, y: 9999, width: 400, height: 580 }, LEFT);
  assert.deepStrictEqual(r, { x: 760, y: 230, width: 400, height: 580 });
});
t('resultado centralizado e sempre alcancavel', () => {
  const r = G.centerIn({ x: -5000, y: -5000, width: 400, height: 580 }, LEFT);
  assert.ok(G.isReachable(r, [LEFT]));
});

console.log(`
${pass} testes passaram`);
