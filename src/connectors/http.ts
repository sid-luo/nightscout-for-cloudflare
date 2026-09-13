/** Bounded, credential-safe HTTP shared by opt-in connector adapters. */
export class ConnectorError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}

export function externalUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ConnectorError('invalid_endpoint'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password ||
      !host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') ||
      /^[\d.]+$/.test(host) || host.includes(':') || url.hash) {
    throw new ConnectorError('invalid_endpoint');
  }
  return url;
}

export async function digest(value: string, algorithm = 'SHA-256'): Promise<string> {
  const bytes = await crypto.subtle.digest(algorithm, new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
}

export async function requestText(url: string | URL, init: RequestInit = {}, fetcher: typeof fetch = fetch,
  limit = 2 * 1024 * 1024, timeoutMs = 15_000): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(externalUrl(String(url)), { ...init, redirect: 'manual', signal: controller.signal });
    reader = response.body?.getReader();
    if (Number(response.headers.get('content-length')) > limit) throw new ConnectorError('response_too_large');
    let text = '', size = 0;
    const decoder = new TextDecoder();
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new ConnectorError('response_too_large');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { response, text };
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError(controller.signal.aborted ? 'timeout' : 'network_error');
  } finally {
    clearTimeout(timer);
    await reader?.cancel().catch(() => {});
  }
}

export async function requestJson(url: string | URL, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<unknown> {
  const { response, text } = await requestText(url, init, fetcher);
  if (!response.ok) throw new ConnectorError(response.status === 401 || response.status === 403 ? 'authentication_failed' : 'http_error', response.status);
  try { return JSON.parse(text); } catch { throw new ConnectorError('invalid_response'); }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectorError('invalid_response');
  return value as Record<string, unknown>;
}

export function array(value: unknown, limit = 10_000): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > limit) throw new ConnectorError('invalid_response');
  return value.map(object);
}
