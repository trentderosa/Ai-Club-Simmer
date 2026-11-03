/**
 * Sanitizes user-provided text to prevent prompt injection and other attacks.
 * 
 * This function:
 * - Strips control characters (except newlines and tabs)
 * - Removes potential prompt injection patterns
 * - Limits consecutive newlines
 * - Trims whitespace
 * - Returns null for empty/whitespace-only input
 */
export function sanitizeUserText(input: string | null | undefined): string | null {
  if (input === null || input === undefined) {
    return null;
  }

  let text = input;

  // Remove control characters except newlines (\n) and tabs (\t)
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Remove potential prompt injection patterns
  const injectionPatterns = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/gi,
    /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/gi,
    /forget\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/gi,
    /system\s*:/gi,
    /assistant\s*:/gi,
    /user\s*:/gi,
    /\[\[.*?\]\]/g,
    /```[\s\S]*?```/g,
    /<\/?script[^>]*>/gi,
    /<\/?style[^>]*>/gi,
  ];

  for (const pattern of injectionPatterns) {
    text = text.replace(pattern, '[removed]');
  }

  // Collapse multiple consecutive newlines into at most two
  text = text.replace(/\n{3,}/g, '\n\n');

  // Trim whitespace
  text = text.trim();

  // Return null if empty after sanitization
  if (text.length === 0) {
    return null;
  }

  return text;
}
