/**
 * ems-files: the names a request's files get, and an SFTP session that reaches exactly those.
 *
 * Fast tier: a real server on loopback over a temp directory, on its threads, plain and over TLS,
 * reached with ssh2's SFTP client the way EMS reaches it: the challenge answered with the secret
 * from the header, or TLS with the server's certificate pinned and the client's presented.
 * A node with no file on disk is played by an in-memory handle on the test's thread.
 */

import { createHmac } from 'node:crypto';
import tls from 'node:tls';
import { assert, assertEquals, assertRejects } from '@std/assert';
import type { ResourceHandleIf } from '@ein/client';
import { SFTP, STATUS_CODE } from 'ssh2';
import { makeTls, SERVER_NAME } from '../lib/files-cert.ts';
import { FilesServer } from '../lib/files-server.ts';
import { filesState, forRequest, grant, lookup } from '../lib/files.ts';

const EMS_URL = 'http://ems.test:8181';

/** The VFS as `grant` asks it: a node's disk path, none for a db-tier node, or no node at all. */
const vfsOf = (physical: Record<string, string | undefined>) =>
  ({
    access: {},
    sys: {
      vfs: {
        stat: (_access: unknown, path: string) => path in physical ? Promise.resolve({ path: physical[path] }) : Promise.reject(new Error('not a node')),
      },
    },
  }) as never;

/** A db-tier node's bytes, behind the part of a VFS handle the endpoint uses. */
const memoryNode = (bytes: Uint8Array): ResourceHandleIf => {
  let position = 0;
  return {
    seek: (offset: number) => Promise.resolve(position = offset),
    read: (size: number) => {
      const out = bytes.subarray(position, position + size);
      position += out.length;
      return Promise.resolve(out);
    },
    write: (data: Uint8Array) => Promise.resolve(data.length),
    size: () => Promise.resolve(bytes.length),
    close: () => Promise.resolve(),
  } as unknown as ResourceHandleIf;
};

Deno.test('grant: names in a directory of their own, each standing for its file, gone when released', async () => {
  const cmd = vfsOf({ '/archive/a/IMG_0001.JPG': '/files/01/01EXAMPLE', '/docs/note.txt': undefined });
  const { names, release } = await grant(cmd, [
    { path: '/archive/a/IMG_0001.JPG', mode: 'read' },
    { path: '/docs/note.txt', mode: 'read' },
    { path: '/files-tmp/made.bin', mode: 'write' },
  ]);
  const directory = names[0].slice(0, names[0].lastIndexOf('/'));
  assertEquals(names.map((name) => name.slice(directory.length + 1)), ['0-IMG_0001.JPG', '1-note.txt', '2-made.bin']);
  assertEquals(lookup(names[0]), { mode: 'read', disk: '/files/01/01EXAMPLE' });
  assertEquals(lookup(names[1]), { mode: 'read', node: '/docs/note.txt' });
  assertEquals(lookup(names[2]), { mode: 'write', disk: '/files-tmp/made.bin' });
  assertEquals(lookup('/'), 'directory');
  assertEquals(lookup(directory), 'directory');
  assertEquals(lookup('/archive/a/IMG_0001.JPG'), undefined);
  await release();
  await release();
  assertEquals(lookup(names[0]), undefined);
  assertEquals(lookup(directory), undefined);
  assertEquals(filesState().names.size, 0);
});

Deno.test('names kept in a state an earlier copy of files.ts made, which lacks what was added since', async () => {
  const key = Symbol.for('ein.ems.files.names');
  const global = globalThis as unknown as Record<symbol, unknown>;
  const kept = global[key];
  global[key] = { endpoints: new Map(), names: new Map(), grants: new Set() };
  try {
    const { names, release } = await grant(vfsOf({}), [{ path: '/files-tmp/made.bin', mode: 'write' }]);
    assertEquals(lookup(names[0]), { mode: 'write', disk: '/files-tmp/made.bin' });
    await release();
    assertEquals(lookup(names[0]), undefined);
  } finally {
    global[key] = kept;
  }
});

