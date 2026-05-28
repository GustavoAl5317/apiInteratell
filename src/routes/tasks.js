const express = require('express');
const { getTask, listTasks, createTask } = require('../services/bitrix');

const router = express.Router();

// GET /tasks?status=abertos&date_from=2026-01-01&date_to=2026-01-31&company_id=42
router.get('/', async (req, res) => {
  const { status, date_from, date_to, company_id } = req.query;

  const validStatuses = ['abertos', 'concluidos', 'todos'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ ok: false, error: `Status inválido. Use: ${validStatuses.join(', ')}` });
  }

  try {
    const result = await listTasks({ status, date_from, date_to, company_id });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
});

// GET /tasks/:id
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ ok: false, error: 'ID da tarefa inválido' });
  }

  try {
    const task = await getTask(id);
    return res.json({ ok: true, task });
  } catch (err) {
    const isNotFound = err.message === 'Tarefa não encontrada';
    return res.status(isNotFound ? 404 : 502).json({ ok: false, error: err.message });
  }
});

// POST /tasks
// Body: { title, description?, responsible_id?, deadline? }
router.post('/', async (req, res) => {
  const { title, description, responsible_id, deadline } = req.body;

  if (!title || !String(title).trim()) {
    return res.status(400).json({ ok: false, error: 'Campo "title" é obrigatório' });
  }

  try {
    const task = await createTask({ title, description, responsible_id, deadline });
    return res.status(201).json({ ok: true, task });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
