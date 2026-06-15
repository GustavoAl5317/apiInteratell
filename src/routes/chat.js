const express = require('express');
const { chat, SYSTEM_PROMPT, resolvePrompt, formatForWhatsapp } = require('../services/openai');
const TTLCache = require('../utils/cache');

const router = express.Router();

// Histórico de conversas por telefone (canal WhatsApp), expira após 30 min de inatividade
const whatsappSessions = new TTLCache(30 * 60 * 1000);
const MAX_HISTORY = 20; // últimas N mensagens mantidas por conversa

// GET /chat/prompt — retorna o system prompt padrão
router.get('/prompt', (_req, res) => {
  res.json({ ok: true, prompt: resolvePrompt(SYSTEM_PROMPT, null) });
});

// GET /chat?q=qual o status do chamado 123?
router.get('/', async (req, res) => {
  const { q } = req.query;

  if (!q || !q.trim()) {
    return res.status(400).json({ ok: false, error: 'Parâmetro "q" é obrigatório. Ex: /chat?q=qual o status do chamado 1?' });
  }

  try {
    const result = await chat([{ role: 'user', content: q.trim() }]);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
});

// POST /chat
// Body: { messages: [...], system_prompt?: "..." }
// system_prompt só é aceito se o header "x-admin-key" corresponder a ADMIN_KEY no .env.
// Sem isso, qualquer cliente poderia sobrescrever as regras de verificação de identidade.
router.post('/', async (req, res) => {
  const { messages, system_prompt } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: 'Campo "messages" é obrigatório e deve ser um array' });
  }

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage?.content || lastMessage.role !== 'user') {
    return res.status(400).json({ ok: false, error: 'A última mensagem deve ter role "user" e content preenchido' });
  }

  let customPrompt = null;
  if (system_prompt) {
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey || req.get('x-admin-key') !== adminKey) {
      return res.status(403).json({ ok: false, error: 'Customização de "system_prompt" requer header "x-admin-key" válido' });
    }
    customPrompt = system_prompt;
  }

  try {
    const result = await chat(messages, customPrompt);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
});

// POST /chat/whatsapp
// Body: { from_phone: "5511999999999", message: "texto do usuário" }
// Mantém o histórico da conversa por telefone (em memória, TTL de 30min) e
// já injeta o telefone do remetente no fluxo de verificação de identidade,
// evitando que o bot peça esse dado ao usuário.
router.post('/whatsapp', async (req, res) => {
  const { from_phone, message } = req.body;

  if (!from_phone || !String(from_phone).trim()) {
    return res.status(400).json({ ok: false, error: 'Campo "from_phone" é obrigatório' });
  }
  if (!message || !String(message).trim()) {
    return res.status(400).json({ ok: false, error: 'Campo "message" é obrigatório' });
  }

  const phone = String(from_phone).trim();
  const history = whatsappSessions.get(phone) ?? [];
  history.push({ role: 'user', content: String(message).trim() });

  try {
    const result = await chat(history, null, phone);
    const { _logs, ...data } = result;

    history.push({ role: 'assistant', content: JSON.stringify(data) });
    whatsappSessions.set(phone, history.slice(-MAX_HISTORY));

    return res.json({ ok: true, reply: formatForWhatsapp(data) });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