Deno.test('forRequest: every file and output at any depth goes by its name', async () => {
  filesState().endpoints.set(EMS_URL, { address: 'ein.test:2224', emsUrl: EMS_URL, secret: '5ec7e7' });
  try {
    const cmd = vfsOf({ '/archive/a/clip.mp4': '/files/02/02EXAMPLE', '/archive/a/clip.mp4/thumbnails/.tmp-1.avif': '/files-volatile/03/03EXAMPLE' });
    const sent = (await forRequest(cmd, EMS_URL, {
      file: { path: '/archive/a/clip.mp4', angle: 90 },
      targets: [{ output: { path: '/archive/a/clip.mp4/thumbnails/.tmp-1.avif', format: 'avif' } }],
      options: { priority: 'interactive' },
    }))!;
    const body = sent.body as { file: { path: string; angle: number }; targets: { output: { path: string; format: string } }[] };
    assert(body.file.path.endsWith('/0-clip.mp4') && body.file.angle === 90);
    assert(body.targets[0].output.path.endsWith('/1-.tmp-1.avif') && body.targets[0].output.format === 'avif');
    assertEquals(lookup(body.file.path), { mode: 'read', disk: '/files/02/02EXAMPLE' });
    assertEquals(lookup(body.targets[0].output.path), { mode: 'write', disk: '/files-volatile/03/03EXAMPLE' });
    assertEquals(sent.headers['ems-files'], 'address=ein.test:2224; secret=5ec7e7');
    await sent.release();
    assertEquals(lookup(body.file.path), undefined);
  } finally {
    filesState().endpoints.delete(EMS_URL);
  }
});

Deno.test('forRequest: a body that names no file goes as it is; one that does needs an endpoint', async () => {
  const cmd = vfsOf({ '/archive/a/IMG_0001.JPG': '/files/01/01EXAMPLE' });
  const body = { texts: ['Anna Andersson'] };
  const sent = (await forRequest(cmd, EMS_URL, body))!;
  assertEquals([sent.body, sent.headers], [body, {}]);
  assertEquals(await forRequest(cmd, EMS_URL, { file: { path: '/archive/a/IMG_0001.JPG' } }), undefined);
  assertEquals(filesState().names.size, 0);
});

/** A connection's SFTP client session: what to call once done, and the session once the server answered INIT. */
type Connected = { sftp: SFTP; end: () => void };

/**
 * An SFTP client session on a byte stream: `write` sends, the result's `push` takes what arrives,
 * and `ready` settles once the server answered, or rejects when the stream ends before.
 */
const sftpOn = (write: (data: Uint8Array) => void, close: () => void) => {
  const endpoint = { id: 0, window: Number.MAX_SAFE_INTEGER, packetSize: Number.MAX_SAFE_INTEGER, state: 'open' };
  const join = (parts: readonly Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) (out.set(part, at), at += part.length);
    return out;
  };
  const sftp = new SFTP(
    { protocol: { channelData: (_id, data) => write(data.slice()), channelDataParts: (_id, parts) => write(join(parts)), channelClose: close } },
    { type: 'session', incoming: { ...endpoint }, outgoing: { ...endpoint } },
  );
  const answered = Promise.withResolvers<void>();
  sftp.once('ready', () => answered.resolve());
  sftp._init();
  return {
    sftp,
    push: (data: Uint8Array | null) => (data ? sftp.push(data) : answered.reject(new Error('the connection ended'))),
    ready: answered.promise,
  };
};

/** Connect plain, as EMS does: read the challenge, answer it with the header's secret, then SFTP. */
const connectPlain = async (port: number, secret: string): Promise<Connected> => {
  const conn = await Deno.connect({ hostname: '127.0.0.1', port });
  const end = () => {
    try {
      conn.close();
    } catch {
      // Closed already.
    }
  };
  // The challenge is the server's first line; nothing follows it until the answer.
  let line = '';
  while (!line.endsWith('\n')) {
    const buffer = new Uint8Array(256);
    const n = await conn.read(buffer);
    if (n === null) throw new Error('the connection ended');
    line += new TextDecoder().decode(buffer.subarray(0, n));
  }
  const nonce = Uint8Array.from(line.trim().split(' ')[1].match(/../g)!.map((pair) => parseInt(pair, 16)));
  await conn.write(new TextEncoder().encode(`${createHmac('sha256', secret).update(nonce).digest('hex')}\n`));
  let writes = Promise.resolve();
  const session = sftpOn((data) => {
    writes = writes.then(async () => {
      for (let at = 0; at < data.length;) at += await conn.write(data.subarray(at));
    }).catch(() => {});
  }, end);
  void (async () => {
    try {
      while (true) {
        const buffer = new Uint8Array(64 * 1024);
        const n = await conn.read(buffer);
        if (n === null) break;
        session.push(buffer.subarray(0, n));
      }
    } catch {
      // Closed under the read.
    }
    session.push(null);
  })();
  try {
    await session.ready;
  } catch (error) {
    end();
    throw error;
  }
  return { sftp: session.sftp, end };
};

