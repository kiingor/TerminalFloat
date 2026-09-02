'use strict';
// Ícone da bandeja e da janela. Preferência é recortar um quadro do pet; a
// gema desenhada à mão fica como reserva se o spritesheet não estiver lá.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filtro "none"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Cobertura do pixel pelo polígono, com antialiasing 4x4. */
function polygonCoverage(px, py, pts) {
  let hits = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      if (pointInPolygon(px + (sx + 0.5) / 4, py + (sy + 0.5) / 4, pts)) hits++;
    }
  }
  return hits / 16;
}

/** Distância de um ponto ao segmento a–b, para desenhar as facetas. */
function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function blend(dst, i, r, g, b, a) {
  if (a <= 0) return;
  const inv = 1 - a;
  dst[i] = Math.round(r * a + dst[i] * inv);
  dst[i + 1] = Math.round(g * a + dst[i + 1] * inv);
  dst[i + 2] = Math.round(b * a + dst[i + 2] * inv);
  dst[i + 3] = Math.round(255 * a + dst[i + 3] * inv);
}

/**
 * Gema facetada em gradiente teal->azul, sobre fundo transparente.
 * As facetas só entram a partir de 24px — abaixo disso viram sujeira.
 */
function makeIcon(size = 32) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const s = (v) => v * size;

  const top = [s(0.5), s(0.075)];
  const right = [s(0.915), s(0.4)];
  const bottom = [s(0.5), s(0.945)];
  const left = [s(0.085), s(0.4)];
  const outline = [top, right, bottom, left];

  const girdleL = [s(0.085), s(0.4)];
  const girdleR = [s(0.915), s(0.4)];
  const crownL = [s(0.35), s(0.4)];
  const crownR = [s(0.65), s(0.4)];
  const facets = [
    [girdleL, girdleR],
    [top, crownL],
    [top, crownR],
    [crownL, bottom],
    [crownR, bottom],
  ];

  const drawFacets = size >= 24;
  const facetWidth = size / 32;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cov = polygonCoverage(x, y, outline);
      if (cov <= 0) continue;

      // Gradiente diagonal: teal claro no topo-esquerda, azul no fundo-direita.
      const t = Math.min(1, Math.max(0, (x / size + y / size) / 2));
      let r = Math.round(143 + (42 - 143) * t);
      let g = Math.round(248 + (149 - 248) * t);
      let b = Math.round(228 + (239 - 228) * t);

      if (drawFacets) {
        let near = Infinity;
        for (const [a, bb] of facets) {
          near = Math.min(near, distanceToSegment(x + 0.5, y + 0.5, a, bb));
        }
        // Escurece perto das linhas de faceta, dando volume à pedra.
        const shade = Math.max(0, 1 - near / facetWidth) * 0.5;
        r = Math.round(r * (1 - shade) + 8 * shade);
        g = Math.round(g * (1 - shade) + 30 * shade);
        b = Math.round(b * (1 - shade) + 36 * shade);
      }

      blend(rgba, (y * size + x) * 4, r, g, b, cov);
    }
  }

  return encodePng(size, size, rgba);
}

// ------------------------------------------------------------ ícone do pet

const PET_DIR = path.join(__dirname, 'renderer', 'pet');
const ICON_ROW = 3; // meditação: figura compacta e centrada, a que melhor lê em 16px

/** Menor retângulo que contém pixels visíveis. */
function alphaBounds(bitmap, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bitmap[(y * width + x) * 4 + 3] <= 8) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/**
 * Recorta um quadro do spritesheet e reduz para `size`.
 *
 * Faz média de área em vez de amostrar um pixel: de 192px para 16px cada pixel
 * do destino cobre ~150 da origem, e pegar só um deles produziria um ícone
 * ruidoso e cheio de buracos. A média é ponderada pelo alpha para as bordas
 * não puxarem a cor do vazio transparente.
 */
function makePetIcon(size) {
  let nativeImage;
  try {
    ({ nativeImage } = require('electron'));
  } catch {
    return null; // fora do Electron (testes)
  }

  const sheetPath = path.join(PET_DIR, 'spritesheet.png');
  const manifestPath = path.join(PET_DIR, 'pet.json');
  if (!fs.existsSync(sheetPath) || !fs.existsSync(manifestPath)) return null;

  let frameSize;
  try {
    frameSize = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).frame;
  } catch {
    return null;
  }

  const sheet = nativeImage.createFromPath(sheetPath);
  if (sheet.isEmpty()) return null;

  const frame = sheet.crop({
    x: 0,
    y: ICON_ROW * frameSize.height,
    width: frameSize.width,
    height: frameSize.height,
  });
  const { width: fw, height: fh } = frame.getSize();
  const src = frame.toBitmap(); // BGRA
  if (src.length !== fw * fh * 4) return null;

  const box = alphaBounds(src, fw, fh);
  if (!box) return null;

  // Quadrado centrado na figura: redimensionar um retângulo alto para um
  // quadrado a esmagaria.
  const boxW = box.maxX - box.minX + 1;
  const boxH = box.maxY - box.minY + 1;
  const span = Math.max(boxW, boxH);
  const originX = box.minX - (span - boxW) / 2;
  const originY = box.minY - (span - boxH) / 2;

  const out = Buffer.alloc(size * size * 4, 0);
  const step = span / size;

  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      const x0 = originX + ox * step;
      const y0 = originY + oy * step;
      let r = 0;
      let g = 0;
      let b = 0;
      let alphaSum = 0;
      let samples = 0;

      for (let sy = Math.floor(y0); sy < Math.ceil(y0 + step); sy++) {
        for (let sx = Math.floor(x0); sx < Math.ceil(x0 + step); sx++) {
          samples++;
          if (sx < 0 || sy < 0 || sx >= fw || sy >= fh) continue; // fora = transparente
          const i = (sy * fw + sx) * 4;
          const a = src[i + 3] / 255;
          b += src[i] * a;
          g += src[i + 1] * a;
          r += src[i + 2] * a;
          alphaSum += a;
        }
      }

      if (!samples) continue;
      const o = (oy * size + ox) * 4;
      out[o] = alphaSum ? Math.round(r / alphaSum) : 0;
      out[o + 1] = alphaSum ? Math.round(g / alphaSum) : 0;
      out[o + 2] = alphaSum ? Math.round(b / alphaSum) : 0;
      out[o + 3] = Math.round((alphaSum / samples) * 255);
    }
  }

  return encodePng(size, size, out);
}

/** PNG do ícone: o pet quando disponível, a gema como reserva. */
function appIcon(size) {
  return makePetIcon(size) || makeIcon(size);
}

module.exports = { appIcon, makeIcon, makePetIcon, encodePng };
