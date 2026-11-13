import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';

export type DnsZone = Record<string, { A?: string[]; TXT?: string[] }>;

const TYPE_A = 1;
const TYPE_TXT = 16;

function readName(msg: Buffer, offset: number): { name: string; end: number } {
  const labels: string[] = [];
  let i = offset;
  while (msg[i] !== 0) {
    const len = msg[i] as number;
    labels.push(msg.subarray(i + 1, i + 1 + len).toString('ascii'));
    i += len + 1;
  }
  return { name: labels.join('.').toLowerCase(), end: i + 1 };
}

function answer(type: number, rdata: Buffer): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0xc00c, 0); // pointer to the question name
  head.writeUInt16BE(type, 2);
  head.writeUInt16BE(1, 4); // class IN
  head.writeUInt32BE(60, 6); // TTL
  head.writeUInt16BE(rdata.length, 10);
  return Buffer.concat([head, rdata]);
}

function txtData(value: string): Buffer {
  // Split into 255 byte character strings like a real server does for long records.
  const parts: Buffer[] = [];
  const bytes = Buffer.from(value);
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.subarray(i, i + 255);
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  if (parts.length === 0) parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** A tiny authoritative UDP DNS server for A and TXT queries, enough for c-ares in tests. */
export async function startDnsServer(zone: DnsZone): Promise<{ address: string; queries: string[]; close: () => Promise<void> }> {
  const socket = dgram.createSocket('udp4');
  const queries: string[] = [];
  socket.on('message', (msg, rinfo) => {
    const { name, end } = readName(msg, 12);
    const qtype = msg.readUInt16BE(end);
    queries.push(`${qtype === TYPE_A ? 'A' : qtype === TYPE_TXT ? 'TXT' : qtype} ${name}`);
    const records = zone[name];
    const answers: Buffer[] = [];
    if (qtype === TYPE_A) for (const ip of records?.A ?? []) answers.push(answer(TYPE_A, Buffer.from(ip.split('.').map(Number))));
    if (qtype === TYPE_TXT) for (const txt of records?.TXT ?? []) answers.push(answer(TYPE_TXT, txtData(txt)));
    const header = Buffer.alloc(12);
    msg.copy(header, 0, 0, 2); // id
    header.writeUInt16BE(records ? 0x8580 : 0x8583, 2); // response, authoritative, NOERROR or NXDOMAIN
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(answers.length, 6);
    socket.send(Buffer.concat([header, msg.subarray(12, end + 4), ...answers]), rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  return {
    address: `127.0.0.1:${(socket.address() as AddressInfo).port}`,
    queries,
    close: () => new Promise<void>((r) => socket.close(() => r())),
  };
}
