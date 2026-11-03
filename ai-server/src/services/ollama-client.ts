import { Ollama } from 'ollama';
import type { ChatResponse } from 'ollama';

export interface OllamaClientConfig {
  baseUrl: string;
  model: string;
}

export interface OllamaClient {
  generate(prompt: string, jsonSchema: object): Promise<string>;
}

export function createOllamaClient(config: OllamaClientConfig): OllamaClient {
  const ollama = new Ollama({ host: config.baseUrl });

  return {
    async generate(prompt: string, jsonSchema: object): Promise<string> {
      const response: ChatResponse = await ollama.chat({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        format: jsonSchema,
        options: {
          temperature: 0.7,
        },
      });

      return response.message.content;
    },
  };
}
