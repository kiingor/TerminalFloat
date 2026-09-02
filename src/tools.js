'use strict';

/**
 * Definição neutra das ferramentas (JSON Schema). Cada provider converte para
 * o próprio formato em providers/*.js.
 */
function buildTools(vaultSet) {
  const ids = vaultSet.vaults.map((v) => v.id);
  const vaultParam = {
    type: 'string',
    enum: ids,
    description: vaultSet.vaults.map((v) => `"${v.id}" = ${v.name}`).join('; '),
  };

  return [
    {
      name: 'search_vault',
      description:
        'Busca por palavras-chave nas notas do Obsidian e devolve os trechos mais relevantes. ' +
        'Use SEMPRE que a pergunta depender de algo anotado pelo usuário (projetos, tarefas, ' +
        'contas, servidores, credenciais, decisões). Prefira 2–4 palavras-chave específicas em vez ' +
        'da pergunta inteira. Se a primeira busca não trouxer o que precisa, tente outros termos.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Palavras-chave a procurar.' },
          vault: { ...vaultParam, description: `${vaultParam.description}. Omita para buscar em todos.` },
          limit: { type: 'integer', description: 'Máximo de notas a retornar (padrão 6).' },
        },
        required: ['query'],
      },
    },
    {
      name: 'read_note',
      description:
        'Lê o conteúdo completo de uma nota. Use depois de search_vault quando o trecho retornado ' +
        'não for suficiente, ou quando você já souber o caminho exato da nota.',
      input_schema: {
        type: 'object',
        properties: {
          vault: vaultParam,
          path: { type: 'string', description: 'Caminho relativo dentro do cofre, ex.: "01 - Contas/Google.md".' },
        },
        required: ['vault', 'path'],
      },
    },
    {
      name: 'list_notes',
      description:
        'Lista os caminhos das notas de um cofre. Use para se orientar na estrutura de pastas ' +
        'antes de criar uma nota nova, ou quando a busca por palavra-chave não achar nada.',
      input_schema: {
        type: 'object',
        properties: {
          vault: vaultParam,
          folder: { type: 'string', description: 'Filtra por prefixo de pasta, ex.: "03 - Tokens e APIs".' },
        },
        required: ['vault'],
      },
    },
    {
      name: 'write_note',
      description:
        'Cria, sobrescreve ou acrescenta conteúdo a uma nota do Obsidian. O usuário aprova cada ' +
        'escrita antes dela acontecer. Escreva em Markdown, seguindo as convenções do cofre ' +
        '(frontmatter YAML e links [[wiki]] quando as notas vizinhas usarem). Ao adicionar algo a ' +
        'uma nota existente prefira mode="append"; só use "overwrite" quando for reescrever mesmo.',
      input_schema: {
        type: 'object',
        properties: {
          vault: vaultParam,
          path: { type: 'string', description: 'Caminho relativo, ex.: "Tarefas do Dia/2026-08-13.md".' },
          content: { type: 'string', description: 'Conteúdo Markdown a gravar.' },
          mode: {
            type: 'string',
            enum: ['create', 'overwrite', 'append'],
            description: 'create = nota nova (falha se existir); overwrite = substitui; append = adiciona ao fim.',
          },
        },
        required: ['vault', 'path', 'content', 'mode'],
      },
    },
  ];
}

function systemPrompt(vaultSet) {
  const today = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const vaultLines = vaultSet.summary().map((v) => {
    const flags = [`${v.notes} notas`];
    if (v.sensitive) flags.push('CONTÉM CREDENCIAIS');
    if (!v.writable) flags.push('somente leitura');
    return `- id "${v.id}" — ${v.name} (${flags.join(', ')})`;
  });

  return `Você é o assistente pessoal do Filipe, embutido num chat flutuante no desktop dele e ligado direto ao cofre Obsidian.

Hoje é ${today}.

Cofres disponíveis:
${vaultLines.join('\n')}

Como trabalhar:
- Antes de responder qualquer coisa sobre as anotações, projetos, contas ou infraestrutura do Filipe, use search_vault. Não responda de memória sobre o conteúdo do cofre.
- Se a primeira busca vier vazia ou fraca, tente outros termos ou use list_notes para ver a estrutura antes de desistir.
- Cite as notas que embasaram a resposta pelo caminho, ex.: "(01 - Contas/Google.md)".
- Se a informação simplesmente não estiver no cofre, diga isso claramente em vez de inventar.
- Ao escrever no cofre, siga o estilo das notas vizinhas: leia uma nota parecida antes de criar uma nova.
- Quando o Filipe pedir para gravar algo, chame write_note direto. Não peça permissão por escrito nem mostre um rascunho antes: a interface já abre um cartão de aprovação com o caminho e o conteúdo completo, e nada vai para o disco sem ele clicar. Pedir de novo no texto só duplica o trabalho dele.

Sobre o "Cofre de Acessos": ele guarda senhas, tokens e dados de servidores. Pode consultá-lo normalmente quando a pergunta for sobre isso, mas não traga segredos para a conversa sem necessidade — se a pergunta for "onde está X", responda onde está, sem colar a credencial inteira; se o Filipe pedir o valor explicitamente, aí sim mostre.

Formato das respostas: a janela é estreita (cerca de 400px). Responda direto ao ponto, em português do Brasil, sem preâmbulo. Parágrafos curtos, listas quando ajudarem. Nada de repetir a pergunta antes de responder.`;
}

/** Executor das ferramentas. `confirmWrite` recebe o pedido e resolve true/false. */
function makeExecutor({ vaultSet, confirmWrite, requireConfirm }) {
  return async function execute(name, input) {
    switch (name) {
      case 'search_vault': {
        const hits = vaultSet.search(input.query, {
          vault: input.vault,
          limit: Math.min(Math.max(input.limit || 6, 1), 15),
        });
        if (!hits.length) return { results: [], hint: 'Nenhuma nota encontrada. Tente outras palavras-chave ou use list_notes.' };
        return { results: hits };
      }

      case 'read_note': {
        const vault = vaultSet.get(input.vault);
        return await vault.read(input.path);
      }

      case 'list_notes': {
        const vault = vaultSet.get(input.vault);
        const notes = vault.list(input.folder);
        return { vault: vault.id, count: notes.length, notes };
      }

      case 'write_note': {
        const vault = vaultSet.get(input.vault);
        const mode = input.mode || 'create';
        if (requireConfirm) {
          const approved = await confirmWrite({
            vault: vault.id,
            vaultName: vault.name,
            sensitive: vault.sensitive,
            path: input.path,
            mode,
            content: input.content,
          });
          if (!approved) {
            return { written: false, reason: 'O usuário recusou esta escrita. Não tente de novo sem que ele peça.' };
          }
        }
        const result = await vault.write(input.path, input.content, mode);
        return { written: true, ...result };
      }

      default:
        throw new Error(`Ferramenta desconhecida: ${name}`);
    }
  };
}

module.exports = { buildTools, systemPrompt, makeExecutor };