/** Connect over TLS, as EMS does: the server's certificate pinned by name, the client's presented. */
const connectTls = async (port: number, server: string, client: { cert: string; key: string }): Promise<Connected> => {
  const socket = tls.connect({ host: '127.0.0.1', port, servername: SERVER_NAME, ca: [server], cert: client.cert, key: client.key });
  const session = sftpOn((data) => socket.write(data), () => socket.destroy());
  socket.on('data', (data: Uint8Array) => session.push(new Uint8Array(data)));
  socket.on('close', () => session.push(null));
  socket.on('error', () => session.push(null));
  const end = () => socket.destroy();
  try {
    await session.ready;
  } catch (error) {
    end();
    throw error;
  }
  return { sftp: session.sftp, end };
};

/** The PEM blocks in a text, in order. */
const pems = (text: string): string[] => text.match(/-----BEGIN [^-]+-----[^-]+-----END [^-]+-----\n/g) ?? [];

const header = (value: string): Record<string, string> =>
  Object.fromEntries(value.split('; ').map((part) => [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)]));

for (const overTls of [false, true]) {
  Deno.test({
    name: `ems-files ${overTls ? 'over TLS' : 'plain'}: an SFTP session reaches the names of the requests in flight and nothing else`,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn(t) {
      const root = await Deno.makeTempDir({ prefix: 'ems-files-' });
      await Deno.writeTextFile(`${root}/photo.jpg`, 'original bytes');
      await Deno.writeTextFile(`${root}/other.jpg`, 'not granted');
      await Deno.writeTextFile(`${root}/small.avif`, 'an older and longer rendition');
      await Deno.symlink(`${root}/photo.jpg`, `${root}/linked`);
      const nodes = {
        open: (path: string) =>
          path === '/docs/gone.txt' ? Promise.reject(new Deno.errors.NotFound('gone')) : Promise.resolve(memoryNode(new TextEncoder().encode('db-tier bytes'))),
        stat: () => Promise.resolve({ size: 13, mtime: 0 }),
      };

      const server = new FilesServer({ port: 0, address: 'ein.test:2224', emsUrl: EMS_URL, tls: overTls, nodes });
      const port = await server.start();
      const cmd = vfsOf({
        '/archive/IMG_0001.JPG': `${root}/linked`,
        '/docs/note.txt': undefined,
        '/docs/gone.txt': undefined,
        '/archive/IMG_0001.JPG/small.avif': `${root}/small.avif`,
      });
      const request = (await forRequest(cmd, EMS_URL, {
        file: { path: '/archive/IMG_0001.JPG' },
        second: { file: { path: '/docs/note.txt' } },
        third: { file: { path: '/docs/gone.txt' } },
        targets: [{ output: { path: '/archive/IMG_0001.JPG/small.avif' } }],
      }))!;
      const body = request.body as { file: { path: string }; second: { file: { path: string } }; third: { file: { path: string } }; targets: { output: { path: string } }[] };
      const [input, node, gone, output] = [body.file.path, body.second.file.path, body.third.file.path, body.targets[0].output.path];
      const directory = input.slice(0, input.lastIndexOf('/'));
      const named = header(request.headers['ems-files']);
      const pinned = overTls ? atob(named.tls) : '';
      const [clientCert, clientKey] = overTls ? pems(atob(named.client)) : [];
      const connect = () => (overTls ? connectTls(port, pinned, { cert: clientCert, key: clientKey }) : connectPlain(port, named.secret));
      const first = await connect();
      const { sftp } = first;

      try {
        await t.step(`the header names the endpoint and ${overTls ? 'the certificates' : 'the secret'}`, () => {
          assertEquals(named.address, 'ein.test:2224');
          if (overTls) {
            assertEquals(Object.keys(named), ['address', 'tls', 'client']);
            assertEquals(pems(pinned).length, 1);
            assert(clientCert.startsWith('-----BEGIN CERTIFICATE-----') && clientKey.startsWith('-----BEGIN PRIVATE KEY-----'));
          } else {
            assertEquals(Object.keys(named), ['address', 'secret']);
            assert(/^[0-9a-f]{64}$/.test(named.secret));
          }
        });

        await t.step('an input is read by its name, on disk through its link, or from the VFS', async () => {
          assertEquals(new TextDecoder().decode(await sftp.readFile(input)), 'original bytes');
          assertEquals((await sftp.stat(input)).size, 'original bytes'.length);
          assertEquals(new TextDecoder().decode(await sftp.readFile(node)), 'db-tier bytes');
          assertEquals((await sftp.stat(node)).size, 13);
          const isDirectory = (mode?: number) => ((mode ?? 0) & 0o170000) === 0o040000;
          assert(isDirectory((await sftp.stat('/')).mode) && isDirectory((await sftp.stat(directory)).mode));
        });

        await t.step("a node the VFS cannot open is answered as the VFS's error says", async () => {
          const error = await assertRejects(() => sftp.readFile(gone)) as { code?: number };
          assertEquals(error.code, STATUS_CODE.NO_SUCH_FILE);
        });

        await t.step('anything else is refused: real paths, other names, listings, writing an input', async () => {
          await assertRejects(() => sftp.readFile(`${root}/photo.jpg`));
          await assertRejects(() => sftp.stat(`${root}/other.jpg`));
          await assertRejects(() => sftp.stat(`${directory}/9-other.jpg`));
          await assertRejects(() => sftp.readdir('/'));
          await assertRejects(() => sftp.readdir(directory));
          await assertRejects(() => sftp.writeFile(input, new TextEncoder().encode('overwritten')));
          await assertRejects(() => sftp.readFile(output));
          await assertRejects(() => sftp.mkdir(`${directory}/sub`));
          await assertRejects(() => sftp.unlink(input));
          await assertRejects(() => sftp.rename(output, `${directory}/moved.avif`));
          assertEquals(await Deno.readTextFile(`${root}/photo.jpg`), 'original bytes');
        });

        await t.step('an output is written in place, truncated, its bytes there before the handle closes', async () => {
          const handle = await sftp.open(output, 'w');
          await sftp.write(handle, new TextEncoder().encode('rendition'), 0, 9, 0);
          assertEquals(await Deno.readTextFile(`${root}/small.avif`), 'rendition');
          await sftp.close(handle);
        });

        await t.step('an output whose file does not exist yet opens the way sshfs opens it', async () => {
          // sshfs looks the name up, then sends OPEN with CREAT|TRUNC and an LSTAT together, and
          // gives up on the open when the LSTAT fails.
          const { names, release } = await grant(vfsOf({}), [{ path: `${root}/new.bin`, mode: 'write' }]);
          try {
            const [fresh] = names;
            assertEquals((await sftp.lstat(fresh)).size, 0);
            const [handle, info] = await Promise.all([sftp.open(fresh, 'w'), sftp.lstat(fresh)]);
            assertEquals(info.size, 0);
            await sftp.write(handle, new TextEncoder().encode('created'), 0, 7, 0);
            assertEquals((await sftp.fstat(handle)).size, 7);
            await sftp.close(handle);
            assertEquals(await Deno.readTextFile(`${root}/new.bin`), 'created');
          } finally {
            release();
          }
        });

        await t.step('several connections at once, on session threads of their own, each reach a name granted after they connected', async () => {
          const block = crypto.getRandomValues(new Uint8Array(64 * 1024));
          const large = new Uint8Array(8 * 1024 * 1024);
          for (let at = 0; at < large.length; at += block.length) large.set(block, at);
          large[large.length - 1] ^= 0xff;
          await Deno.writeFile(`${root}/large.bin`, large);
          const others = await Promise.all([1, 2, 3, 4, 5].map(() => connect()));
          const { names, release } = await grant(vfsOf({}), [{ path: `${root}/large.bin`, mode: 'read' }]);
          try {
            const read = await Promise.all([first, ...others].map(({ sftp }) => sftp.readFile(names[0])));
            for (const bytes of read) assertEquals(new Uint8Array(bytes), large);
            for (const { sftp } of others) assertEquals(new TextDecoder().decode(await sftp.readFile(node)), 'db-tier bytes');
          } finally {
            await release();
            for (const other of others) other.end();
          }
        });

        await t.step('the names end with their request', async () => {
          await request.release();
          await assertRejects(() => sftp.readFile(input));
          await assertRejects(() => sftp.stat(directory));
          await assertRejects(() => sftp.writeFile(output, new TextEncoder().encode('late')));
        });

        await t.step(
          overTls ? 'another client certificate and a pin to another server are refused' : 'another secret and a TLS connection are refused',
          async () => {
            const other = await makeTls();
            if (overTls) {
              await assertRejects(() => connectTls(port, pinned, other.client));
              await assertRejects(() => connectTls(port, other.server.cert, { cert: clientCert, key: clientKey }));
              await assertRejects(() => connectPlain(port, 'f'.repeat(64)));
            } else {
              await assertRejects(() => connectPlain(port, 'f'.repeat(64)));
              await assertRejects(() => connectTls(port, other.server.cert, other.client));
            }
          },
        );
      } finally {
        await request.release();
        first.end();
        await server.stop();
        await Deno.remove(root, { recursive: true });
      }
      assertEquals(filesState().endpoints.has(EMS_URL), false);
    },
  });
}
