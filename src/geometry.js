'use strict';

/**
 * Cálculo de posição da janela. Isolado do Electron de propósito: é a parte que
 * mais fácil quebra em setup multi-monitor, e assim dá para testar sem abrir a UI.
 */

/** Mantém o retângulo inteiramente dentro da área útil informada. */
function clampTo(bounds, workArea) {
  return {
    width: bounds.width,
    height: bounds.height,
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - bounds.width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - bounds.height),
  };
}

/**
 * Ao recolher, a bolha fica onde estava o canto superior direito da janela —
 * ela "encolhe para o cabeçalho" em vez de saltar pela tela.
 */
function collapsedBounds(current, bubble) {
  return {
    x: current.x + current.width - bubble.width,
    y: current.y,
    width: bubble.width,
    height: bubble.height,
  };
}

/** Ao expandir, o canto superior direito volta a coincidir com o da bolha. */
function expandedBounds(bubbleAt, saved, bubble, min) {
  const width = Math.max(saved.width || min.width, min.width);
  const height = Math.max(saved.height || min.height, min.height);
  return {
    x: bubbleAt.x + bubble.width - width,
    y: bubbleAt.y,
    width,
    height,
  };
}

/**
 * A janela está alcançável pelo mouse? Arrastar é livre de propósito (prender
 * durante o gesto brigaria com o cursor), então ela pode acabar quase toda fora
 * da tela — ou inteira num monitor que foi desconectado depois. Sem barra de
 * tarefas e sem Alt+Tab, isso é uma janela perdida.
 */
function isReachable(bounds, workAreas, margin = 32) {
  const needX = Math.min(margin, bounds.width);
  const needY = Math.min(margin, bounds.height);
  return workAreas.some((area) => {
    const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapX >= needX && overlapY >= needY;
  });
}

/** Centraliza o retângulo na área útil informada, preservando o tamanho. */
function centerIn(bounds, area) {
  return {
    width: bounds.width,
    height: bounds.height,
    x: Math.round(area.x + (area.width - bounds.width) / 2),
    y: Math.round(area.y + (area.height - bounds.height) / 2),
  };
}

module.exports = { clampTo, collapsedBounds, expandedBounds, isReachable, centerIn };
