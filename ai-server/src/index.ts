import express from 'express';
import { loadConfig } from './config.js';
import { createOllamaClient } from './services/ollama-client.js';
import { createSupabaseStub, isStubAuthAllowed } from './services/supabase.js';
import { createRecipeRouter } from './routes/recipe.js';

const config = loadConfig();

const app = express();
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
