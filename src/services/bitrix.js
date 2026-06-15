const axios = require('axios');
const TTLCache = require('../utils/cache');

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;

const TASK_STATUS = {
  1: 'Nova',
  2: 'Pendente',
  3: 'Em andamento',
  4: 'Concluída',
  5: 'Aprovada',
  6: 'Adiada',
  7: 'Recusada',
};

const OPEN_STATUSES = [1, 2, 3];

const SMART_PROCESSES = {
  contratos: 175,
  contrato: 175,
  financeiro: 150,
  pmo: 134,
  servicos: 185,
  'serviços': 185,
  'inside sales': 129,
  kickoff: 1040,
  'kickoff interno': 1040,
  renovacoes: 1034,
  'renovações': 1034,
  engenharia: 178,
};

// ── Caches ────────────────────────────────────────────────────────────────────
const companyCache = new TTLCache(5 * 60 * 1000);   // 5 min
const stageCache   = new TTLCache(10 * 60 * 1000);  // 10 min
// userCache sem TTL — nomes de usuário mudam raramente; persiste em memória
const userCache = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function bx(method, params = {}) {
  const res = await axios.post(`${BITRIX_WEBHOOK_URL}/${method}.json`, params);
  return res.data;
}

/** Salva responsáveis das tarefas no cache de usuários para uso nos Smart Items. */
function cacheUsersFromTasks(tasks) {
  for (const t of tasks) {
    if (t.responsible?.id && t.responsible?.name) {
      userCache.set(String(t.responsible.id), t.responsible.name);
    }
  }
}

/** Resolve nome do responsável pelo ID usando o cache populado pelas tarefas. */
function resolveUserName(id) {
  if (!id) return null;
  return userCache.get(String(id)) ?? `Usuário ${id}`;
}

/**
 * Resolve nomes dos estágios a partir dos stageIds dos itens.
 * stageId formato: "DT175_17:NEW" → busca ENTITY_ID "DYNAMIC_175_STAGE_17"
 */
async function getStageMap(stageIds = []) {
  // Extrai prefixos únicos: "DT175_17:NEW" → "DT175_17"
  const prefixes = [...new Set(stageIds.map((id) => id?.split(':')?.[0]).filter(Boolean))];

  // Converte "DT175_17" → "DYNAMIC_175_STAGE_17"
  const entityIds = prefixes
    .map((p) => { const m = p.match(/^DT(\d+)_(\d+)$/); return m ? `DYNAMIC_${m[1]}_STAGE_${m[2]}` : null; })
    .filter(Boolean);

  if (entityIds.length === 0) return {};

  const stageLists = await Promise.all(
    entityIds.map((entityId) =>
      stageCache.getOrSet(`stage_${entityId}`, async () => {
        try {
          const res = await bx('crm.status.list', { filter: { ENTITY_ID: entityId } });
          return res.result ?? [];
        } catch { return []; }
      })
    )
  );

  return Object.fromEntries(stageLists.flat().map((s) => [s.STATUS_ID, s.NAME]));
}

async function resolveCompanies(crmEntities = []) {
  const ids = crmEntities
    .filter((e) => typeof e === 'string' && e.startsWith('CO_'))
    .map((e) => e.replace('CO_', ''));
  if (ids.length === 0) return [];
  const results = await Promise.all(
    ids.map(async (id) =>
      companyCache.getOrSet(`company_${id}`, async () => {
        try {
          const res = await bx('crm.company.get', { id });
          return res.result ? { id, title: res.result.TITLE } : null;
        } catch { return null; }
      })
    )
  );
  return results.filter(Boolean);
}

async function resolveDeals(crmEntities = []) {
  const ids = crmEntities
    .filter((e) => typeof e === 'string' && e.startsWith('D_'))
    .map((e) => e.replace('D_', ''));
  if (ids.length === 0) return [];
  const results = await Promise.all(
    ids.map((id) =>
      companyCache.getOrSet(`deal_${id}`, async () => {
        try {
          const res = await bx('crm.deal.get', { id });
          const d = res.result;
          return d ? { id, title: d.TITLE, stage: d.STAGE_ID } : null;
        } catch { return null; }
      })
    )
  );
  return results.filter(Boolean);
}

// ── Tarefas ───────────────────────────────────────────────────────────────────

