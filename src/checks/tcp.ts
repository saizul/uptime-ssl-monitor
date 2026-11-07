import net from 'node:net';
import type { CheckResult, TcpTarget } from '../types.js';

export function checkTcp(target: TcpTarget): Promise<CheckResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.connect({ host: target.host, port: target.port });
    let done = false;
    const finish = (status: CheckResult['status'], message: string): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ status, latencyMs: Math.round(performance.now() - started), message, details: { host: target.host, port: target.port } });
    };
    socket.setTimeout(target.timeout, () => finish('down', `Timed out after ${target.timeout}ms`));
    socket.on('connect', () => {
      const ms = Math.round(performance.now() - started);
      if (target.maxResponseTime !== undefined && ms > target.maxResponseTime) {
        finish('degraded', `Slow connect: ${ms}ms (limit ${target.maxResponseTime}ms)`);
      } else {
        finish('up', `Connected to ${target.host}:${target.port} in ${ms}ms`);
      }
    });
    socket.on('error', (e: NodeJS.ErrnoException) => finish('down', `${e.code ?? 'ERROR'}: ${e.message}`));
  });
}
