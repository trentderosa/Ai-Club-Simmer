import express from 'express';
import { loadConfig } from './config.js';
import { createOllamaClient } from './services/ollama-client.js';
import { createSupabaseStub, isStubAuthAllowed } from './services/supabase.js';
import { createRecipeRouter } from './routes/recipe.js';

const config = loadConfig();

const app = express();

// Trust proxy for correct client IP behind reverse proxies (nginx, cloudflare tunnel, etc.)
// This ensures rate limiting uses the real client IP, not the proxy's IP.
// Set TRUST_PROXY=true when deploying behind a reverse proxy.
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

app.use(express.json());

const ollamaClient = createOllamaClient(config.ollama);

// SECURITY: Stub auth fails closed by default. Only enabled when
// ALLOW_STUB_AUTH=true AND NODE_ENV is not 'production'.
const supabase = createSupabaseStub({
  allowStubAuth: isStubAuthAllowed(),
});

const recipeRouter = createRecipeRouter(
  {
    ollamaClient,
    supabase,
  },
  {
    enablePreviewRoute: config.enablePreviewRoute,
    rateLimit: config.rateLimit,
  }
);

app.use('/api/recipes', recipeRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(config.port, config.host, () => {
  console.info(`Simmer AI Server running on http://${config.host}:${config.port}`);
  console.info(`Ollama endpoint: ${config.ollama.baseUrl}`);
  console.info(`Model: ${config.ollama.model}`);
  console.info(`Preview route: ${config.enablePreviewRoute ? 'ENABLED' : 'disabled'}`);
  console.info(`Stub auth: ${isStubAuthAllowed() ? 'ENABLED (dev only)' : 'disabled'}`);
});
