import { Ollama } from 'ollama';
import type { ChatResponse } from 'ollama';

export interface OllamaClientConfig {
  baseUrl: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface OllamaClient {
  generate(prompt: string, jsonSchema: object): Promise<string>;
}

/**
 * Creates an Ollama client with safety bounds.
 *
 * - maxTokens (num_predict): Caps output length to prevent runaway generation
 * - timeoutMs: Aborts requests that take too long (default 60s)
 */
export function createOllamaClient(config: OllamaClientConfig): OllamaClient {
  const ollama = new Ollama({ host: config.baseUrl });

  return {
    async generate(prompt: string, jsonSchema: object): Promise<string> {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

      try {
        const response: ChatResponse = await ollama.chat({
          model: config.model,
          messages: [{ role: 'user', content: prompt }],
          format: jsonSchema,
          options: {
            temperature: 0.7,
            num_predict: config.maxTokens,
          },
        });

        return response.message.content;
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}
