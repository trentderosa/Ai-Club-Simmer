import express from 'express';
import { loadConfig } from './config.js';
import { createOllamaClient } from './services/ollama-client.js';
import {
  createSupabaseService,
  createSupabaseStub,
  isStubAuthAllowed,
} from './services/supabase.js';
import { createJwtVerifier } from './services/jwt-verifier.js';
import { InMemoryUserRecipeRepository } from './repositories/user-recipe-repository.js';
import { SupabaseUserRecipeRepository } from './repositories/supabase-user-recipe-repository.js';
import { createRecipeRouter } from './routes/recipe.js';

const config = loadConfig();

const app = express();

if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

app.use(express.json());

const ollamaClient = createOllamaClient(config.ollama);

function createSupabaseServiceFromConfig(): ReturnType<typeof createSupabaseService> {
  const { jwtSecret, jwksUri, url, serviceRoleKey } = config.supabase;

  if (isStubAuthAllowed()) {
    console.warn('STUB AUTH ENABLED - using stub Supabase service');
    return createSupabaseStub({ allowStubAuth: true });
  }

  if (!jwtSecret && !jwksUri) {
    console.warn(
      'No SUPABASE_JWT_SECRET or SUPABASE_JWKS_URI configured - auth will fail closed'
    );
    return createSupabaseStub({ allowStubAuth: false });
  }

  const jwtVerifier = createJwtVerifier({
    jwtSecret,
    jwksUri,
  });

  const userRecipeRepository =
    url && serviceRoleKey
      ? new SupabaseUserRecipeRepository({ url, serviceRoleKey })
      : new InMemoryUserRecipeRepository();

  if (!url || !serviceRoleKey) {
    console.warn(
      'No SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY - using in-memory recipe storage'
    );
  }

  return createSupabaseService({
    jwtVerifier,
    userRecipeRepository,
  });
}

const supabase = createSupabaseServiceFromConfig();

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
