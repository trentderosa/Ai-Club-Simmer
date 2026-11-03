import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Server Startup (B2 fix)', () => {
  let serverProcess: ChildProcess | null = null;

  afterEach(() => {
    if (serverProcess) {
      serverProcess.kill();
      serverProcess = null;
    }
  });

  it('server starts and responds to health check', async () => {
    const port = 3099 + Math.floor(Math.random() * 100);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server startup timed out'));
      }, 10000);

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
  }, 15000);
});
