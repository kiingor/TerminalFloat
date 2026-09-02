'use strict';
const Anthropic = require('@anthropic-ai/sdk');

const MAX_TOKENS = 32000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Histórico canônico -> formato Anthropic. */
function toAnthropicMessages(history) {
  const out = [];
  for (const msg of history) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: msg.content }] });
      continue;
    }

    if (msg.role === 'assistant') {
      // Replay verbatim dos blocos originais — preserva thinking e assinaturas.
      if (msg.raw?.anthropic) {
        out.push({ role: 'assistant', content: msg.raw.anthropic });
        continue;
      }
      const content = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const call of msg.toolCalls || []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      }
      if (content.length) out.push({ role: 'assistant', content });
      continue;
    }

    if (msg.role === 'tool') {
      // Resultados consecutivos precisam vir agrupados numa única mensagem de user.
      const block = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: msg.content,
        ...(msg.isError ? { is_error: true } : {}),
      };
      const last = out[out.length - 1];
      const lastIsToolResults =
        last?.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.length > 0 &&
        last.content.every((b) => b.type === 'tool_result');
      if (lastIsToolResults) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

const toAnthropicTools = (tools) =>
  tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));

/**
 * Uma volta do modelo — pode terminar em texto ou em pedidos de ferramenta.
 * Emite deltas via onEvent e devolve a mensagem do assistente já normalizada.
 */
async function turn({ apiKey, model, effort, system, tools, history, onEvent, signal }) {
  const client = new Anthropic({ apiKey });
  const base = {
    model,
    max_tokens: MAX_TOKENS,
    system,
    tools: toAnthropicTools(tools),
    messages: toAnthropicMessages(history),
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort },
  };

  // Primeira tentativa com `fallbacks`: perguntas sobre o cofre de credenciais
  // podem encostar em classificadores de política, e o fallback re-serve a
  // requisição em outro modelo dentro da mesma chamada.
  let emitted = false;
  const tracked = (event) => {
    emitted = true;
    onEvent(event);
  };

  try {
    const stream = client.beta.messages.stream(
      { ...base, betas: [FALLBACK_BETA], fallbacks: 'default' },
      { signal }
    );
    return await consume(stream, tracked);
  } catch (err) {
    // Se já streamou conteúdo, o erro é real — não é incompatibilidade de beta.
    if (emitted || !looksUnsupported(err)) throw err;
  }

  const stream = client.messages.stream(base, { signal });
  return await consume(stream, onEvent);
}

/** Distingue "esta versão da API/SDK não conhece o beta" de um erro de verdade. */
function looksUnsupported(err) {
  if (err?.name === 'AbortError') return false;
  if (err?.kind === 'refusal') return false;
  const status = err?.status;
  if (status && status !== 400 && status !== 404) return false;
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('fallback') ||
    msg.includes('beta') ||
    msg.includes('unexpected') ||
    msg.includes('unrecognized') ||
    msg.includes('is not a function') ||
    msg.includes('cannot read')
  );
}

async function consume(stream, onEvent) {
  for await (const event of stream) {
    if (event.type !== 'content_block_delta') continue;
    if (event.delta.type === 'text_delta') onEvent({ type: 'text', delta: event.delta.text });
    else if (event.delta.type === 'thinking_delta') onEvent({ type: 'thinking', delta: event.delta.thinking });
  }

  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category || 'não informada';
    const error = new Error(
      `O Claude recusou responder (categoria: ${category}). Isso pode acontecer em perguntas sobre ` +
        `credenciais e infraestrutura. Reformule, ou troque para o OpenAI nas configurações.`
    );
    error.kind = 'refusal';
    throw error;
  }

  return {
    role: 'assistant',
    content: message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(''),
    toolCalls: message.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input })),
    raw: { anthropic: message.content },
    usage: message.usage,
    stopReason: message.stop_reason,
  };
}

module.exports = { turn, id: 'anthropic', label: 'Claude' };
