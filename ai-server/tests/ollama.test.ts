import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs');

const mockFetch = vi.fn();
global.fetch = mockFetch;

const originalEnv = process.env;

describe('Ollama Service', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.OLLAMA_URL = 'http://localhost:11434';
    process.env.OLLAMA_MODEL = 'llama3.2';
    process.env.OLLAMA_TIMEOUT_MS = '5000';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('generateCoachNote', () => {
    it('returns coach note on successful Ollama response', async () => {
      const { generateCoachNote } = await import('../src/services/ollama-service.js');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          response: JSON.stringify({
            note: 'Great job on the pasta! Keep practicing your timing.',
            focus_area: 'timing',
          }),
          done: true,
        }),
      });

      const result = await generateCoachNote('ok', 'Sauce was good', 'Timing tricky');

      expect(result.note).toBe('Great job on the pasta! Keep practicing your timing.');
      expect(result.focus_area).toBe('timing');
    });

    it('extracts JSON from response with extra text', async () => {
      const { generateCoachNote } = await import('../src/services/ollama-service.js');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          response: 'Here is the response:\n{"note": "Well done!", "focus_area": "basics"}\n',
          done: true,
        }),
      });

      const result = await generateCoachNote('easy', null, null);

      expect(result.note).toBe('Well done!');
    });

    it('returns fallback on invalid JSON response', async () => {
      const { generateCoachNote, FALLBACK_NOTE } = await import('../src/services/ollama-service.js');
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          response: 'This is not JSON at all',
          done: true,
        }),
      });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await generateCoachNote('ok', null, null);

      expect(result).toEqual(FALLBACK_NOTE);
      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('returns fallback on schema validation failure', async () => {
      const { generateCoachNote, FALLBACK_NOTE } = await import('../src/services/ollama-service.js');
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          response: JSON.stringify({ wrong_field: 'value' }),
          done: true,
        }),
      });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await generateCoachNote('ok', null, null);

      expect(result).toEqual(FALLBACK_NOTE);
      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('returns fallback on Ollama API error', async () => {
      const { generateCoachNote, FALLBACK_NOTE } = await import('../src/services/ollama-service.js');
      
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await generateCoachNote('ok', null, null);

      expect(result).toEqual(FALLBACK_NOTE);
      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('returns fallback on network error', async () => {
      const { generateCoachNote, FALLBACK_NOTE } = await import('../src/services/ollama-service.js');
      
      mockFetch.mockRejectedValue(new Error('Network error'));

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await generateCoachNote('ok', null, null);

      expect(result).toEqual(FALLBACK_NOTE);
      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('retries on failure before returning fallback', async () => {
      const { generateCoachNote, FALLBACK_NOTE } = await import('../src/services/ollama-service.js');
      
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            model: 'llama3.2',
            response: 'invalid json',
            done: true,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            model: 'llama3.2',
            response: 'still invalid',
            done: true,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            model: 'llama3.2',
            response: 'third time invalid',
            done: true,
          }),
        });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await generateCoachNote('ok', null, null);

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(result).toEqual(FALLBACK_NOTE);
      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('succeeds on retry after initial failure', async () => {
      const { generateCoachNote } = await import('../src/services/ollama-service.js');
      
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            model: 'llama3.2',
            response: 'invalid json',
            done: true,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            model: 'llama3.2',
            response: JSON.stringify({
              note: 'Success on retry!',
              focus_area: 'persistence',
            }),
            done: true,
          }),
        });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await generateCoachNote('ok', null, null);

      expect(result.note).toBe('Success on retry!');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      consoleSpy.mockRestore();
    });

    it('sends correct prompt structure', async () => {
      const { generateCoachNote } = await import('../src/services/ollama-service.js');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          response: JSON.stringify({ note: 'Test', focus_area: 'test' }),
          done: true,
        }),
      });

      await generateCoachNote('hard', 'Sauce was good', 'Timing was tricky');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('"model":"llama3.2"'),
        })
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.prompt).toContain('challenging');
      expect(body.prompt).toContain('Sauce was good');
      expect(body.prompt).toContain('Timing was tricky');
      expect(body.format).toBe('json');
    });
  });

  describe('isOllamaAvailable', () => {
    it('returns true when Ollama is reachable', async () => {
      const { isOllamaAvailable } = await import('../src/services/ollama-service.js');
      
      mockFetch.mockResolvedValueOnce({ ok: true });

      const result = await isOllamaAvailable();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/tags',
        expect.any(Object)
      );
    });

    it('returns false when Ollama is not reachable', async () => {
      const { isOllamaAvailable } = await import('../src/services/ollama-service.js');
      
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await isOllamaAvailable();

      expect(result).toBe(false);
    });

    it('returns false when Ollama returns error status', async () => {
      const { isOllamaAvailable } = await import('../src/services/ollama-service.js');
      
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

      const result = await isOllamaAvailable();

      expect(result).toBe(false);
    });
  });
});
