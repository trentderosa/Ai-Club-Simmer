import express from 'express';
import { loadEnvFile } from './load-env.js';
import { assertProductionConfig, loadConfig } from './config.js';
import { applyTrustProxy } from './trust-proxy.js';
import { createCorsMiddleware } from './middleware/cors.js';
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
import { createMasteryRouter } from './routes/mastery.js';
import { SupabaseMasteryRepository, type MasteryRepository } from './repositories/mastery-repository.js';
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
import {
  DishPhotoFinder,
  InMemoryDishPhotoCache,
  SupabaseDishPhotoCache,
  WikimediaCommonsClient,
} from './services/dish-photo.js';
import {
  DishVideoFinder,
  InMemoryDishVideoCache,
  SupabaseDishVideoCache,
  YouTubeDishVideoClient,
} from './services/dish-video-finder.js';
import {
  SupabaseYouTubeQuotaGate,
  type YouTubeQuotaGate,
} from './services/youtube-quota.js';
import { createDishPhotoRouter } from './routes/dish-photos.js';
import { SupabaseKnownDishNames } from './services/known-dish-names.js';
import { InMemoryGeneratedRecipeRepository } from './repositories/in-memory-generated-recipe-repository.js';
import { SupabaseGeneratedRecipeRepository } from './repositories/supabase-generated-recipe-repository.js';
import {
  InMemoryGeneratedCheckInRepository,
} from './repositories/generated-check-in-repository.js';
import { SupabaseGeneratedCheckInRepository } from './repositories/supabase-generated-check-in-repository.js';
import { SupabaseGeneratedXpAwarder } from './services/generated-xp-awarder.js';
import { createCookAnythingRouter } from './routes/cook-anything.js';
import {
  GenerationRateLimiter,
  type CookAnythingGenerationLimiter,
} from './cook-anything/rate-limit.js';
import { SupabaseGenerationRateLimiter } from './cook-anything/supabase-rate-limit.js';
import { mountHealthRoutes } from './health.js';
import { startReconcileScheduler } from './jobs/reconcile-scheduler.js';
import type { GeneratedRecipeRepository } from './repositories/generated-recipe-repository.js';

loadEnvFile();

const config = loadConfig();

const app = express();

// TRUST_PROXY=true trusts X-Forwarded-For only from a loopback peer, which is
// the tunnel process on this laptop. A direct LAN client is not that peer, so
// it cannot spoof req.ip. HOST=127.0.0.1 is the tunnel demo. HOST=0.0.0.0 is
// same-Wi-Fi and stays safe with this setting.
applyTrustProxy(app, process.env.TRUST_PROXY);

// CORS first so browser preflight (OPTIONS) never hits auth or rate limits.
app.use(createCorsMiddleware(config.allowedOrigins));
app.use(express.json());

const ollamaClient = createOllamaClient(config.ollama);

interface ServiceConfig {
  supabase: ReturnType<typeof createSupabaseService>;
  jwtVerifier: JwtVerifier | null;
  checkInService: CheckInService | null;
  videoFinder: VideoFinder | null;
  dishVideoFinder: DishVideoFinder | null;
  photoFinder: DishPhotoFinder;
  generatedRecipes: GeneratedRecipeRepository;
  /** F8 server-side mastery sessions. Needs Supabase (no in-memory version). */
  masteryRepository: MasteryRepository | null;
  /** Persistent when generated recipes are. In-memory only in dev without Supabase. */
  generationLimiter: CookAnythingGenerationLimiter;
}

/**
 * F4 technique videos: needs YOUTUBE_API_KEY. The cache is the shared
 * technique_videos table when Supabase is configured, else in memory (dev).
 */
function createVideoFinder(quota: YouTubeQuotaGate | null): VideoFinder | null {
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
    new YouTubeSearchClient({ apiKey: config.youtube.apiKey, timeoutMs: config.youtube.timeoutMs }),
    console,
    (): Date => new Date(),
    { budgetMs: config.youtube.lookupBudgetMs, ...(quota ? { quota } : {}) }
  );
}

/**
 * Cook anything dish photos: Wikimedia Commons, no API key. The cache is the
 * shared dish_photos table when Supabase is configured, else in memory (dev).
 */
/**
 * Dish recipe videos ("how to make {dish}"). Same YouTube key as technique
 * videos, cached per normalized dish name in dish_videos.
 */
