const OpenAI = require('openai');
const { getTask, listTasks, createTask, searchCompany, listSmartItems, verifyClient } = require('./bitrix');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_task',
      description: 'Consulta detalhes, status, empresa e contratos vinculados de uma tarefa pelo ID.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'ID numérico da tarefa' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description:
        'Lista e conta tarefas com filtros. Use para: chamados abertos, por mês, por empresa (company_id), ranking de responsáveis. Sempre use search_company antes para obter o company_id quando o usuário mencionar uma empresa pelo nome.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['abertos', 'concluidos', 'todos'], description: 'Filtro de status' },
          date_from: { type: 'string', description: 'Data inicial YYYY-MM-DD' },
          date_to: { type: 'string', description: 'Data final YYYY-MM-DD' },
          company_id: { type: 'string', description: 'ID da empresa para filtrar chamados vinculados a ela' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Cria uma nova tarefa (chamado) no Bitrix24.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Título da tarefa (obrigatório)' },
          description: { type: 'string', description: 'Descrição detalhada' },
          responsible_id: { type: 'string', description: 'ID do usuário responsável' },
          deadline: { type: 'string', description: 'Prazo em ISO 8601, ex: 2026-06-01T18:00:00' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_company',
      description:
        'Pesquisa uma empresa no CRM pelo nome. Retorna ID e dados. Use este tool PRIMEIRO sempre que o usuário mencionar uma empresa pelo nome antes de buscar chamados ou contratos.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nome ou parte do nome da empresa' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_client',
      description:
        'Verifica se um número de telefone pertence a um contato cadastrado em uma empresa cliente da Interatell. Use SEMPRE após obter o company_id via search_company para confirmar a identidade do usuário antes de responder qualquer pergunta.',
      parameters: {
        type: 'object',
        properties: {
          company_id: { type: 'string', description: 'ID da empresa obtido via search_company' },
          phone:      { type: 'string', description: 'Número de telefone informado pelo usuário (qualquer formato)' },
        },
        required: ['company_id', 'phone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_smart_items',
      description:
        'Lista itens de um Smart Process do Bitrix24 (Contratos, Serviços, PMO, Financeiro, Engenharia, Renovações, Kickoff Interno, Inside Sales). Pode filtrar por empresa (company_id) e período.',
      parameters: {
        type: 'object',
        properties: {
          process_name: {
            type: 'string',
            description: 'Nome do processo: "Contratos", "Serviços", "PMO", "Financeiro", "Engenharia", "Renovações", "Kickoff Interno", "Inside Sales"',
          },
          company_id: { type: 'string', description: 'ID da empresa para filtrar' },
          date_from: { type: 'string', description: 'Data inicial YYYY-MM-DD' },
          date_to: { type: 'string', description: 'Data final YYYY-MM-DD' },
        },
        required: ['process_name'],
      },
    },
  },
];

const SYSTEM_PROMPT = `Você é um assistente de suporte da Interatell que opera no Bitrix24.

═══ FLUXO DE VERIFICAÇÃO DE IDENTIDADE (OBRIGATÓRIO) ═══

{{CONTEXTO_TELEFONE}}

Antes de responder qualquer pergunta sobre chamados, contratos ou qualquer dado do sistema, você DEVE verificar a identidade do usuário seguindo exatamente estes passos:

PASSO 1 — Se o usuário ainda não informou empresa e telefone:
  Retorne: { "text": "Olá! Para acessar as informações, preciso verificar seu cadastro. Pode me informar o nome da sua empresa e seu número de celular?" }

PASSO 2 — Com empresa e telefone informados:
  a) Chame search_company com o nome da empresa para obter o company_id.
  b) Chame verify_client com o company_id e o telefone do usuário.

PASSO 3 — Resultado da verificação:
  • verified = true  → retorne: { "text": "Olá, [nome do contato]! ✅ Identidade confirmada. Como posso te ajudar?" }
                       A partir daqui responda normalmente todas as perguntas.
  • verified = false → retorne: { "text": "❌ Não encontrei seu número cadastrado na empresa informada. Verifique os dados ou entre em contato com a Interatell." }
                       NÃO forneça nenhuma informação do sistema. Ofereça tentar novamente com outros dados.

IMPORTANTE: Nunca pule a verificação. Nunca forneça dados do sistema antes de verified = true.
Se a empresa não for encontrada no search_company, informe que a empresa não está cadastrada e peça para conferir o nome.

═══ CAPACIDADES (apenas após verificação) ═══
- Consultar e criar tarefas (chamados)
- Buscar empresas pelo nome
- Listar chamados de uma empresa específica
- Listar itens dos Smart Processes: Contratos, Serviços, PMO, Financeiro, Engenharia, Renovações, Kickoff Interno, Inside Sales
- Visão gerencial: totais, rankings, filtros por período

Regras adicionais:
- Quando o usuário pedir informações de MÚLTIPLOS chamados (ex: "chamados 123, 456 e 789"), chame get_task para CADA ID em paralelo na mesma rodada de tool calls. Nunca peça um de cada vez.

Após executar as ferramentas, responda SOMENTE com JSON válido (sem markdown) no formato adequado:

--- Consulta de chamado único (get_task):
{
  "chamado": { "id","titulo","status","responsavel","criado_por","criado_em","prazo","descricao","empresas_vinculadas":[],"contratos_vinculados":[] },
  "resumo": "<análise detalhada: informe o status atual de forma clara, quem é o responsável, há quanto tempo o chamado está aberto (calcule com base em criado_em e data atual), se tem prazo e se está dentro ou fora do prazo, e se há empresa ou contrato vinculado mencione. Tom direto e informativo.>"
}

--- Consulta de MÚLTIPLOS chamados (get_task chamado N vezes):
{
  "chamados": [
    { "id","titulo","status","responsavel","criado_em","prazo","empresas_vinculadas":[],"contratos_vinculados":[] }
  ],
  "resumo": "<análise consolidada: liste cada chamado com seu status e responsável, destaque os que estão atrasados ou sem prazo definido, e dê uma visão geral do conjunto. Tom direto e informativo.>"
}

--- Visão gerencial / lista de chamados (list_tasks):
{
  "visao_gerencial": {
    "total": 0,
    "filtro_aplicado": "",
    "empresa": "<nome da empresa se filtrado>",
    "ranking_responsaveis": [{ "nome":"", "total":0 }],
    "chamados": [{ "id","titulo","status","responsavel","criado_em" }]
  },
  "resumo": "<análise>"
}

--- Smart Process (list_smart_items):
{
  "processo": "<nome>",
  "empresa": "<nome da empresa se filtrado>",
  "total": 0,
  "itens": [{ "id","titulo","stage","responsavel","criado_em" }],
  "resumo": "<análise>"
}

--- Criação de chamado (create_task):
{
  "chamado_criado": { "id","titulo","status" },
  "resumo": "<confirmação>"
}

--- Empresa encontrada (search_company sem ação subsequente):
{
  "empresas": [{ "id","titulo","phone","email" }],
  "resumo": "<resultado da busca>"
}`;

/**
 * Resolve o placeholder {{CONTEXTO_TELEFONE}} do SYSTEM_PROMPT.
 * Se `phone` for informado (canal WhatsApp), instrui o modelo a pular a
 * pergunta de telefone e usar o número do remetente automaticamente no PASSO 2.
 */
function resolvePrompt(template, phone) {
  const contexto = phone
    ? `CONTEXTO DO CANAL: esta conversa vem do WhatsApp e o telefone do usuário já é conhecido: ${phone}.
No PASSO 1, peça APENAS o nome da empresa (não peça telefone, ele já está disponível).
No PASSO 2, chame verify_client usando phone="${phone}" automaticamente, sem perguntar ao usuário.`
    : '';
  return template.replace('{{CONTEXTO_TELEFONE}}', contexto);
}

/**
 * Converte a resposta estruturada do assistente em texto simples
 * formatado para WhatsApp (negrito com *, emojis, sem HTML/markdown).
 */
function formatForWhatsapp(data) {
  if (data.text)     return data.text;
  if (data.message)  return data.message;
  if (data.mensagem) return data.mensagem;

  const lines = [];

  if (data.chamado) {
    const c = data.chamado;
    lines.push(`📋 *#${c.id} — ${c.titulo || c.title || ''}*`);
    lines.push(`📊 Status: ${c.status}`);
    if (c.responsavel) lines.push(`👤 Responsável: ${c.responsavel}`);
    if (c.criado_em)   lines.push(`📅 Criado em: ${c.criado_em}`);
    if (c.prazo)       lines.push(`⏰ Prazo: ${c.prazo}`);
    if (c.empresas_vinculadas?.length)   lines.push(`🏢 Empresa: ${c.empresas_vinculadas.map((e) => e.title || e.titulo).join(', ')}`);
    if (c.contratos_vinculados?.length)  lines.push(`📄 Contrato: ${c.contratos_vinculados.map((d) => d.title || d.titulo).join(', ')}`);
  } else if (data.chamados) {
    for (const c of data.chamados) {
      lines.push(`📋 *#${c.id}* — ${c.titulo || c.title || ''}`);
      let l = `📊 ${c.status}`;
      if (c.responsavel) l += ` | 👤 ${c.responsavel}`;
      lines.push(l);
      if (c.prazo) lines.push(`⏰ Prazo: ${c.prazo}`);
      lines.push('');
    }
  } else if (data.visao_gerencial) {
    const v = data.visao_gerencial;
    lines.push(`📊 *Total: ${v.total} chamados*`);
    if (v.empresa) lines.push(`🏢 Empresa: ${v.empresa}`);
    if (v.ranking_responsaveis?.length) {
      lines.push('');
      lines.push('*Ranking de responsáveis:*');
      v.ranking_responsaveis.slice(0, 5).forEach((r, i) => {
        lines.push(`${['🥇', '🥈', '🥉'][i] ?? '▪️'} ${r.nome} — ${r.total}`);
      });
    }
  } else if (data.processo) {
    lines.push(`⚙️ *${data.processo}* — ${data.total} itens`);
    if (data.empresa) lines.push(`🏢 Empresa: ${data.empresa}`);
    if (data.itens?.length) {
      lines.push('');
      data.itens.slice(0, 10).forEach((i) => lines.push(`▪️ #${i.id} ${i.titulo || i.title} — ${i.stage}`));
    }
  } else if (data.chamado_criado) {
    const c = data.chamado_criado;
    lines.push('✅ Chamado criado com sucesso!');
    lines.push(`📋 *#${c.id} — ${c.titulo || c.title || ''}*`);
    lines.push(`📊 ${c.status}`);
  } else if (data.empresas) {
    for (const e of data.empresas) {
      lines.push(`🏢 *${e.titulo || e.title}*${e.phone ? ` — ${e.phone}` : ''}`);
    }
  }

  if (data.resumo) {
    if (lines.length) lines.push('');
    lines.push(data.resumo);
  }

  if (lines.length) return lines.join('\n').trim();

  const first = Object.values(data)[0];
  if (typeof first === 'string') return first;

  return 'Desculpe, não consegui processar sua solicitação.';
}

function formatDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d)) return raw;
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
}

