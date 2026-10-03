import { connect, createServer, type Server, type Socket } from 'node:net';

// A TCP pass-through for integration tests that need a store to become unreachable for
// one API instance only, without stopping the shared container: `cut` closes the
// listener and every piped connection (clients then see a refused or reset connection,
// as during a real outage), `restore` listens on the same port again.

export type TcpProxy = {
  readonly port: number;
  readonly cut: () => Promise<void>;
  readonly restore: () => Promise<void>;
  readonly close: () => Promise<void>;
};

const listen = (server: Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the proxy has no TCP address'));
        return;
      }
      resolve(address.port);
    });
  });

export const startTcpProxy = async (targetHost: string, targetPort: number): Promise<TcpProxy> => {
  const open = new Set<Socket>();
  const track = (socket: Socket): void => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    // A reset during `cut` is expected; never let it surface as an unhandled error.
    socket.on('error', () => undefined);
  };

  const createListener = (): Server =>
    createServer((client) => {
      const upstream = connect(targetPort, targetHost);
      track(client);
      track(upstream);
      client.pipe(upstream).pipe(client);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });

  let server = createListener();
  const port = await listen(server, 0);
  let listening = true;

  const cut = async (): Promise<void> => {
    if (!listening) {
      return;
    }
    listening = false;
    const closed = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    for (const socket of open) {
      socket.destroy();
    }
    await closed;
  };

  return {
    port,
    cut,
    restore: async () => {
      if (listening) {
        return;
      }
      server = createListener();
      await listen(server, port);
      listening = true;
    },
    close: cut,
  };
};
