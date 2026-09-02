'use strict';
// Gera `build/icon.png` (1024px) a partir do pet, para o electron-builder
// converter em .icns (macOS) e .ico (Windows). Roda dentro do Electron porque
// o recorte do spritesheet usa `nativeImage`. Sem janela: só escreve e sai.
//
//   npm run icon        (chamado automaticamente por `npm run dist*`)
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { appIcon } = require('../src/icon');

app.whenReady().then(() => {
  const outDir = path.join(__dirname, '..', 'build');
  const out = path.join(outDir, 'icon.png');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(out, appIcon(1024));
  console.log(`ícone gerado em ${out}`);
  app.quit();
});
