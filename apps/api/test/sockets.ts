import { SOCKET_IO_PATH } from '@focus-flow/contracts';
import { io, type Socket } from 'socket.io-client';

// Real Socket.IO clients for integration tests, connecting exactly as the web app does
// (handshake `auth`, same path). Reconnection is off so each test controls every attempt.

const openClients = new Set<Socket>();

export type ConnectOutcome =
  | { readonly connected: true }
  | { readonly connected: false; readonly code: string | undefined; readonly message: string };

export const openSocket = (
  baseUrl: string,
  auth: Record<string, unknown> | undefined,
  options: { readonly transports?: string[] } = {},
): Socket => {
  const socket = io(baseUrl, {
    path: SOCKET_IO_PATH,
    ...(auth === undefined ? {} : { auth }),
    reconnection: false,
    forceNew: true,
    transports: options.transports ?? ['websocket'],
  });
  openClients.add(socket);
  return socket;
};

const errorCode = (error: Error): string | undefined => {
  if (!('data' in error) || typeof error.data !== 'object' || error.data === null) {
    return undefined;
  }
  return 'code' in error.data && typeof error.data.code === 'string' ? error.data.code : undefined;
};

export const waitForConnect = (socket: Socket, timeoutMs = 10_000): Promise<ConnectOutcome> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the socket neither connected nor failed in time'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve({ connected: true });
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      resolve({ connected: false, code: errorCode(error), message: error.message });
    });
  });

export const connectSocket = async (baseUrl: string, token: string): Promise<Socket> => {
  const socket = openSocket(baseUrl, { token });
  const outcome = await waitForConnect(socket);
  if (!outcome.connected) {
    throw new Error(`the socket was refused: ${outcome.message}`);
  }
  return socket;
};

/** Resolves with the disconnect reason, or rejects if none arrives in time. */
export const waitForDisconnect = (socket: Socket, timeoutMs = 10_000): Promise<string> =>
  new Promise((resolve, reject) => {
    if (socket.disconnected) {
      resolve('already disconnected');
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error('the socket did not disconnect in time'));
    }, timeoutMs);
    socket.once('disconnect', (reason) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });

export const closeAllSockets = (): void => {
  for (const socket of openClients) {
    socket.disconnect();
  }
  openClients.clear();
};
