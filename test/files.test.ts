/**
 * ems-files: what a request body grants, and an SFTP session that reaches exactly that.
 *
 * Fast tier: a real server on loopback over a temp directory, reached with ssh2's client the way
 * EMS reaches it — one user, the secret from the header, chacha20-poly1305.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import { Client, type SFTP } from 'ssh2';
import { FILES_USER, FilesServer } from '../lib/files-server.ts';
import { filesState, forRequest, grant, granted, requestPaths } from '../lib/files.ts';

const EMS_URL = 'http://ems.test:8181';

Deno.test('requestPaths: inputs, outputs and output directories at any depth', () => {
  const paths = requestPaths({
    file: { path: '/files/ab/one', angle: 0 },
    targets: [{ output: { path: '/files-volatile/cd/two', format: 'avif' } }, { output: { path: '/files-volatile/cd/../cd/three' } }],
    output: { dir: '/files-tmp/frames' },
    options: { priority: 'interactive' },
    note: { path: '/not/a/file/ref' },
    relative: { file: { path: 'files/x' } },
  });
  assertEquals(paths, {
    read: ['/files/ab/one'],
    write: ['/files-volatile/cd/two', '/files-volatile/cd/three'],
    dirs: ['/files-tmp/frames'],
  });
});

Deno.test('grant: counted per request, gone when the last one ends', () => {
  const first = grant({ read: ['/a/in'], write: ['/a/out'], dirs: [] });
  const second = grant({ read: ['/a/in'], write: [], dirs: ['/a/frames'] });
  assert(granted('/a/in', 'read'));
  assert(!granted('/a/in', 'write'));
  assert(granted('/a/out', 'write'));
  assert(!granted('/a/out', 'read'));
  assert(granted('/a/frames/f-1.jpg', 'write'));
  assert(!granted('/a/frames/sub/f-1.jpg', 'write'));
  assert(granted('/a/frames', 'stat'));
  assert(granted('/a', 'stat') && granted('/', 'stat'));
  assert(!granted('/a', 'read') && !granted('/b', 'stat'));
  first();
  first();
  assert(granted('/a/in', 'read'));
  assert(!granted('/a/out', 'write'));
  second();
  assert(!granted('/a/in', 'read'));
  assert(!granted('/a', 'stat') && granted('/', 'stat'));
  assertEquals(filesState().grants.size, 0);
  assertEquals(filesState().parents.size, 0);
});

Deno.test('forRequest: no header and no grant unless ems-files serves that media service', async () => {
  const none = await forRequest(EMS_URL, { file: { path: '/x' } });
  assertEquals(none.headers, {});
  assertEquals(none.body, { file: { path: '/x' } });
  assert(!granted('/x', 'read'));
  none.release();
});

/** Connect as EMS does: the user and secret from the header, the host key pinned, one cipher. */
const connect = async (port: number, password: string, hostKey: string, cipher = 'chacha20-poly1305@openssh.com'): Promise<{ client: Client; sftp: SFTP }> => {
  const client = new Client();
  const pinned = hostKey.split(' ')[1];
  const ready = new Promise<void>((resolve, reject) => {
    client.on('ready', () => resolve());
    client.on('error', (error: Error) => reject(error));
  });
  try {
    await Promise.all([
      client.connect({
        host: '127.0.0.1',
        port,
        username: FILES_USER,
        password,
        algorithms: { cipher: [cipher], serverHostKey: ['ssh-ed25519'] },
        hostVerifier: (key) => (typeof key === 'string' ? key : btoa(String.fromCharCode(...key))) === pinned,
      }),
      ready,
    ]);
  } catch (error) {
    client.end();
    throw error;
  }
  return { client, sftp: await client.sftp() };
};

const header = (value: string): Record<string, string> =>
  Object.fromEntries(value.split('; ').map((part) => [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)]));

