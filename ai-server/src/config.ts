export interface Config {
  port: number;
  host: string;
  enablePreviewRoute: boolean;
  ollama: {
    baseUrl: string;
    model: string;
    maxTokens: number;
    timeoutMs: number;
  };
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  supabase: {
    url?: string;
    serviceRoleKey?: string;
    jwtSecret?: string;
    jwksUri?: string;
  };
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || '3001', 10),
    // SECURITY: Default to localhost to prevent external access
    host: process.env.HOST || '127.0.0.1',
    // SECURITY: Preview route disabled by default (unauthenticated LLM access)
    enablePreviewRoute: process.env.ENABLE_PREVIEW_ROUTE === 'true',
    ollama: {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      model: process.env.OLLAMA_MODEL || 'llama3.2',
      maxTokens: parseInt(process.env.OLLAMA_MAX_TOKENS || '1500', 10),
      timeoutMs: parseInt(process.env.OLLAMA_TIMEOUT_MS || '60000', 10),
    },
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '10', 10),
    },
    supabase: {
      url: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      jwtSecret: process.env.SUPABASE_JWT_SECRET,
      jwksUri: process.env.SUPABASE_JWKS_URI,
    },
  };
}
