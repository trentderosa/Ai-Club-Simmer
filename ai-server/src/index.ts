import express from 'express';
import { assertProductionConfig, loadConfig } from './config.js';
import { createOllamaClient } from './services/ollama-client.js';
import {
  createSupabaseService,
  createSupabaseStub,
  isStubAuthAllowed,
} from './services/supabase.js';
import { createJwtVerifier, type JwtVerifier } from './services/jwt-verifier.js';
import { InMemoryUserRecipeRepository } from './repositories/user-recipe-repository.js';
import { SupabaseUserRecipeRepository } from './repositories/supabase-user-recipe-repository.js';
import { createRecipeRouter } from './routes/recipe.js';
import { createCheckInRouter } from './routes/check-in.js';
import { CheckInService } from './services/check-in-service.js';
import { createCoachNoteGenerator } from './services/coach-note.js';
import { InMemoryCheckInRepository } from './repositories/in-memory-check-in-repository.js';
import { SupabaseCheckInRepository } from './repositories/supabase-check-in-repository.js';
import { SupabaseXpAwarder } from './services/xp-awarder.js';

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

interface ServiceConfig {
  supabase: ReturnType<typeof createSupabaseService>;
  jwtVerifier: JwtVerifier | null;
  checkInService: CheckInService | null;
}

function createServicesFromConfig(): ServiceConfig {
  const { jwtSecret, jwksUri, url, serviceRoleKey } = config.supabase;
  const isProduction = process.env.NODE_ENV === 'production';

  // Fail fast at startup with a clear message (names only, never values).
  if (isProduction) {
    assertProductionConfig(config.supabase);
  }

  if (isStubAuthAllowed()) {
    console.warn('STUB AUTH ENABLED - using stub Supabase service');
    return {
      supabase: createSupabaseStub({ allowStubAuth: true }),
      jwtVerifier: null,
      checkInService: null,
    };
  }

  if (!jwtSecret && !jwksUri) {
    console.warn(
      'No SUPABASE_JWT_SECRET or SUPABASE_JWKS_URI configured - auth will fail closed'
    );
    return {
      supabase: createSupabaseStub({ allowStubAuth: false }),
      jwtVerifier: null,
      checkInService: null,
    };
  }

  const jwtVerifier = createJwtVerifier({
    jwtSecret,
    jwksUri,
    issuer: url ? `${url}/auth/v1` : undefined,
    audience: 'authenticated',
  });

  const userRecipeRepository =
    url && serviceRoleKey
      ? new SupabaseUserRecipeRepository({ url, serviceRoleKey })
      : new InMemoryUserRecipeRepository();

  const checkInRepository =
    url && serviceRoleKey
      ? new SupabaseCheckInRepository({ url, serviceRoleKey })
      : new InMemoryCheckInRepository();

  const coachNoteGenerator = createCoachNoteGenerator(ollamaClient);
  // XP is awarded only here, server-side, with the service role (never by the client).
  const xpAwarder =
    url && serviceRoleKey
      ? new SupabaseXpAwarder({ url, serviceRoleKey, timeoutMs: config.xpAward.timeoutMs })
      : null;
  const checkInService = new CheckInService(checkInRepository, coachNoteGenerator, xpAwarder);

  if (!url || !serviceRoleKey) {
    console.warn(
      'No SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY - using in-memory storage (dev only)'
    );
    // N10: In dev mode, the in-memory stores are separate, so check-ins require
    // seeding recipes directly in the check-in repository. This is test-only
    // behavior; production uses shared Supabase tables.
  }

  return {
    supabase: createSupabaseService({
      jwtVerifier,
      userRecipeRepository,
    }),
    jwtVerifier,
    checkInService,
  };
}

const services = createServicesFromConfig();

const recipeRouter = createRecipeRouter(
  {
    ollamaClient,
    supabase: services.supabase,
  },
  {
    enablePreviewRoute: config.enablePreviewRoute,
    rateLimit: config.rateLimit,
  }
);

app.use('/api/recipes', recipeRouter);

// Mount check-in router if JWT verifier and check-in service are available
if (services.jwtVerifier && services.checkInService) {
  const checkInRouter = createCheckInRouter(
    {
      checkInService: services.checkInService,
      jwtVerifier: services.jwtVerifier,
    },
    {
      rateLimit: config.rateLimit,
    }
  );
  app.use('/api/check-ins', checkInRouter);
  console.info('Check-in route: ENABLED');
} else {
  console.warn('Check-in route: DISABLED (no JWT verifier configured)');
}

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
