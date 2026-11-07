/**
 * The SSH server behind `ems-files`: one user, SFTP alone, chacha20-poly1305 alone.
 *
 * Its host key and the user's password are made when it starts and kept in memory only. Both
 * reach EMS in the `EMS-Files` header of each request (files.ts), so nothing is configured on
 * either side but the address, and a restart leaves no credential behind that still works. A
 * session that asks for a shell, a command or a forwarding is refused.
 */

import { type Connection, generateKeyPair, Server, type ServerAuthContext, SFTP } from 'ssh2';
import { FilesSession, type NodeAccess } from './files-sftp.ts';
import { type FilesEndpoint, filesState } from './files.ts';

export const FILES_USER = 'ems';

/** The one cipher offered: AEAD, and the cheapest of EiN's SSH stack per byte. */
const CIPHER = 'chacha20-poly1305@openssh.com';

export type FilesServerOptions = {
  /** The port to listen on, 0 for any. */
  port: number;
  /** `host:port` as EMS reaches this server; a port of its own when the listener is behind a mapping. */
  address: string;
  /** The media service the names are for. */
  emsUrl: string;
  /** The VFS, for the names of nodes with no file on disk. */
  nodes: NodeAccess;
  log?: (line: string) => void;
};

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Whether a password is the secret, in a time that does not depend on where they differ. */
const sameSecret = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export class FilesServer {
  private server?: Server;
  private endpoint?: FilesEndpoint;
  private sessions = new Set<FilesSession>();

  constructor(private options: FilesServerOptions) {}

  /** Listen, and publish the endpoint to the client; the port actually listened on. */
  async start(): Promise<number> {
    const keys = await generateKeyPair('ed25519');
    const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
    this.server = new Server(
      {
        hostKeys: [keys.private],
        algorithms: { cipher: [CIPHER], serverHostKey: ['ssh-ed25519'], compress: ['none'] },
      },
      (client: Connection) => this.connection(client, secret),
    );
    await this.server.listen(this.options.port, '0.0.0.0');
    const port = this.server.address()?.port ?? this.options.port;
    this.endpoint = { address: this.options.address, emsUrl: this.options.emsUrl, user: FILES_USER, secret, hostKey: keys.public };
    filesState().endpoints.set(this.options.emsUrl, this.endpoint);
    return port;
  }

  async stop(): Promise<void> {
    const { endpoints } = filesState();
    if (endpoints.get(this.options.emsUrl) === this.endpoint) endpoints.delete(this.options.emsUrl);
    this.server?.close();
    this.server = undefined;
    await Promise.all([...this.sessions].map((session) => session.closeAll()));
  }

  private connection(client: Connection, secret: string): void {
    const log = this.options.log ?? (() => {});
    client.on('authentication', (ctx: ServerAuthContext) => {
      const password = ctx.method === 'password' ? (ctx as ServerAuthContext & { password: string }).password : '';
      if (ctx.method === 'password' && ctx.username === FILES_USER && sameSecret(password, secret)) return ctx.accept();
      ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session?.on('sftp', (acceptSftp) => {
          const channel = acceptSftp();
          if (!channel) return;
          const sftp = new SFTP({ protocol: client.protocol }, { type: 'session', incoming: channel.incoming, outgoing: channel.outgoing }, { server: true });
          const files = new FilesSession(this.options.nodes, log);
          this.sessions.add(files);
          files.attach(sftp);
          void pipe(channel.readable, (data) => sftp.push(data), () => {
            sftp.push(null);
            channel.exit(0);
            channel.end();
            this.sessions.delete(files);
            void files.closeAll();
          });
        });
      });
    });
    client.on('error', (error: Error) => log(`ems-files: connection error: ${error.message}`));
  }
}

const pipe = async (readable: ReadableStream<Uint8Array>, onData: (data: Uint8Array) => void, onEnd: () => void): Promise<void> => {
  const reader = readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) onData(value);
    }
  } catch {
    // The channel closed under the reader.
  } finally {
    reader.releaseLock();
    onEnd();
  }
};
