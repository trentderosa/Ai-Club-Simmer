import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { PRODUCTION_LOOPBACK_TUNNEL_MESSAGE } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function serverEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role',
    SUPABASE_JWKS_URI: 'https://example.supabase.co/auth/v1/.well-known/jwks.json',
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    OLLAMA_MODEL: 'llama3.2',
    ...overrides,
  };
  delete env.YOUTUBE_API_KEY;
  delete env.SUPABASE_JWT_SECRET;
  delete env.ALLOW_STUB_AUTH;
  delete env.ENABLE_PREVIEW_ROUTE;
  return env;
}

describe('Server Startup (B2 fix)', () => {
  let serverProcess: ChildProcess | null = null;

  afterEach(() => {
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill();
    }
    serverProcess = null;
  });

  // N13: Increased timeouts for cold CI runners
  it('server starts and responds to health check', async () => {
    const port = 3099 + Math.floor(Math.random() * 100);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server startup timed out'));
      }, 15000);

      serverProcess = spawn('npx', ['tsx', path.join(__dirname, 'index.ts')], {
        env: {
          ...process.env,
          PORT: String(port),
          HOST: '127.0.0.1',
          NODE_ENV: 'test',
          SUPABASE_JWT_SECRET: 'test-secret-for-startup-test-32chars',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      serverProcess.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
        if (output.includes('Simmer AI Server running')) {
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess.stderr?.on('data', (data: Buffer) => {
        console.error('Server stderr:', data.toString());
      });

      serverProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      serverProcess.on('exit', (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}`));
        }
      });
    });

    // Give server a moment to be ready
    await new Promise((r) => setTimeout(r, 500));

    // Health check
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.ok).toBe(true);

    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('ok');
  }, 20000);

  it('production exits when HOST is loopback and TRUST_PROXY is set', async () => {
    const output = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server did not exit'));
      }, 15000);

      serverProcess = spawn('npx', ['tsx', path.join(__dirname, 'index.ts')], {
        env: serverEnv({
          PORT: '3311',
          HOST: '127.0.0.1',
          NODE_ENV: 'production',
          TRUST_PROXY: 'true',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let collected = '';
      const onData = (data: Buffer): void => {
        collected += data.toString();
      };
      serverProcess.stdout?.on('data', onData);
      serverProcess.stderr?.on('data', onData);

      serverProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      serverProcess.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          reject(new Error('Server exited 0'));
          return;
        }
        resolve(collected);
      });
    });

    expect(output).toContain(PRODUCTION_LOOPBACK_TUNNEL_MESSAGE);
    expect(output).not.toContain('Simmer AI Server running');
    expect(output).not.toContain('placeholder-service-role');
  }, 20000);

  it('production boots on 0.0.0.0 when TRUST_PROXY is set', async () => {
    const port = 3400 + Math.floor(Math.random() * 200);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server startup timed out'));
      }, 15000);

      serverProcess = spawn('npx', ['tsx', path.join(__dirname, 'index.ts')], {
        env: serverEnv({
          PORT: String(port),
          HOST: '0.0.0.0',
          NODE_ENV: 'production',
          TRUST_PROXY: 'true',
          ALLOWED_ORIGINS: 'https://trentderosa.github.io',
          XP_RECONCILE_INTERVAL_MS: '0',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      serverProcess.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
        if (output.includes('Simmer AI Server running')) {
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess.stderr?.on('data', (data: Buffer) => {
        output += data.toString();
        if (output.includes('Refusing to start') || output.includes('Missing required config')) {
          clearTimeout(timeout);
          reject(new Error(output));
        }
      });

      serverProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      serverProcess.on('exit', (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}: ${output}`));
        }
      });
    });

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.ok).toBe(true);
  }, 20000);
});
