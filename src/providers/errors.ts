// What went wrong, so callers can offer the right fix: a new key or a new model.
export type FailureKind = 'auth' | 'model' | 'other';

export class ProviderError extends Error {
  readonly kind: FailureKind;

  constructor(message: string, kind: FailureKind) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
  }
}

// Pull the readable part out of an error body. Providers use
// {error: {message}}, {error: "..."}, [{error: {...}}] or {message}.
export function errorDetail(body: string): string {
  try {
    let data = JSON.parse(body) as unknown;
    if (Array.isArray(data)) data = data[0];
    const error = (data as {error?: unknown} | null)?.error ?? data;
    const message =
      typeof error === 'string' ? error : (error as {message?: unknown} | null)?.message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  } catch {
    // Not JSON; fall back to the raw text.
  }
  return body.trim().slice(0, 300) || 'no details';
}

export function classifyFailure(status: number, detail: string): FailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model';
  // Gemini, Mistral, DeepSeek and OpenRouter report bad keys and unknown
  // models as plain 400s.
  if (status === 400 || status === 422) {
    if (/api[ _-]?key|unauthori[sz]ed|authenticat/i.test(detail)) return 'auth';
    // Match only messages about the model id itself; others mention
    // "model" in passing (e.g. "degraded model performance").
    if (
      /\b(no such|unknown|invalid|unsupported) model|not a valid model|model\b[^.]*\b(not found|not exist|does not exist|is not (valid|supported|available))/i.test(
        detail,
      )
    ) {
      return 'model';
    }
  }
  return 'other';
}

export function providerFailure(
  name: string,
  model: string,
  status: number,
  body: string,
): ProviderError {
  const detail = errorDetail(body);
  const kind = classifyFailure(status, detail);
  if (kind === 'auth') {
    return new ProviderError(
      `${name} rejected the API key (${status}: ${detail}). ` +
        'Run `agent-harness login` to enter a new one.',
      kind,
    );
  }
  if (kind === 'model') {
    return new ProviderError(
      `${name} can't use the model "${model}" (${status}: ${detail}). ` +
        'Run `agent-harness model` to choose another.',
      kind,
    );
  }
  return new ProviderError(`${name} request failed with ${status}: ${detail}`, kind);
}
