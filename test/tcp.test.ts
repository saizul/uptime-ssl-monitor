import { describe, expect, it } from 'vitest';
import { checkTcp } from '../src/checks/tcp.js';
import { closedPort, startTcpServer, tcpTarget } from './helpers/servers.js';

describe('checkTcp', () => {
  it('reports up for an open port', async () => {
    const s = await startTcpServer();
    const r = await checkTcp(tcpTarget(s.port));
    await s.close();
    expect(r.status).toBe('up');
    expect(r.details).toEqual({ host: '127.0.0.1', port: s.port });
  });

  it('reports down for a closed port', async () => {
    const r = await checkTcp(tcpTarget(await closedPort()));
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/ECONNREFUSED/);
  });

  it('reports degraded when connecting takes too long', async () => {
    const s = await startTcpServer();
    const r = await checkTcp(tcpTarget(s.port, { maxResponseTime: -1 }));
    await s.close();
    expect(r.status).toBe('degraded');
  });

  it('times out on unroutable addresses', async () => {
    const r = await checkTcp(tcpTarget(81, { host: '10.255.255.1', timeout: 300 }));
    expect(r.status).toBe('down');
  });
});
