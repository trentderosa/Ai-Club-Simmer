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
import { SupabasePathRepository } from './repositories/path-repository.js';
import {
  InMemoryTechniqueVideoCache,
  SupabaseTechniqueVideoCache,
  VideoFinder,
  YouTubeSearchClient,
} from './services/video-finder.js';

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
  videoFinder: VideoFinder | null;
}

/**
 * F4 technique videos: needs YOUTUBE_API_KEY. The cache is the shared
 * technique_videos table when Supabase is configured, else in memory (dev).
 */
function createVideoFinder(): VideoFinder | null {
  if (!config.youtube.apiKey) {
    console.warn('No YOUTUBE_API_KEY - recipes will have no technique videos');
    return null;
  }
  const { url, serviceRoleKey } = config.supabase;
  const cache =
    url && serviceRoleKey
      ? new SupabaseTechniqueVideoCache({ url, serviceRoleKey })
      : new InMemoryTechniqueVideoCache();
  return new VideoFinder(
    cache,
    new YouTubeSearchClient({ apiKey: config.youtube.apiKey, timeoutMs: config.youtube.timeoutMs })
  );
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
      videoFinder: null,
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
      videoFinder: null,
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

  // Path data: slots, onboarding profile, path gating (F2) and badges (F9).
  const pathRepository =
    url && serviceRoleKey ? new SupabasePathRepository({ url, serviceRoleKey }) : undefined;

  const coachNoteGenerator = createCoachNoteGenerator(ollamaClient);
  // XP is awarded only here, server-side, with the service role (never by the client).
  const xpAwarder =
    url && serviceRoleKey
      ? new SupabaseXpAwarder({ url, serviceRoleKey, timeoutMs: config.xpAward.timeoutMs })
      : null;
  const checkInService = new CheckInService(
    checkInRepository,
    coachNoteGenerator,
    xpAwarder,
    console,
    { pathRepository }
  );

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
      pathRepository,
    }),
    jwtVerifier,
    checkInService,
    videoFinder: createVideoFinder(),
  };
}

const services = createServicesFromConfig();

const recipeRouter = createRecipeRouter(
  {
    ollamaClient,
    supabase: services.supabase,
    videoFinder: services.videoFinder,
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
  console.info(`Technique videos: ${services.videoFinder ? 'ENABLED' : 'disabled'}`);
  console.info(`Stub auth: ${isStubAuthAllowed() ? 'ENABLED (dev only)' : 'disabled'}`);
});
