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

async function chat(messages, customSystemPrompt) {
  const logs = [];
  const history = [{ role: 'system', content: customSystemPrompt || SYSTEM_PROMPT }, ...messages];

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

  return { ...JSON.parse(message.content), _logs: logs };
}

module.exports = { chat, SYSTEM_PROMPT };
