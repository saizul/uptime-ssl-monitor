import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * Minimal X.509 builder so tests can create self-signed certificates with
 * arbitrary validity dates using only node:crypto (no openssl, no fixtures).
 */

const lenBytes = (n: number): number[] => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag, ...lenBytes(body.length)]), body]);
};
const seq = (...p: Buffer[]): Buffer => tlv(0x30, ...p);
const set = (...p: Buffer[]): Buffer => tlv(0x31, ...p);
const oid = (...bytes: number[]): Buffer => tlv(0x06, Buffer.from(bytes));
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));

const OID_ECDSA_SHA256 = oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);
const OID_CN = oid(0x55, 0x04, 0x03);
const OID_SAN = oid(0x55, 0x1d, 0x11);

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

function time(d: Date): Buffer {
  const y = d.getUTCFullYear();
  const rest = `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return y >= 1950 && y < 2050 ? tlv(0x17, Buffer.from(pad(y % 100) + rest)) : tlv(0x18, Buffer.from(pad(y, 4) + rest));
}

const name = (cn: string): Buffer => seq(set(seq(OID_CN, utf8(cn))));

export interface CertOptions {
  commonName?: string;
  issuerCommonName?: string;
  san?: string[];
  notBefore?: Date;
  notAfter?: Date;
}

export interface TestCert {
  key: string;
  cert: string;
  fingerprint: string;
}

export function generateSelfSignedCert(opts: CertOptions = {}): TestCert {
  const cn = opts.commonName ?? 'localhost';
  const san = opts.san ?? [cn];
  const notBefore = opts.notBefore ?? new Date(Date.now() - 3_600_000);
  const notAfter = opts.notAfter ?? new Date(Date.now() + 90 * 86_400_000);
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  const serial = randomBytes(8);
  serial[0] = (serial[0] as number) & 0x7f;
  serial[0] = (serial[0] as number) | 0x01;

  const sanExt = seq(OID_SAN, tlv(0x04, seq(...san.map((n) => tlv(0x82, Buffer.from(n, 'ascii'))))));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    seq(OID_ECDSA_SHA256),
    name(opts.issuerCommonName ?? cn),
    seq(time(notBefore), time(notAfter)),
    name(cn),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(sanExt)),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, seq(OID_ECDSA_SHA256), tlv(0x03, Buffer.from([0]), signature));
  const b64 = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    fingerprint: createHash('sha256').update(der).digest('hex'),
  };
}
