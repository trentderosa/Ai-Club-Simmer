import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

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

// PORT=0 lets the OS pick a free port; the startup log prints the one actually bound.
function parseBoundPort(output: string): number | null {
  const match = /Simmer AI Server running on http:\/\/[^\s:]+:(\d+)/.exec(output);
  return match ? Number(match[1]) : null;
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
    let port = 0;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server startup timed out'));
      }, 15000);

      serverProcess = spawn('npx', ['tsx', path.join(__dirname, 'index.ts')], {
        env: {
          ...process.env,
          PORT: '0',
          HOST: '127.0.0.1',
          NODE_ENV: 'test',
          SUPABASE_JWT_SECRET: 'test-secret-for-startup-test-32chars',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      serverProcess.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
        const bound = parseBoundPort(output);
        if (bound !== null) {
          port = bound;
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

  it('production boots on loopback when TRUST_PROXY is set', async () => {
    let port = 0;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server startup timed out'));
      }, 15000);

      serverProcess = spawn('npx', ['tsx', path.join(__dirname, 'index.ts')], {
        env: serverEnv({
          PORT: '0',
          HOST: '127.0.0.1',
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
        const bound = parseBoundPort(output);
        if (bound !== null) {
          port = bound;
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

  it('exits 1 with one clean line when the port is already in use', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const busyPort = (blocker.address() as net.AddressInfo).port;

    try {
      const result = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Server did not exit in time')), 15000);
        serverProcess = spawn('npx', ['tsx', path.join(__dirname, 'index.ts')], {
          env: serverEnv({
            PORT: String(busyPort),
            HOST: '127.0.0.1',
            NODE_ENV: 'test',
            SUPABASE_JWT_SECRET: 'test-secret-for-startup-test-32chars',
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        serverProcess.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
        serverProcess.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
        serverProcess.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        serverProcess.on('close', (code) => {
          clearTimeout(timeout);
          resolve({ code, stdout, stderr });
        });
      });

      expect(result.code).toBe(1);
      // Other startup warnings may share stderr; the failure itself must be exactly one clean line.
      const errorLines = result.stderr.split('\n').filter((l) => l.startsWith('Server error'));
      expect(errorLines).toEqual([`Server error: port ${busyPort} on 127.0.0.1 is already in use (EADDRINUSE)`]);
      expect(result.stderr).not.toMatch(/\n\s+at /);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  }, 20000);
});
