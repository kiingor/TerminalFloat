'use strict';
const { buildTools, systemPrompt, makeExecutor } = require('./tools');

const PROVIDERS = {
  anthropic: require('./providers/anthropic'),
  openai: require('./providers/openai'),
};

const MAX_TURNS = 10;

/**
 * Roda uma rodada completa de conversa: chama o modelo, executa as ferramentas
 * que ele pedir, devolve os resultados e repete até ele responder em texto.
 *
 * `history` é mutado em memória (é o mesmo array que a janela mantém).
 */
async function run({ history, config, apiKey, vaultSet, onEvent, confirmWrite, signal }) {
  const provider = PROVIDERS[config.provider];
  if (!provider) throw new Error(`Provider desconhecido: ${config.provider}`);

  const tools = buildTools(vaultSet);
  const system = systemPrompt(vaultSet);
  const execute = makeExecutor({
    vaultSet,
    confirmWrite,
    requireConfirm: config.confirmWrites !== false,
  });

  const modelConfig = config[config.provider] || {};

  for (let turnIndex = 0; turnIndex < MAX_TURNS; turnIndex++) {
    if (signal?.aborted) return { stopped: true };

    onEvent({ type: 'turn-start', turn: turnIndex });

    const assistant = await provider.turn({
      apiKey,
      model: modelConfig.model,
      baseURL: modelConfig.baseURL,
      effort: modelConfig.effort || 'medium',
      system,
      tools,
      history,
      onEvent,
      signal,
    });

    history.push(assistant);

    if (!assistant.toolCalls?.length) {
      onEvent({ type: 'done', content: assistant.content });
      return { done: true };
    }

    // Executa as ferramentas em paralelo, exceto escritas (que abrem diálogo e
    // precisam ser aprovadas uma de cada vez, em ordem).
    const results = [];
    const writes = assistant.toolCalls.filter((c) => c.name === 'write_note');
    const reads = assistant.toolCalls.filter((c) => c.name !== 'write_note');

    const runOne = async (call) => {
      onEvent({ type: 'tool-start', id: call.id, name: call.name, input: call.input });
      try {
        const output = await execute(call.name, call.input || {});
        onEvent({ type: 'tool-end', id: call.id, name: call.name, ok: true, output });
        return { call, output, isError: false };
      } catch (err) {
        const message = String(err?.message || err);
        onEvent({ type: 'tool-end', id: call.id, name: call.name, ok: false, output: { error: message } });
        return { call, output: { error: message }, isError: true };
      }
    };

    results.push(...(await Promise.all(reads.map(runOne))));
    for (const call of writes) results.push(await runOne(call));

    // Devolve na ordem original das chamadas — a API exige um resultado por
    // tool_use, e a ordem mantém o histórico legível.
    const byId = new Map(results.map((r) => [r.call.id, r]));
    for (const call of assistant.toolCalls) {
      const r = byId.get(call.id);
      history.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(r.output),
        isError: r.isError,
      });
    }
  }

  onEvent({
    type: 'done',
    content: '(Parei aqui — o limite de passos com ferramentas foi atingido. Pode perguntar de novo de forma mais específica.)',
  });
  return { done: true, exhausted: true };
}

module.exports = { run, PROVIDERS };