function createYouTubeQuotaGate(): YouTubeQuotaGate | null {
  if (!config.youtube.apiKey) return null;
  const { url, serviceRoleKey } = config.supabase;
  if (!url || !serviceRoleKey) return null;
  return new SupabaseYouTubeQuotaGate({ url, serviceRoleKey });
}

function createDishVideoFinder(quota: YouTubeQuotaGate | null): DishVideoFinder | null {
  if (!config.youtube.apiKey) return null;
  const { url, serviceRoleKey } = config.supabase;
  const cache =
    url && serviceRoleKey
      ? new SupabaseDishVideoCache({ url, serviceRoleKey })
      : new InMemoryDishVideoCache();
  return new DishVideoFinder(
    cache,
    new YouTubeDishVideoClient({ apiKey: config.youtube.apiKey, timeoutMs: config.youtube.timeoutMs }),
    console,
    (): Date => new Date(),
    quota ?? undefined
  );
}

function createCookAnythingGenerationLimiter(persist: boolean): CookAnythingGenerationLimiter {
  const { windowMs, maxGenerations } = config.cookAnything.generationRateLimit;
  const { url, serviceRoleKey } = config.supabase;
  if (persist && url && serviceRoleKey) {
    return new SupabaseGenerationRateLimiter({ url, serviceRoleKey, windowMs, maxGenerations });
  }
  return new GenerationRateLimiter(windowMs, maxGenerations);
}

