import { ConnectorError, externalUrl } from './http';

export interface SourceEnvironment {
  ENABLE?: string; CONNECT_SOURCE?: string;
  CONNECT_SOURCE_ENDPOINT?: string; CONNECT_SOURCE_API_SECRET?: string;
  CONNECT_SOURCE_COLLECTIONS?: string; CONNECT_SOURCE_MAX_COUNT?: string;
  CONNECT_LINK_UP_USERNAME?: string; CONNECT_LINK_UP_PASSWORD?: string;
  CONNECT_LINK_UP_REGION?: string; CONNECT_LINK_UP_SERVER?: string;
  CONNECT_LINK_UP_PATIENT_ID?: string; CONNECT_LINK_UP_INTERVAL?: string;
  CONNECT_LINK_UP_VERSION?: string; CONNECT_LINK_UP_PRODUCT?: string;
  CONNECT_GLOOKO_EMAIL?: string; CONNECT_GLOOKO_PASSWORD?: string;
  CONNECT_GLOOKO_ENV?: string; CONNECT_GLOOKO_SERVER?: string;
  CONNECT_GLOOKO_WEB_ORIGIN?: string; CONNECT_GLOOKO_AUTH_MODE?: string;
  CONNECT_GLOOKO_USE_V3_GRAPH?: string; CONNECT_GLOOKO_TIMEZONE_OFFSET?: string;
  CONNECT_GLOOKO_DEVICE_ID?: string; CONNECT_GLOOKO_SERIAL_NUMBER?: string;
}
export type SourceCollection = 'entries' | 'treatments' | 'devicestatus' | 'profiles';
export type SourceConfig = {
  source: 'nightscout'; endpoint: string; secret: string; collections: SourceCollection[]; maxCount: number; interval: number;
} | {
  source: 'linkup'; endpoint: string; username: string; password: string;
  patientId: string; version: string; product: string; interval: number;
} | {
  source: 'glooko'; endpoint: string; webOrigin: string; email: string; password: string;
  authMode: 'api' | 'web' | 'auto'; graph: boolean; offset: number;
  deviceId: string; serialNumber: string; interval: number;
};
export type SourceResolution = { enabled: true; config: SourceConfig } | { enabled: false; error?: string };
export const LLU_REGIONS = ['AE','AP','AU','CA','DE','EU','EU2','FR','JP','US'];
const GLOOKO_HOSTS: Record<string, string> = { default: 'api.glooko.com', development: 'api.glooko.work', production: 'externalapi.glooko.com', eu: 'eu.api.glooko.com', ca: 'ca.api.glooko.com' };

function credential(value?: string): string {
  if (!value || value.length > 1024) throw new ConnectorError('missing_credentials');
  return value;
}
function hostUrl(value: string): string { return externalUrl('https://' + value).origin; }

export function resolveSourceConfig(env: SourceEnvironment): SourceResolution {
  if (!(env.ENABLE || '').toLowerCase().split(/[\s,]+/).includes('connect')) return { enabled: false };
  const source = (env.CONNECT_SOURCE || '').toLowerCase().trim();
  if (!['nightscout', 'linkup', 'librelinkup', 'glooko'].includes(source)) return { enabled: false };
  try {
    if (source === 'nightscout') {
      const endpoint = externalUrl(env.CONNECT_SOURCE_ENDPOINT || '').toString();
      const collections = (env.CONNECT_SOURCE_COLLECTIONS || 'entries,treatments,devicestatus,profiles').split(',').map(v => v.trim());
      if (collections.some(v => !['entries','treatments','devicestatus','profiles'].includes(v))) throw new ConnectorError('invalid_collections');
      const maxCount = Number(env.CONNECT_SOURCE_MAX_COUNT || 1000);
      if (!Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > 10000) throw new ConnectorError('invalid_max_count');
      return { enabled: true, config: { source, endpoint, secret: env.CONNECT_SOURCE_API_SECRET || '', collections: [...new Set(collections)] as SourceCollection[], maxCount, interval: 300_000 } };
    }
    if (source === 'linkup' || source === 'librelinkup') {
      const region = (env.CONNECT_LINK_UP_REGION || 'EU').toUpperCase();
      if (!LLU_REGIONS.includes(region)) throw new ConnectorError('invalid_region');
      const minutes = Number(env.CONNECT_LINK_UP_INTERVAL || 5);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) throw new ConnectorError('invalid_interval');
      return { enabled: true, config: { source: 'linkup', endpoint: hostUrl(env.CONNECT_LINK_UP_SERVER || `api-${region.toLowerCase()}.libreview.io`), username: credential(env.CONNECT_LINK_UP_USERNAME), password: credential(env.CONNECT_LINK_UP_PASSWORD), patientId: env.CONNECT_LINK_UP_PATIENT_ID || '', version: env.CONNECT_LINK_UP_VERSION || '4.7.0', product: env.CONNECT_LINK_UP_PRODUCT || 'llu.ios', interval: minutes * 60_000 } };
    }
    const host = env.CONNECT_GLOOKO_SERVER || GLOOKO_HOSTS[env.CONNECT_GLOOKO_ENV || 'default'];
    if (!host) throw new ConnectorError('invalid_region');
    const endpoint = hostUrl(host);
    const webOrigin = externalUrl(env.CONNECT_GLOOKO_WEB_ORIGIN || endpoint.replace('externalapi.', 'my.').replace('api.', 'my.')).origin;
    const authMode = env.CONNECT_GLOOKO_AUTH_MODE || 'api';
    if (!['api','web','auto'].includes(authMode)) throw new ConnectorError('invalid_auth_mode');
    const offset = Number(env.CONNECT_GLOOKO_TIMEZONE_OFFSET || 0);
    if (!Number.isFinite(offset) || Math.abs(offset) > 24) throw new ConnectorError('invalid_timezone_offset');
    return { enabled: true, config: { source: 'glooko', endpoint, webOrigin, email: credential(env.CONNECT_GLOOKO_EMAIL), password: credential(env.CONNECT_GLOOKO_PASSWORD), authMode: authMode as 'api' | 'web' | 'auto', graph: ['true','1','yes'].includes(env.CONNECT_GLOOKO_USE_V3_GRAPH || ''), offset: -offset * 3600_000, deviceId: env.CONNECT_GLOOKO_DEVICE_ID || '', serialNumber: env.CONNECT_GLOOKO_SERIAL_NUMBER || '', interval: 300_000 } };
  } catch (error) { return { enabled: false, error: error instanceof ConnectorError ? error.code : 'invalid_configuration' }; }
}
