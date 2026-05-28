const express = require('express');
const { chat, SYSTEM_PROMPT } = require('../services/openai');

const router = express.Router();

// GET /chat/prompt — retorna o system prompt padrão
router.get('/prompt', (_req, res) => {
  res.json({ ok: true, prompt: SYSTEM_PROMPT });
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
router.post('/', async (req, res) => {
  const { messages, system_prompt } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: 'Campo "messages" é obrigatório e deve ser um array' });
  }

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage?.content || lastMessage.role !== 'user') {
    return res.status(400).json({ ok: false, error: 'A última mensagem deve ter role "user" e content preenchido' });
  }

  try {
    const result = await chat(messages, system_prompt || null);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
