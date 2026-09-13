import { decodeHTML } from 'entities';
import type { SourceConfig } from './config';
import type { SourceProgress, SourceResult, SourceSession } from './sources';
import { LOOKBACK } from './sources';
import { array, ConnectorError, object, requestText } from './http';

type Config = Extract<SourceConfig, { source: 'glooko' }>;
const CGM_SERIES = ['cgmHigh', 'cgmNormal', 'cgmLow'];
function record(value: unknown): Record<string, unknown> { return value ? object(value) : {}; }
function patient(profile: Record<string, unknown>): Record<string, unknown> {
  return record(profile.currentUser || profile.currentPatient || profile.userLogin || profile.user || profile.patient);
}
function checkTwoFactor(value: Record<string, unknown>): void {
  if (value.twoFaRequired || value.two_fa_required || value.twoFactorRequired) throw new ConnectorError('two_factor_required');
}
function cookies(response: Response): string {
  const values = response.headers.getSetCookie();
  const result = values.map(v => v.split(';')[0]).join('; ');
  if (result.length > 8192) throw new ConnectorError('invalid_cookie');
  return result;
}
function json(text: string): Record<string, unknown> {
  try { return object(JSON.parse(text)); } catch { throw new ConnectorError('invalid_response'); }
}

async function authenticate(config: Config, now: number, fetcher: typeof fetch): Promise<SourceSession> {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', Origin: config.webOrigin, Referer: config.webOrigin + '/', 'User-Agent': 'NSCF nightscout-connect/0.0.13' };
  async function api(): Promise<SourceSession> {
    const { response, text } = await requestText(config.endpoint + '/api/v2/users/sign_in', { method: 'POST', headers, body: JSON.stringify({ userLogin: { email: config.email, password: config.password }, deviceInformation: {
      applicationType: 'logbook', os: 'android', osVersion: '33', device: 'Google Pixel 4a', deviceManufacturer: 'Google', deviceModel: 'Pixel 4a',
      serialNumber: config.serialNumber || crypto.randomUUID().replaceAll('-', '').slice(0,24), clinicalResearch: false,
      deviceId: config.deviceId || crypto.randomUUID().replaceAll('-', '').slice(0,16), applicationVersion: '6.1.3', buildNumber: '0', gitHash: 'g4fbed2011b',
    } }) }, fetcher);
    if (!response.ok) throw new ConnectorError('authentication_failed', response.status);
    const user = json(text); checkTwoFactor(user);
    const cookie = cookies(response);
    if (!cookie) throw new ConnectorError('authentication_failed');
    return { expires: now + LOOKBACK / 2 - 600_000, data: { cookie, user } };
  }
  async function web(): Promise<SourceSession> {
    const first = await requestText(config.endpoint + '/users/sign_in?locale=en-GB', { headers }, fetcher);
    if (!first.response.ok) throw new ConnectorError('authentication_failed', first.response.status);
    const match = first.text.match(/name=["'](?:authenticity_token|csrf-token)["'][^>]*(?:value|content)=["']([^"']+)["']/i) ||
      first.text.match(/(?:value|content)=["']([^"']+)["'][^>]*name=["'](?:authenticity_token|csrf-token)["']/i);
    if (!match) throw new ConnectorError('missing_csrf_token');
    const body = new URLSearchParams({ utf8: '✓', authenticity_token: decodeHTML(match[1]!), 'user[email]': config.email, 'user[password]': config.password, language: 'en', redirect_to: '/', commit: 'Log in' });
    const result = await requestText(config.endpoint + '/users/sign_in?id=login_form', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies(first.response) }, body: body.toString() }, fetcher);
    const redirect = [302,303].includes(result.response.status);
    if (!result.response.ok && !redirect) throw new ConnectorError('authentication_failed', result.response.status);
    if (redirect) {
      const location = result.response.headers.get('location');
      if (!location || new URL(location, config.endpoint).origin !== config.endpoint) throw new ConnectorError('invalid_login_redirect');
    }
    const cookie = cookies(result.response);
    if (!cookie) throw new ConnectorError('authentication_failed');
    const user = result.text.trim().startsWith('{') ? json(result.text) : {};
    checkTwoFactor(user);
    return { expires: now + LOOKBACK / 2 - 600_000, data: { cookie, user } };
  }
  if (config.authMode === 'web') return web();
  try { return await api(); } catch (error) {
    if (config.authMode === 'auto' && error instanceof ConnectorError && error.status === 422) return web();
    throw error;
  }
}

export function mapGlooko(batch: Record<string, unknown>, offset: number): SourceResult['batches'] {
  const entries: Record<string, unknown>[] = [], treatments: Record<string, unknown>[] = [];
  function entry(row: Record<string, unknown>, v3: boolean, units = ''): void {
    if (row.softDeleted || row.calculated) return;
    const timestamp = row.timestamp || row.deviceTimestamp || row.displayTime || row.updatedAt;
    const date = (timestamp ? Date.parse(String(timestamp)) : Number(row.x) * 1000) + offset;
    const raw = Number(row.value || row.glucose || row.sgv);
    const sgv = raw > 0 ? raw > 1000 ? Math.round(raw / 100) : Math.round(raw) : v3 ? Math.round(Number(row.y) * (/^mmol/i.test(units) ? 18.0143 : 1)) : 0;
    if (!Number.isSafeInteger(date) || !Number.isFinite(sgv) || sgv <= 0) throw new ConnectorError('invalid_glucose');
    entries.push({ type: 'sgv', device: v3 ? 'nightscout-connect-glooko-v3' : 'nightscout-connect-glooko', date, dateString: new Date(date).toISOString(), sgv, direction: 'Flat' });
  }
  for (const row of array(batch.readings || [])) entry(row, false);
  if (!entries.length && batch.v3Graph) {
    const profile = patient(record(batch.userProfile));
    const units = String(profile.meterUnits || profile.meter_units || profile.units || '');
    const series = record(object(batch.v3Graph).series);
    for (const name of CGM_SERIES) for (const row of array(series[name] || [])) entry(row, true, units);
  }
  for (const [key, basal] of [['scheduledBasals', true], ['normalBoluses', false]] as const) {
    for (const row of array(batch[key] || [])) {
      if (row.softDeleted) continue;
      const date = Date.parse(String(row.pumpTimestamp)) + offset;
      if (!Number.isSafeInteger(date)) throw new ConnectorError('invalid_timestamp');
      const created_at = new Date(date).toISOString();
      const treatment: Record<string, unknown> = { created_at, enteredBy: 'nightscout-connect-glooko', notes: JSON.stringify(row) };
      if (basal) {
        const rate = Number(row.rate), duration = Number(row.duration) / 60;
        if (!Number.isFinite(rate) || rate < 0 || !Number.isFinite(duration) || duration < 0) throw new ConnectorError('invalid_treatment');
        Object.assign(treatment, { eventType: 'Temp Basal', rate, absolute: rate, duration });
      } else {
        const insulin = Number(row.insulinDelivered), carbs = Number(row.carbsInput || 0);
        if (!Number.isFinite(insulin) || insulin < 0 || !Number.isFinite(carbs) || carbs < 0) throw new ConnectorError('invalid_treatment');
        Object.assign(treatment, { eventType: 'Meal Bolus', eventTime: created_at, insulin, carbs });
      }
      if (typeof row.guid === 'string') treatment._sourceId = row.guid;
      treatments.push(treatment);
    }
  }
  return [{ collection: 'entries', documents: entries }, { collection: 'treatments', documents: treatments }];
}

export async function readGlooko(config: Config, progress: SourceProgress, now: number, fetcher: typeof fetch): Promise<SourceResult> {
  const session = progress.session && progress.session.expires > now ? progress.session : await authenticate(config, now, fetcher);
  const since = Math.max(now - LOOKBACK, Math.min(progress.cursors.entries?.since || now - LOOKBACK, progress.cursors.treatments?.since || now - LOOKBACK));
  async function get(path: string): Promise<Record<string, unknown>> {
    const url = new URL(path, config.endpoint);
    url.searchParams.set('lastGuid', '1e0c094e-1e54-4a4f-8e6a-f94484b53789');
    url.searchParams.set('lastUpdatedAt', new Date(since).toISOString());
    url.searchParams.set('limit', '1000');
    const result = await requestText(url, { headers: { Cookie: String(session.data.cookie), Origin: config.webOrigin, Referer: config.webOrigin + '/', Accept: 'application/json' } }, fetcher);
    if (!result.response.ok) throw new ConnectorError(result.response.status === 401 || result.response.status === 403 ? 'authentication_failed' : 'http_error', result.response.status);
    return json(result.text);
  }
  const user = record(session.data.user);
  let code = String(patient(user).glookoCode || '');
  const batch: Record<string, unknown> = {};
  if (code) {
    for (const [path, key] of [['pumps/scheduled_basals','scheduledBasals'], ['pumps/normal_boluses','normalBoluses'], ['cgm/readings','readings']]) {
      const url = new URL('/api/v2/' + path, config.endpoint);
      url.searchParams.set('patient', code); url.searchParams.set('startDate', new Date(since).toISOString()); url.searchParams.set('endDate', new Date(now).toISOString());
      batch[key!] = (await get(url.toString()))[key!];
    }
  }
  if (config.graph && !array(batch.readings || []).length) {
    // Fetch display units even when login supplied a patient code; guessing
    // mg/dl for a mmol/L v3 point would silently corrupt glucose data.
    const profile = await get('/api/v3/session/users'); batch.userProfile = profile;
    code = String(patient(profile).glookoCode || code);
    if (!code) throw new ConnectorError('patient_selection_required');
    const url = new URL('/api/v3/graph/data', config.endpoint);
    url.searchParams.set('patient', code); url.searchParams.set('startDate', new Date(since).toISOString()); url.searchParams.set('endDate', new Date(now).toISOString());
    for (const name of CGM_SERIES) url.searchParams.append('series[]', name);
    for (const [key, value] of Object.entries({ locale: 'en', insulinTooltips: 'false', filterBgReadings: 'false', splitByDay: 'false' })) url.searchParams.set(key, value);
    batch.v3Graph = await get(url.toString());
  } else if (!code) throw new ConnectorError('patient_selection_required');
  return { session, batches: mapGlooko(batch, config.offset) };
}
