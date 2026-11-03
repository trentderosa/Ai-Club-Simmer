import express from 'express';

const PORT = Number(process.env.PORT ?? 8787);
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen3.5:9b';

const app = express();
app.use(express.json());

// Health check: is the server up, and can it reach Ollama?
app.get('/health', async (_req, res) => {
  let ollama: 'ok' | 'unreachable' = 'unreachable';
  try {
    const r = await fetch(`${OLLAMA_URL}/api/version`);
    if (r.ok) ollama = 'ok';
  } catch {
    // Ollama not running; reported below.
  }
  res.json({ status: 'ok', ollama, model: OLLAMA_MODEL });
});

// Listen on all interfaces so phones on the same Wi-Fi can reach it.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Simmer AI server listening on http://0.0.0.0:${PORT}`);
});
