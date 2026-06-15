require('dotenv').config();

// ── Validação de variáveis de ambiente ────────────────────────────────────────
const REQUIRED_ENV = ['BITRIX_WEBHOOK_URL', 'OPENAI_API_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`\n❌ Variáveis de ambiente ausentes no .env: ${missing.join(', ')}`);
  console.error('   Configure o arquivo .env antes de iniciar a API.\n');
  process.exit(1);
}

const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const tasksRouter = require('./routes/tasks');
const chatRouter  = require('./routes/chat');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',  // defina CORS_ORIGIN no .env para restringir
  methods: ['GET', 'POST'],
}));

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,  // janela de 1 minuto
  max: 30,              // máximo 30 requisições por minuto por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Muitas requisições. Aguarde 1 minuto e tente novamente.' },
});
app.use('/chat', limiter);
app.use('/tasks', limiter);

// ── Body Parser ───────────────────────────────────────────────────────────────
app.use(express.json());

// ── Autenticação opcional de /tasks e /chat ──────────────────────────────────
// Se API_KEY estiver definida no .env, exige header "x-api-key" para acessar essas rotas.
// Mantém as rotas abertas caso API_KEY não seja configurada (compatibilidade com setups existentes).
if (process.env.API_KEY) {
  const requireApiKey = (req, res, next) => {
    if (req.get('x-api-key') !== process.env.API_KEY) {
      return res.status(401).json({ ok: false, error: 'Header "x-api-key" inválido ou ausente' });
    }
    next();
  };
  app.use('/tasks', requireApiKey);
  app.use('/chat', requireApiKey);
}

// ── Logging básico ────────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${req.method} ${req.path}`);
  next();
});

// ── Frontend ──────────────────────────────────────────────────────────────────
app.use(express.static(require('path').join(__dirname, '../public')));

// ── Rotas ─────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.use('/tasks', tasksRouter);
app.use('/chat', chatRouter);

// ── Erro global ───────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Erro não tratado:', err.message);
  res.status(500).json({ ok: false, error: 'Erro interno do servidor' });
});

app.listen(PORT, () => {
  console.log(`\n✅ API rodando em http://localhost:${PORT}`);
  console.log(`   Bitrix: ${process.env.BITRIX_WEBHOOK_URL?.substring(0, 40)}...`);
  console.log(`   Rate limit: 30 req/min por IP\n`);
});
