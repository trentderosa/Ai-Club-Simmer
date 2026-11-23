/**
 * Per-request time budget for model calls. Every attempt re-queues, so without
 * a deadline one request could wait a full queue timeout per attempt. The
 * budget caps queue time plus Ollama time for the whole request.
 */
export interface OllamaBudget {
  /** Total time one request may spend queueing and running, in ms. */
  budgetMs: number;
  /** Per-call Ollama timeout, in ms. It starts after a slot is held. */
  ollamaTimeoutMs: number;
  /** Longest one attempt may wait for a slot, in ms, before the budget trims it. */
  queueTimeoutMs: number;
  /** Clock in ms. Injectable for tests. */
  now?: () => number;
}

export interface OllamaDeadline {
  /**
   * Queue wait to give the next attempt: min(queueTimeoutMs, remaining budget
   * minus one Ollama timeout). Zero or less means the budget cannot cover
   * another attempt.
   */
  nextQueueTimeoutMs(): number;
}

export function startDeadline(budget: OllamaBudget): OllamaDeadline {
  const now = budget.now ?? Date.now;
  const startedAt = now();
  return {
    nextQueueTimeoutMs: (): number => {
      const remaining = budget.budgetMs - (now() - startedAt);
      return Math.min(budget.queueTimeoutMs, remaining - budget.ollamaTimeoutMs);
    },
  };
}
