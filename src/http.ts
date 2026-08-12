// http.ts
//
// Every external call in this app goes through here. A bare fetch() has no
// timeout at all — if Open-Meteo, Nominatim, or Overpass (all free public
// endpoints that do get slow under load) stops responding, the request hangs
// forever and the user just watches "Checking the forecast…" with no way out.

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * fetch() with a hard timeout. Throws a readable Error on timeout rather than
 * a bare DOMException, since the message ends up in front of the LLM (and
 * therefore, indirectly, the user).
 */
export async function fetchWithTimeout(
  label: string,
  input: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    if (isTimeout) {
      throw new Error(`${label} did not respond within ${timeoutMs / 1000}s — try again in a moment.`);
    }
    throw new Error(
      `${label} could not be reached: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
