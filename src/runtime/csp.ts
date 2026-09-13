export interface CspEnvironment {
  SECURE_CSP?: string; SECURE_CSP_REPORT_ONLY?: string; ALLOW_UNRESTRICTED_FRAME_EMBEDDING?: string;
  FRAME_URL_1?: string; FRAME_URL_2?: string; FRAME_URL_3?: string; FRAME_URL_4?: string;
  FRAME_URL_5?: string; FRAME_URL_6?: string; FRAME_URL_7?: string; FRAME_URL_8?: string;
}
const truthy = (value?: string) => ['true','on'].includes(String(value).toLowerCase());

export function frameSources(env: CspEnvironment): string[] {
  const result = new Set(["'self'"]);
  for (let i = 1; i <= 8; i++) {
    const value = env[`FRAME_URL_${i}` as keyof CspEnvironment];
    if (!value) continue;
    try {
      const url = new URL(value);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) result.add(url.origin);
    } catch { /* Relative URLs are covered by self. */ }
  }
  return [...result];
}

export function applyCsp(response: Response, env: CspEnvironment): Response {
  if (response.status === 101) return response;
  const restricted = ['false','off'].includes(String(env.ALLOW_UNRESTRICTED_FRAME_EMBEDDING).toLowerCase());
  const csp = truthy(env.SECURE_CSP), reportOnly = csp && truthy(env.SECURE_CSP_REPORT_ONLY);
  if (!restricted && !csp) return response;
  const secured = new Response(response.body, response);
  if (restricted) secured.headers.set('X-Frame-Options', 'SAMEORIGIN');
  if (csp) {
    const policy = ["default-src 'self'", "style-src 'self' https://fonts.googleapis.com/ https://fonts.gstatic.com/ 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'", "font-src 'self' https://fonts.googleapis.com/ https://fonts.gstatic.com/ data:",
      "img-src 'self' data:", "object-src 'none'", 'report-uri /report-violation', "base-uri 'none'", "form-action 'self'",
      "connect-src 'self' ws: wss: https://fonts.googleapis.com/ https://fonts.gstatic.com/", `frame-src ${frameSources(env).join(' ')}`,
      ...(restricted ? ["frame-ancestors 'self'"] : [])].join('; ');
    secured.headers.append(reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', policy);
    secured.headers.set('Referrer-Policy', 'no-referrer');
  }
  if (restricted && (!csp || reportOnly)) secured.headers.append('Content-Security-Policy', "frame-ancestors 'self'");
  return secured;
}
