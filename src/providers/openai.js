'use strict';
const OpenAI = require('openai');

/** Histórico canônico -> formato Chat Completions. */
function toOpenAIMessages(system, history) {
  const out = [{ role: 'system', content: system }];
  for (const msg of history) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const entry = { role: 'assistant', content: msg.content || null };
      if (msg.toolCalls?.length) {
        entry.tool_calls = msg.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        }));
      }
      out.push(entry);
    } else if (msg.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.content });
    }
  }
  return out;
}

const toOpenAITools = (tools) =>
  tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

async function turn({ apiKey, model, baseURL, system, tools, history, onEvent, signal }) {
  // baseURL vazio deixa o SDK usar api.openai.com; preenchido aponta a um
  // gateway compatível.
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });

  let stream;
  try {
    stream = await client.chat.completions.create(
      {
        model,
        messages: toOpenAIMessages(system, history),
        tools: toOpenAITools(tools),
        stream: true,
      },
      { signal }
    );
  } catch (err) {
    const where = baseURL || 'api.openai.com';
    if (err?.status === 404 || /model/i.test(String(err?.message || ''))) {
      const error = new Error(
        `O modelo "${model}" não foi aceito por ${where}. Ajuste o modelo (ou o endpoint) nas ` +
          `configurações. Detalhe: ${err.message}`
      );
      error.kind = 'model';
      throw error;
    }
    if (err?.status === 401) {
      const error = new Error(`Chave rejeitada por ${where}. Confira a chave nas configurações.`);
      error.kind = 'auth';
      throw error;
    }
    throw err;
  }

  let content = '';
  const partial = [];

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      content += delta.content;
      onEvent({ type: 'text', delta: delta.content });
    }
    for (const call of delta.tool_calls || []) {
      const i = call.index ?? 0;
      if (!partial[i]) partial[i] = { id: '', name: '', args: '' };
      if (call.id) partial[i].id = call.id;
      if (call.function?.name) partial[i].name += call.function.name;
      if (call.function?.arguments) partial[i].args += call.function.arguments;
    }
  }

  const toolCalls = partial.filter(Boolean).map((c, i) => {
    let input = {};
    try {
      input = c.args ? JSON.parse(c.args) : {};
    } catch {
      input = { __parse_error: c.args };
    }
    return { id: c.id || `call_${i}`, name: c.name, input };
  });

  return { role: 'assistant', content, toolCalls, raw: {}, stopReason: toolCalls.length ? 'tool_use' : 'end_turn' };
}

module.exports = { turn, id: 'openai', label: 'OpenAI' };
