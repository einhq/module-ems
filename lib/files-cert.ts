/**
 * Self-signed certificates for `ems-files` over TLS: ECDSA P-256, made with WebCrypto when the
 * service starts and kept in memory only. Each side pins the other's certificate, so nothing about
 * them is trusted but their keys: a name, a long validity, and the one extension a client checks
 * the name against (subjectAltName).
 */

/** A certificate and its private key, both PEM. */
export type Pem = { cert: string; key: string };

/** The server's certificate, which EMS pins, and the one client certificate it accepts. */
type FilesTls = { server: Pem; client: Pem };

/** The name in the server's certificate, which the client checks. */
export const SERVER_NAME = 'ems-files';

const CLIENT_NAME = 'ems';

const VALID_DAYS = 3650;

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const length = (n: number): Uint8Array => {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
};

const tlv = (tag: number, ...content: Uint8Array[]): Uint8Array => {
  const body = concat(content);
  return concat([Uint8Array.of(tag), length(body.length), body]);
};

const sequence = (...items: Uint8Array[]) => tlv(0x30, ...items);

/** A non-negative INTEGER from its big-endian bytes, in DER's one spelling. */
const integer = (bytes: Uint8Array): Uint8Array => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  return tlv(0x02, trimmed[0] & 0x80 ? concat([Uint8Array.of(0), trimmed]) : trimmed);
};

const oid = (dotted: string): Uint8Array => {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const groups: number[] = [];
    for (let value = arc;; value = Math.floor(value / 128)) {
      groups.unshift(value & 0x7f);
      if (value < 128) break;
    }
    bytes.push(...groups.map((group, i) => (i < groups.length - 1 ? group | 0x80 : group)));
  }
  return tlv(0x06, Uint8Array.from(bytes));
};

const utf8 = (text: string) => tlv(0x0c, new TextEncoder().encode(text));

const utcTime = (date: Date): Uint8Array => {
  const two = (n: number) => String(n).padStart(2, '0');
  const text = `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}` +
    `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return tlv(0x17, new TextEncoder().encode(text));
};

const name = (commonName: string) => sequence(tlv(0x31, sequence(oid('2.5.4.3'), utf8(commonName))));

const ECDSA_SHA256 = sequence(oid('1.2.840.10045.4.3.2'));

const pem = (label: string, der: Uint8Array): string => {
  const base64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
};

/** A self-signed certificate for `commonName`, which is also its one DNS name, and its key. */
const selfSigned = async (commonName: string): Promise<Pem> => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] &= 0x7f;
  const now = Date.now();
  const subjectAltName = sequence(oid('2.5.29.17'), tlv(0x04, sequence(tlv(0x82, new TextEncoder().encode(commonName)))));
  const tbs = sequence(
    tlv(0xa0, integer(Uint8Array.of(2))),
    integer(serial),
    ECDSA_SHA256,
    name(commonName),
    sequence(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + VALID_DAYS * 86_400_000))),
    name(commonName),
    spki,
    tlv(0xa3, sequence(subjectAltName)),
  );
  // WebCrypto signs as r || s; a certificate carries SEQUENCE { r, s }.
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, tbs as Uint8Array<ArrayBuffer>));
  const signature = sequence(integer(raw.subarray(0, 32)), integer(raw.subarray(32)));
  const cert = sequence(tbs, ECDSA_SHA256, tlv(0x03, Uint8Array.of(0), signature));
  const key = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  return { cert: pem('CERTIFICATE', cert), key: pem('PRIVATE KEY', key) };
};

export const makeTls = async (): Promise<FilesTls> => ({ server: await selfSigned(SERVER_NAME), client: await selfSigned(CLIENT_NAME) });