Deno.test({
  name: 'ems-files: an SFTP session reaches the granted files and nothing else',
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const root = await Deno.makeTempDir({ prefix: 'ems-files-' });
    await Deno.mkdir(`${root}/in`);
    await Deno.mkdir(`${root}/out`);
    await Deno.writeTextFile(`${root}/in/photo.jpg`, 'original bytes');
    await Deno.writeTextFile(`${root}/in/other.jpg`, 'not granted');
    await Deno.writeTextFile(`${root}/out/small.avif`, '');
    await Deno.symlink(`${root}/in/photo.jpg`, `${root}/in/linked.jpg`);

    const server = new FilesServer({ port: 0, address: 'ein.test:2224', emsUrl: EMS_URL });
    const port = await server.start();
    const request = await forRequest(EMS_URL, {
      file: { path: `${root}/in/photo.jpg` },
      targets: [{ output: { path: `${root}/out/small.avif` } }],
      output: { dir: `${root}/frames` },
      second: { file: { path: `${root}/in/linked.jpg` } },
    });
    const named = header(request.headers['ems-files']);
    const { client, sftp } = await connect(port, named.secret, named.hostkey);

    try {
      await t.step('the header names the endpoint, its user and its host key', () => {
        assertEquals(named.address, 'ein.test:2224');
        assertEquals(named.user, FILES_USER);
        assert(named.hostkey.startsWith('ssh-ed25519 '));
      });

      await t.step('an input is sent and granted as the file its link leads to', async () => {
        const real = await Deno.realPath(`${root}/in/photo.jpg`);
        assertEquals((request.body as { second: { file: { path: string } } }).second.file.path, real);
        assertEquals(new TextDecoder().decode(await sftp.readFile(real)), 'original bytes');
        assertEquals((await sftp.stat(real)).size, 'original bytes'.length);
        await assertRejects(() => sftp.readFile(`${root}/in/linked.jpg`));
      });

      await t.step('anything not granted is refused: other files, listings, writing an input', async () => {
        await assertRejects(() => sftp.readFile(`${root}/in/other.jpg`));
        await assertRejects(() => sftp.stat(`${root}/in/other.jpg`));
        await assertRejects(() => sftp.readdir(`${root}/in`));
        await assertRejects(() => sftp.writeFile(`${root}/in/photo.jpg`, new TextEncoder().encode('overwritten')));
        await assertRejects(() => sftp.readFile(`${root}/out/small.avif`));
        await assertRejects(() => sftp.unlink(`${root}/in/photo.jpg`));
        await assertRejects(() => sftp.rename(`${root}/out/small.avif`, `${root}/out/moved.avif`));
        assertEquals(await Deno.readTextFile(`${root}/in/photo.jpg`), 'original bytes');
      });

      await t.step('an output is written in place, truncated, its bytes there before the handle closes', async () => {
        await Deno.writeTextFile(`${root}/out/small.avif`, 'an older and longer rendition');
        const handle = await sftp.open(`${root}/out/small.avif`, 'w');
        await sftp.write(handle, new TextEncoder().encode('rendition'), 0, 9, 0);
        assertEquals(await Deno.readTextFile(`${root}/out/small.avif`), 'rendition');
        await sftp.close(handle);
        assertEquals([...Deno.readDirSync(`${root}/out`)].map((entry) => entry.name), ['small.avif']);
      });

      await t.step('a granted directory may be made, and no other', async () => {
        await sftp.mkdir(`${root}/frames`);
        assert(Deno.statSync(`${root}/frames`).isDirectory);
        await assertRejects(() => sftp.mkdir(`${root}/elsewhere`));
      });

      await t.step('a granted directory takes files directly inside it', async () => {
        await sftp.writeFile(`${root}/frames/frame-001.jpg`, new TextEncoder().encode('frame'));
        assertEquals(await Deno.readTextFile(`${root}/frames/frame-001.jpg`), 'frame');
        await assertRejects(() => sftp.writeFile(`${root}/frames/sub/frame-002.jpg`, new TextEncoder().encode('frame')));
      });

      await t.step('the grant ends with its request', async () => {
        request.release();
        await assertRejects(() => sftp.readFile(`${root}/in/photo.jpg`));
        await assertRejects(() => sftp.writeFile(`${root}/out/small.avif`, new TextEncoder().encode('late')));
      });

      await t.step('a wrong password and another cipher are refused', async () => {
        await assertRejects(() => connect(port, 'not-the-secret', named.hostkey));
        await assertRejects(() => connect(port, named.secret, named.hostkey, 'aes128-gcm@openssh.com'));
      });
    } finally {
      request.release();
      client.end();
      await server.stop();
      await Deno.remove(root, { recursive: true });
    }
    assertEquals(filesState().endpoint, undefined);
  },
});