async function getTask(taskId) {
  const res = await bx('tasks.task.get', {
    taskId,
    select: ['ID', 'TITLE', 'STATUS', 'RESPONSIBLE', 'CREATOR',
             'CREATED_DATE', 'DEADLINE', 'DESCRIPTION', 'UF_CRM_TASK'],
  });
  const task = res.result?.task;
  if (!task) throw new Error('Tarefa não encontrada');

  // Popula cache de usuários
  if (task.responsible?.id) userCache.set(String(task.responsible.id), task.responsible.name);
  if (task.creator?.id)     userCache.set(String(task.creator.id), task.creator.name);

  const crmEntities = task.ufCrmTask ?? [];
  const [companies, deals] = await Promise.all([
    resolveCompanies(crmEntities),
    resolveDeals(crmEntities),
  ]);

  return {
    id: task.id,
    title: task.title,
    status: TASK_STATUS[task.status] ?? `Desconhecido (${task.status})`,
    statusCode: Number(task.status),
    responsible: task.responsible?.name ?? null,
    responsibleId: task.responsible?.id ?? null,
    createdBy: task.creator?.name ?? null,
    deadline: task.deadline ?? null,
    createdAt: task.createdDate ?? null,
    description: task.description ?? null,
    empresasVinculadas: companies,
    contratosVinculados: deals,
  };
}

async function listTasks({ status, date_from, date_to, company_id } = {}) {
  const filter = {};
  if (status === 'abertos')    filter.STATUS = OPEN_STATUSES;
  else if (status === 'concluidos') filter.STATUS = [4, 5];
  if (date_from)   filter['>=CREATED_DATE'] = date_from;
  if (date_to)     filter['<=CREATED_DATE'] = date_to;
  if (company_id)  filter['UF_CRM_TASK'] = `CO_${company_id}`;

  const select = ['ID', 'TITLE', 'STATUS', 'RESPONSIBLE_ID', 'RESPONSIBLE', 'CREATED_DATE', 'DEADLINE'];

  let all = [];
  let start = 0;
  while (true) {
    const res = await bx('tasks.task.list', { filter, select, order: { CREATED_DATE: 'DESC' }, start });
    const tasks = res.result?.tasks ?? [];
    all = all.concat(tasks);
    const total = res.total ?? 0;
    start += tasks.length;
    if (all.length >= total || tasks.length === 0 || all.length >= 500) break;
  }

  // Popula cache de usuários com todos os responsáveis encontrados
  cacheUsersFromTasks(all);

  // Filtro de data client-side (garante precisão ao combinar com UF_CRM_TASK)
  if (date_from || date_to) {
    const from = date_from ? new Date(date_from) : null;
    const to   = date_to   ? new Date(date_to + 'T23:59:59') : null;
    all = all.filter((t) => {
      const d = t.createdDate ? new Date(t.createdDate) : null;
      if (!d) return false;
      if (from && d < from) return false;
      if (to   && d > to)   return false;
      return true;
    });
  }

  const tarefas = all.map((task) => ({
    id: task.id,
    title: task.title,
    status: TASK_STATUS[task.status] ?? `Desconhecido (${task.status})`,
    statusCode: Number(task.status),
    responsible: task.responsible?.name ?? null,
    responsibleId: task.responsible?.id ?? null,
    createdAt: task.createdDate ?? null,
    deadline: task.deadline ?? null,
  }));

  const porResponsavel = {};
  for (const t of tarefas) {
    const nome = t.responsible ?? 'Sem responsável';
    porResponsavel[nome] = (porResponsavel[nome] ?? 0) + 1;
  }

  return {
    total: tarefas.length,
    tarefas,
    rankingResponsaveis: Object.entries(porResponsavel)
      .map(([nome, total]) => ({ nome, total }))
      .sort((a, b) => b.total - a.total),
  };
}

async function createTask({ title, description, responsible_id, deadline }) {
  const fields = { TITLE: title };
  if (description)    fields.DESCRIPTION = description;
  if (responsible_id) fields.RESPONSIBLE_ID = responsible_id;
  if (deadline)       fields.DEADLINE = deadline;

  const res = await bx('tasks.task.add', { fields });
  const task = res.result?.task;
  if (!task) throw new Error('Falha ao criar tarefa no Bitrix24');
  return { id: task.id, title: task.title, status: TASK_STATUS[task.status] ?? 'Nova' };
}

// ── Empresas ──────────────────────────────────────────────────────────────────

