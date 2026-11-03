import express from 'express';
import { loadConfig } from './config.js';
import { createOllamaClient } from './services/ollama-client.js';
import { createSupabaseStub } from './services/supabase.js';
import { createRecipeRouter } from './routes/recipe.js';

const config = loadConfig();

const app = express();
app.use(express.json());

const ollamaClient = createOllamaClient(config.ollama);
const supabase = createSupabaseStub();

const recipeRouter = createRecipeRouter({
  ollamaClient,
  supabase,
});

app.use('/api/recipes', recipeRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(config.port, config.host, () => {
  console.info(`Simmer AI Server running on http://${config.host}:${config.port}`);
  console.info(`Ollama endpoint: ${config.ollama.baseUrl}`);
  console.info(`Model: ${config.ollama.model}`);
});
