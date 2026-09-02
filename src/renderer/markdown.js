'use strict';
// Markdown mínimo, suficiente para respostas de chat. Escapa HTML antes de
// qualquer coisa — nada do que o modelo escreve vira markup arbitrário.
(function (global) {
  // Sentinela para proteger código inline durante as outras substituições.
  // Construído em runtime para não haver byte de controle no fonte.
  const S = String.fromCharCode(1);
  const RESTORE = new RegExp(S + '(\\d+)' + S, 'g');

  const escapeHtml = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  function inline(text) {
    const codes = [];
    let out = text.replace(/`([^`\n]+)`/g, (_m, code) => {
      codes.push(code);
      return S + (codes.length - 1) + S;
    });

    out = out
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, alias) => {
        const label = alias || target;
        return `<span class="wikilink" data-note="${target}">${label}</span>`;
      })
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/(^|[^*])\*\*([^*]+)\*\*/g, '$1<strong>$2</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?;:])/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');

    return out.replace(RESTORE, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  }

  function render(src) {
    const lines = escapeHtml(src || '').split('\n');
    const html = [];
    let listType = null;
    let inCode = false;
    let codeBuffer = [];
    let paragraph = [];

    const flushParagraph = () => {
      if (paragraph.length) {
        html.push(`<p>${inline(paragraph.join(' '))}</p>`);
        paragraph = [];
      }
    };
    const closeList = () => {
      if (listType) {
        html.push(`</${listType}>`);
        listType = null;
      }
    };

    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (inCode) {
          html.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`);
          codeBuffer = [];
          inCode = false;
        } else {
          flushParagraph();
          closeList();
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        codeBuffer.push(line);
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        closeList();
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        closeList();
        const level = Math.min(heading[1].length + 1, 6);
        html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }

      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        flushParagraph();
        closeList();
        html.push('<hr />');
        continue;
      }

      // "&gt;" porque o HTML já foi escapado acima
      const quote = line.match(/^\s*&gt;\s?(.*)$/);
      if (quote) {
        flushParagraph();
        closeList();
        html.push(`<blockquote>${inline(quote[1])}</blockquote>`);
        continue;
      }

      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        flushParagraph();
        const want = bullet ? 'ul' : 'ol';
        if (listType !== want) {
          closeList();
          html.push(`<${want}>`);
          listType = want;
        }
        html.push(`<li>${inline((bullet || numbered)[1])}</li>`);
        continue;
      }

      closeList();
      paragraph.push(line.trim());
    }

    if (inCode && codeBuffer.length) html.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`);
    flushParagraph();
    closeList();
    return html.join('');
  }

  global.md = { render, escapeHtml };
})(window);
