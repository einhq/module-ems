/**
 * ems-files: the names a request's files get, and an SFTP session that reaches exactly those.
 *
 * Fast tier: a real server on loopback over a temp directory, reached with ssh2's client the way
 * EMS reaches it — one user, the secret from the header, chacha20-poly1305. A node with no file
 * on disk is played by an in-memory handle.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import type { ResourceHandleIf } from '@ein/client';
import { Client, type SFTP } from 'ssh2';
import { FILES_USER, FilesServer } from '../lib/files-server.ts';
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
  release();
  release();
  assertEquals(lookup(names[0]), undefined);
  assertEquals(lookup(directory), undefined);
  assertEquals(filesState().names.size, 0);
});

Deno.test('forRequest: every file and output at any depth goes by its name', async () => {
  filesState().endpoints.set(EMS_URL, { address: 'ein.test:2224', emsUrl: EMS_URL, user: FILES_USER, secret: 's', hostKey: 'ssh-ed25519 AAAA' });
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
    assert(sent.headers['ems-files'].startsWith('address=ein.test:2224; user=ems; secret=s; hostkey=ssh-ed25519 '));
    sent.release();
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
  name: 'ems-files: an SFTP session reaches the names of the requests in flight and nothing else',
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const root = await Deno.makeTempDir({ prefix: 'ems-files-' });
    await Deno.writeTextFile(`${root}/photo.jpg`, 'original bytes');
    await Deno.writeTextFile(`${root}/other.jpg`, 'not granted');
    await Deno.writeTextFile(`${root}/small.avif`, 'an older and longer rendition');
    await Deno.symlink(`${root}/photo.jpg`, `${root}/linked`);
    const nodes = {
      open: () => Promise.resolve(memoryNode(new TextEncoder().encode('db-tier bytes'))),
      stat: () => Promise.resolve({ size: 13, mtime: 0 }),
    };

    const server = new FilesServer({ port: 0, address: 'ein.test:2224', emsUrl: EMS_URL, nodes });
    const port = await server.start();
    const cmd = vfsOf({ '/archive/IMG_0001.JPG': `${root}/linked`, '/docs/note.txt': undefined, '/archive/IMG_0001.JPG/small.avif': `${root}/small.avif` });
    const request = (await forRequest(cmd, EMS_URL, {
      file: { path: '/archive/IMG_0001.JPG' },
      second: { file: { path: '/docs/note.txt' } },
      targets: [{ output: { path: '/archive/IMG_0001.JPG/small.avif' } }],
    }))!;
    const body = request.body as { file: { path: string }; second: { file: { path: string } }; targets: { output: { path: string } }[] };
    const [input, node, output] = [body.file.path, body.second.file.path, body.targets[0].output.path];
    const directory = input.slice(0, input.lastIndexOf('/'));
    const named = header(request.headers['ems-files']);
    const { client, sftp } = await connect(port, named.secret, named.hostkey);

    try {
      await t.step('the header names the endpoint, its user and its host key', () => {
        assertEquals(named.address, 'ein.test:2224');
        assertEquals(named.user, FILES_USER);
        assert(named.hostkey.startsWith('ssh-ed25519 '));
      });

      await t.step('an input is read by its name, on disk through its link, or from the VFS', async () => {
        assertEquals(new TextDecoder().decode(await sftp.readFile(input)), 'original bytes');
        assertEquals((await sftp.stat(input)).size, 'original bytes'.length);
        assertEquals(new TextDecoder().decode(await sftp.readFile(node)), 'db-tier bytes');
        assertEquals((await sftp.stat(node)).size, 13);
        const isDirectory = (mode?: number) => ((mode ?? 0) & 0o170000) === 0o040000;
        assert(isDirectory((await sftp.stat('/')).mode) && isDirectory((await sftp.stat(directory)).mode));
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

      await t.step('the names end with their request', async () => {
        request.release();
        await assertRejects(() => sftp.readFile(input));
        await assertRejects(() => sftp.stat(directory));
        await assertRejects(() => sftp.writeFile(output, new TextEncoder().encode('late')));
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
    assertEquals(filesState().endpoints.has(EMS_URL), false);
  },
});
