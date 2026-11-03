import { z } from 'zod';
import { CoachNoteSchema, type CoachNote } from '../types/check-in.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '15000', 10);
const MAX_RETRIES = 2;

interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  stream: boolean;
  format: 'json';
  options?: {
    temperature?: number;
    num_predict?: number;
  };
}

interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
}

export const FALLBACK_NOTE: CoachNote = {
  note: "Great job completing this recipe! Keep practicing and you'll continue to improve. Focus on the basics and don't be afraid to experiment.",
  focus_area: 'general practice',
};

/**
 * Builds the prompt for generating a Coach's note based on check-in feedback.
 */
function buildCoachNotePrompt(
  rating: 'easy' | 'ok' | 'hard',
  wentWell: string | null,
  wasHard: string | null
): string {
  const ratingText = rating === 'easy' ? 'easy' : rating === 'ok' ? 'okay' : 'challenging';
  
  const contextParts: string[] = [];
  contextParts.push(`The user just completed cooking a recipe and rated it as "${ratingText}".`);
  
  if (wentWell) {
    contextParts.push(`What went well: "${wentWell}"`);
  }
  if (wasHard) {
    contextParts.push(`What was hard: "${wasHard}"`);
  }
  
  const context = contextParts.join('\n');

  return `You are a friendly cooking coach for beginners. Based on the user's feedback, write a short, encouraging "Coach's note" for them.

${context}

Requirements:
- Be warm and encouraging, like a supportive mentor
- If they mentioned something that was hard, acknowledge it and offer a brief tip
- If they mentioned something that went well, celebrate it briefly
- Keep the note under 2 sentences (100 words max)
- Don't use emojis
- Don't repeat back what they said verbatim

Respond with ONLY a JSON object in this exact format:
{
  "note": "Your encouraging note here",
  "focus_area": "Brief topic to focus on next (optional, 2-3 words)"
}`;
}

/**
 * Calls Ollama API with timeout and returns raw response.
 */
async function callOllama(prompt: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const request: OllamaGenerateRequest = {
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: 'json',
      options: {
        temperature: 0.7,
        num_predict: 256,
      },
    };

    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as OllamaGenerateResponse;
    return data.response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Parses and validates the Ollama response as a CoachNote.
 */
function parseCoachNoteResponse(responseText: string): CoachNote {
  const trimmed = responseText.trim();
  
  let jsonStr = trimmed;
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }

  const parsed = JSON.parse(jsonStr);
  const validated = CoachNoteSchema.parse(parsed);
  return validated;
}

/**
 * Generates a Coach's note using Ollama with structured JSON output.
 * Implements retry logic and returns a safe fallback if Ollama fails.
 */
export async function generateCoachNote(
  rating: 'easy' | 'ok' | 'hard',
  wentWell: string | null,
  wasHard: string | null
): Promise<CoachNote> {
  const prompt = buildCoachNotePrompt(rating, wentWell, wasHard);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const responseText = await callOllama(prompt);
      const note = parseCoachNoteResponse(responseText);
      return note;
    } catch (error) {
      const isLastAttempt = attempt === MAX_RETRIES;
      
      if (error instanceof z.ZodError) {
        console.warn(`Ollama response validation failed (attempt ${attempt + 1}):`, error.errors);
      } else if (error instanceof SyntaxError) {
        console.warn(`Ollama response JSON parse failed (attempt ${attempt + 1}):`, error.message);
      } else if (error instanceof Error && error.name === 'AbortError') {
        console.warn(`Ollama request timed out (attempt ${attempt + 1})`);
      } else {
        console.warn(`Ollama request failed (attempt ${attempt + 1}):`, error);
      }

      if (isLastAttempt) {
        console.error('All Ollama attempts failed, returning fallback note');
        return FALLBACK_NOTE;
      }
    }
  }

  return FALLBACK_NOTE;
}

/**
 * Check if Ollama is available (for health checks).
 */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}