async function searchCompany(name) {
  return companyCache.getOrSet(`search_${name.toLowerCase()}`, async () => {
    const res = await bx('crm.company.list', {
      filter: { '%TITLE': name },
      select: ['ID', 'TITLE', 'PHONE', 'EMAIL'],
      order: { TITLE: 'ASC' },
    });
    return (res.result ?? []).map((c) => ({
      id: c.ID,
      title: c.TITLE,
      phone: c.PHONE?.[0]?.VALUE ?? null,
      email: c.EMAIL?.[0]?.VALUE ?? null,
    }));
  });
}

// ── Smart Processes ───────────────────────────────────────────────────────────

async function listSmartItems({ process_name, company_id, date_from, date_to } = {}) {
  const key = (process_name ?? '').toLowerCase().trim();
  const entityTypeId = SMART_PROCESSES[key];

  if (!entityTypeId) {
    const available = [...new Set(Object.values(SMART_PROCESSES))].map(
      (id) => Object.keys(SMART_PROCESSES).find((k) => SMART_PROCESSES[k] === id)
    );
    throw new Error(`Smart process "${process_name}" não encontrado. Disponíveis: ${available.join(', ')}`);
  }

  const filter = {};
  if (company_id) filter.companyId = Number(company_id);
  if (date_from)  filter['>=createdTime'] = date_from;
  if (date_to)    filter['<=createdTime'] = date_to;

  // Busca itens com paginação, depois resolve estágios com os IDs reais
  let items = [];
  let start = 0;
  while (true) {
    const res = await bx('crm.item.list', {
      entityTypeId,
      filter,
      select: ['id', 'title', 'stageId', 'createdTime', 'updatedTime', 'companyId', 'assignedById'],
      order: { createdTime: 'DESC' },
      start,
    });
    const batch = res.result?.items ?? [];
    items = items.concat(batch);
    const total = res.total ?? 0;
    start += batch.length;
    if (items.length >= total || batch.length === 0 || items.length >= 500) break;
  }

  // Resolve nomes dos estágios com base nos stageIds reais encontrados
  const stageMap = await getStageMap(items.map((i) => i.stageId));

  return {
    process: process_name,
    total: items.length,
    itens: items.map((item) => ({
      id: item.id,
      title: item.title,
      stage: stageMap[item.stageId] ?? item.stageId,
      // Resolve nome usando cache populado pelas tarefas
      responsible: resolveUserName(item.assignedById),
      createdAt: item.createdTime ?? null,
      updatedAt: item.updatedTime ?? null,
    })),
  };
}

// ── Verificação de cliente ────────────────────────────────────────────────────

/** Normaliza número de telefone: remove tudo que não é dígito e descarta DDI 55 */
function normalizePhone(phone) {
  if (!phone) return '';
  let digits = String(phone).replace(/\D/g, '');
  // Remove DDI 55 se tiver 13 dígitos (55 + DDD + 9 dígitos)
  if (digits.length === 13 && digits.startsWith('55')) digits = digits.slice(2);
  // Remove DDI 55 se tiver 12 dígitos (55 + DDD + 8 dígitos)
  if (digits.length === 12 && digits.startsWith('55')) digits = digits.slice(2);
  return digits;
}

async function getCompanyContacts(companyId) {
  let all = [];
  let start = 0;
  while (true) {
    const res = await bx('crm.contact.list', {
      filter: { COMPANY_ID: companyId },
      select: ['ID', 'NAME', 'LAST_NAME', 'PHONE'],
      start,
    });
    const batch = res.result ?? [];
    all = all.concat(batch);
    const total = res.total ?? 0;
    start += batch.length;
    if (all.length >= total || batch.length === 0) break;
  }
  return all.map((c) => ({
    id: c.ID,
    name: [c.NAME, c.LAST_NAME].filter(Boolean).join(' ').trim(),
    phones: (c.PHONE ?? []).map((p) => normalizePhone(p.VALUE)).filter(Boolean),
  }));
}

/**
 * Verifica se um número de telefone pertence a algum contato de uma empresa.
 * Retorna o contato encontrado ou null.
 */
async function verifyClient({ company_id, phone }) {
  const contacts = await getCompanyContacts(company_id);
  const normalized = normalizePhone(phone);
  const found = contacts.find((c) => c.phones.includes(normalized));
  return found
    ? { verified: true, contact: { id: found.id, name: found.name, phone: normalized } }
    : { verified: false };
}

module.exports = { getTask, listTasks, createTask, searchCompany, listSmartItems, verifyClient };