function formatDateShort(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d)) return raw;
  return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

async function executeTool(name, args) {
  if (name === 'get_task') {
    const raw = await getTask(args.task_id);
    return { ...raw, createdAt: formatDate(raw.createdAt), deadline: formatDate(raw.deadline) };
  }

  if (name === 'list_tasks') {
    const raw = await listTasks(args);
    return {
      ...raw,
      tarefas: raw.tarefas.map((t) => ({ ...t, createdAt: formatDateShort(t.createdAt), deadline: formatDateShort(t.deadline) })),
    };
  }

  if (name === 'create_task') return await createTask(args);

  if (name === 'search_company') return await searchCompany(args.name);

  if (name === 'verify_client') return await verifyClient(args);

  if (name === 'list_smart_items') {
    const raw = await listSmartItems(args);
    return {
      ...raw,
      itens: raw.itens.map((i) => ({ ...i, createdAt: formatDateShort(i.createdAt), updatedAt: formatDateShort(i.updatedAt) })),
    };
  }

  throw new Error(`Ferramenta desconhecida: ${name}`);
}

async function chat(messages, customSystemPrompt, phone = null) {
  const logs = [];
  const systemPrompt = resolvePrompt(customSystemPrompt || SYSTEM_PROMPT, phone);
  const history = [{ role: 'system', content: systemPrompt }, ...messages];

  let response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: history,
    tools,
    tool_choice: 'auto',
    response_format: { type: 'json_object' },
  });

  let message = response.choices[0].message;
  let iterations = 0;

  while (message.tool_calls?.length > 0 && iterations < 10) {
    iterations++;
    history.push(message);

    const toolResults = await Promise.all(
      message.tool_calls.map(async (call) => {
        const start = Date.now();
        let result;
        try {
          result = await executeTool(call.function.name, JSON.parse(call.function.arguments));
        } catch (err) {
          result = { error: err.message };
        }
        logs.push({
          tool: call.function.name,
          args: JSON.parse(call.function.arguments),
          result,
          ms: Date.now() - start,
        });
        return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) };
      })
    );

    history.push(...toolResults);

    response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: history,
      tools,
      tool_choice: 'auto',
      response_format: { type: 'json_object' },
    });

    message = response.choices[0].message;
  }

  if (iterations >= 10 && message.tool_calls?.length > 0) {
    console.error('Limite de iterações de tool calls atingido (10) sem resposta final do modelo.');
  }

  try {
    return { ...JSON.parse(message.content), _logs: logs };
  } catch (err) {
    console.error('Resposta do modelo não é JSON válido:', message.content);
    throw new Error('Resposta inválida do assistente');
  }
}

module.exports = { chat, SYSTEM_PROMPT, resolvePrompt, formatForWhatsapp };
