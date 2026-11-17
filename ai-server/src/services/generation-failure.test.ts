import { afterEach, describe, expect, it } from 'vitest';
import {
  describeGenerationFailure,
  errorCauseCode,
  ollamaHost,
} from './generation-failure.js';

describe('errorCauseCode', () => {
  it('reads the code from a fetch-failed TypeError cause', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
        code: 'ECONNREFUSED',
      }),
    });
    expect(errorCauseCode(error)).toBe('ECONNREFUSED');
  });

  it('returns undefined when no code is present', () => {
    expect(errorCauseCode(new Error('fetch failed'))).toBeUndefined();
  });
});

describe('ollamaHost', () => {
  it('returns only the host, not the path or userinfo', () => {
    expect(ollamaHost('http://127.0.0.1:11434/api')).toBe('127.0.0.1:11434');
    expect(ollamaHost('not a url')).toBe('invalid-ollama-url');
  });
});

describe('describeGenerationFailure', () => {
  const previous = process.env.OLLAMA_BASE_URL;

  afterEach(() => {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous;
  });

  it('includes the fetch message, cause code, and Ollama host', () => {
    process.env.OLLAMA_BASE_URL = 'http://ollama.internal:11434';
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
        code: 'ECONNREFUSED',
      }),
    });
    expect(describeGenerationFailure(error)).toEqual({
      message: 'Generation failed: fetch failed',
      cause: 'ECONNREFUSED',
      ollama_host: 'ollama.internal:11434',
    });
  });
});