function createPhotoFinder(): DishPhotoFinder {
  const { url, serviceRoleKey } = config.supabase;
  const cache =
    url && serviceRoleKey
      ? new SupabaseDishPhotoCache({ url, serviceRoleKey })
      : new InMemoryDishPhotoCache();
  return new DishPhotoFinder(
    cache,
    new WikimediaCommonsClient({ timeoutMs: config.dishPhoto.timeoutMs }),
    console
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
      dishVideoFinder: null,
      photoFinder: createPhotoFinder(),
      generatedRecipes: new InMemoryGeneratedRecipeRepository(),
      masteryRepository: null,
      generationLimiter: createCookAnythingGenerationLimiter(false),
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
      dishVideoFinder: null,
      photoFinder: createPhotoFinder(),
      generatedRecipes: new InMemoryGeneratedRecipeRepository(),
      masteryRepository: null,
      generationLimiter: createCookAnythingGenerationLimiter(false),
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

  const generatedRecipes =
    url && serviceRoleKey
      ? new SupabaseGeneratedRecipeRepository({ url, serviceRoleKey })
      : new InMemoryGeneratedRecipeRepository();

  const generatedCheckInRepository =
    url && serviceRoleKey
      ? new SupabaseGeneratedCheckInRepository({ url, serviceRoleKey })
      : new InMemoryGeneratedCheckInRepository();

  // Path data: slots, onboarding profile, path gating (F2) and badges (F9).
  const pathRepository =
    url && serviceRoleKey ? new SupabasePathRepository({ url, serviceRoleKey }) : undefined;

  const coachNoteGenerator = createCoachNoteGenerator(ollamaClient);
  // XP is awarded only here, server-side, with the service role (never by the client).
  const xpAwarder =
    url && serviceRoleKey
      ? new SupabaseXpAwarder({ url, serviceRoleKey, timeoutMs: config.xpAward.timeoutMs })
      : null;
  const generatedXpAwarder =
    url && serviceRoleKey
      ? new SupabaseGeneratedXpAwarder({ url, serviceRoleKey, timeoutMs: config.xpAward.timeoutMs })
      : null;
  const checkInService = new CheckInService(
    checkInRepository,
    coachNoteGenerator,
    xpAwarder,
    console,
    { pathRepository, generatedCheckInRepository, generatedXpAwarder }
  );

  if (!url || !serviceRoleKey) {
    console.warn(
      'No SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY - using in-memory storage (dev only)'
    );
    // N10: In dev mode, the in-memory stores are separate, so check-ins require
    // seeding recipes directly in the check-in repository. This is test-only
    // behavior; production uses shared Supabase tables.
  }

  const youtubeQuota = createYouTubeQuotaGate();
  return {
    supabase: createSupabaseService({
      jwtVerifier,
      userRecipeRepository,
      pathRepository,
    }),
    jwtVerifier,
    checkInService,
    videoFinder: createVideoFinder(youtubeQuota),
    dishVideoFinder: createDishVideoFinder(youtubeQuota),
    photoFinder: createPhotoFinder(),
    generatedRecipes,
    masteryRepository: url && serviceRoleKey ? new SupabaseMasteryRepository({ url, serviceRoleKey }) : null,
    generationLimiter: createCookAnythingGenerationLimiter(true),
  };
}

const services = createServicesFromConfig();

const recipeRouter = createRecipeRouter(
  {
    ollamaClient,
    supabase: services.supabase,
    videoFinder: services.videoFinder,
    photoFinder: services.photoFinder,
    dishVideoFinder: services.dishVideoFinder,
  },
  {
    enablePreviewRoute: config.enablePreviewRoute,
    rateLimit: config.rateLimit,
  }
);

app.use('/api/recipes', recipeRouter);

const cookAnythingRouter = createCookAnythingRouter(
  {
    ollamaClient,
    supabase: services.supabase,
    generatedRecipes: services.generatedRecipes,
    videoFinder: services.videoFinder,
    photoFinder: services.photoFinder,
    dishVideoFinder: services.dishVideoFinder,
  },
  {
    rateLimit: config.rateLimit,
    generationLimiter: services.generationLimiter,
    maxDishLength: config.cookAnything.maxDishLength,
  }
);
app.use('/api/recipes', cookAnythingRouter);
const knownDishNames =
  config.supabase.url && config.supabase.serviceRoleKey
    ? new SupabaseKnownDishNames({
        url: config.supabase.url,
        serviceRoleKey: config.supabase.serviceRoleKey,
      })
    : null;
app.use(
  '/api/dish-photos',
  createDishPhotoRouter({
    supabase: services.supabase,
    photoFinder: services.photoFinder,
    listKnownDishNames: knownDishNames
      ? (userId: string): Promise<Set<string>> => knownDishNames.listForUser(userId)
      : undefined,
  })
);

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

if (services.jwtVerifier && services.masteryRepository) {
  app.use(
    '/api/mastery',
    createMasteryRouter({ jwtVerifier: services.jwtVerifier, masteryRepository: services.masteryRepository })
  );
  console.info('Mastery route: ENABLED');
} else {
  console.warn('Mastery route: DISABLED (needs Supabase and a JWT verifier)');
}

mountHealthRoutes(app, {
  ollamaBaseUrl: config.ollama.baseUrl,
  ollamaModel: config.ollama.model,
  supabaseUrl: config.supabase.url,
  supabaseServiceRoleKey: config.supabase.serviceRoleKey,
  youtubeApiKey: config.youtube.apiKey,
});

// Retry failed XP awards on a timer (same job as npm run reconcile:xp).
const reconcileScheduler = startReconcileScheduler(process.env, { stubAuth: isStubAuthAllowed() });

app.listen(config.port, config.host, () => {
  console.info(`Simmer AI Server running on http://${config.host}:${config.port}`);
  console.info(`Ollama endpoint: ${config.ollama.baseUrl}`);
  console.info(`Model: ${config.ollama.model}`);
  console.info(`Preview route: ${config.enablePreviewRoute ? 'ENABLED' : 'disabled'}`);
  console.info(`Technique videos: ${services.videoFinder ? 'ENABLED' : 'disabled'}`);
  console.info(`Dish videos: ${services.dishVideoFinder ? 'ENABLED' : 'disabled'}`);
  console.info(
    `YouTube quota cooldown: ${
      !config.youtube.apiKey
        ? 'disabled'
        : config.supabase.url && config.supabase.serviceRoleKey
          ? 'database'
          : 'in-memory (dev)'
    }`
  );
  console.info('Dish photos: ENABLED');
  console.info(
    `Cook anything generation limit: ${
      services.generationLimiter instanceof SupabaseGenerationRateLimiter ? 'database' : 'in-memory (dev)'
    }`
  );
  console.info(`Stub auth: ${isStubAuthAllowed() ? 'ENABLED (dev only)' : 'disabled'}`);
  console.info(
    reconcileScheduler.enabled
      ? `XP reconcile: every ${reconcileScheduler.intervalMs / 60000} min`
      : `XP reconcile: disabled (${reconcileScheduler.reason})`
  );
  console.info(`CORS origins: ${config.allowedOrigins.join(', ')}`);
});
