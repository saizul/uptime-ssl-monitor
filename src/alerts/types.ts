import type { AlertEvent } from '../types.js';

export interface AlertChannel {
  name: string;
  send(event: AlertEvent): Promise<void>;
}

export interface FetchDeps {
  fetchImpl?: typeof fetch;
}

const LABEL: Record<AlertEvent['kind'], string> = {
  down: 'DOWN',
  degraded: 'DEGRADED',
  recovered: 'RECOVERED',
  flapping: 'FLAPPING',
  'flap-ended': 'STABLE AGAIN',
};

export function alertTitle(e: AlertEvent): string {
  return `[${LABEL[e.kind]}] ${e.target}`;
}

export function alertText(e: AlertEvent): string {
  const lines = [alertTitle(e), e.message];
  if (e.kind !== 'flapping' && e.kind !== 'flap-ended') lines.push(`Status: ${e.from} -> ${e.to}`);
  lines.push(`Type: ${e.targetType}`, `Time: ${new Date(e.timestamp).toISOString()}`);
  return lines.join('\n');
}

export async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: string,
  headers: Record<string, string> = {},
  what = 'request',
): Promise<void> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${what} failed with HTTP ${res.status}`);
}
