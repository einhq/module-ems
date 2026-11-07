/**
 * The SSH server behind `ems-files`: one user, SFTP alone, chacha20-poly1305 alone. Each session
 * thread (files-thread.ts) runs one, which serves the connections the listening thread hands it
 * and looks names up in that thread's copy of them.
 *
 * The host key and the client's key are made when the service starts and kept in memory only.
 * The host key's public half and the client's private key reach EMS in the `EMS-Files` header of
 * each request (files.ts), so nothing is configured on either side but the address, and a restart
 * leaves no credential behind that still works. A session that asks for a shell, a command or a
 * forwarding is refused.
 */

import { type adapters, type Connection, generateKeyPair, parseKey, type PKAuthContext, Server, type ServerAuthContext, SFTP } from 'ssh2';
import { FilesSession, type NodeAccess } from './files-sftp.ts';

type Transport = adapters.Transport;

export const FILES_USER = 'ems';

/** The one cipher offered: AEAD, and the cheapest of EiN's SSH stack per byte. */
const CIPHER = 'chacha20-poly1305@openssh.com';

/** The keys of one run of the service: each a private key in OpenSSH's format and its public half, `ssh-ed25519 AAAA…`. */
export type FilesKeys = { host: { private: string; public: string }; client: { private: string; public: string } };

export const makeKeys = async (): Promise<FilesKeys> => ({ host: await generateKeyPair('ed25519'), client: await generateKeyPair('ed25519') });

type FilesSshOptions = {
  /** The host key, private. */
  hostKey: string;
  /** The public half of the one key a client signs in with. */
  clientKey: string;
  /** The VFS, for the names of nodes with no file on disk. */
  nodes: NodeAccess;
  log?: (line: string) => void;
};

export class FilesSshServer {
  private server: Server;
  private clientKey;
  private sessions = new Set<FilesSession>();
  private transports = new Set<Transport>();

  constructor(private options: FilesSshOptions) {
    const clientKey = parseKey(options.clientKey);
    if (clientKey instanceof Error) throw clientKey;
    this.clientKey = clientKey;
    this.server = new Server(
      {
        hostKeys: [options.hostKey],
        algorithms: { cipher: [CIPHER], serverHostKey: ['ssh-ed25519'], compress: ['none'] },
      },
      (client: Connection) => this.connection(client),
    );
  }

  /** Serve one connection, until either side ends it. */
  async serve(transport: Transport): Promise<void> {
    this.transports.add(transport);
    await this.server.injectTransport(transport);
  }

  async stop(): Promise<void> {
    for (const transport of this.transports) transport.close();
    this.transports.clear();
    await Promise.all([...this.sessions].map((session) => session.closeAll()));
  }

  private connection(client: Connection): void {
    const log = this.options.log ?? (() => {});
    client.on('authentication', async (ctx: ServerAuthContext) => {
      if (ctx.method === 'publickey' && ctx.username === FILES_USER) {
        const pk = ctx as PKAuthContext;
        // Without a signature the client only asks whether this key would do; the signed request follows.
        if (this.clientKey.equals(pk.key.data) && (!pk.signature || await this.clientKey.verify(pk.blob!, pk.signature, pk.hashAlgo) === true)) {
          return ctx.accept();
        }
      }
      ctx.reject(['publickey']);
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
    client.on('close', () => {
      for (const transport of this.transports) if (transport.closed) this.transports.delete(transport);
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
