/**
 * Spec for the ws memory-exhaustion bug reached by the React Native example's
 * dev server (`expo start` -> Metro / @expo/cli).
 *
 * These tests fail while the lockfile's ws 6.2.3, 7.5.10, and 8.20.0 copies
 * are installed. They pass once those copies are the fixed releases
 * (6.2.4, 7.5.11, and 8.21.0), which close a peer that sends more than
 * 131072 message fragments or 1048576 buffered data chunks.
 *
 * Run:
 *   pnpm install --ignore-scripts --filter @tanstack/query-example-react-react-native...
 *   node --test scripts/ws-tiny-fragment-dos.test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parse as parseUrl } from 'node:url';

const MAX_FRAGMENTS = 128 * 1024;
const MAX_BUFFERED_CHUNKS = 1024 * 1024;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromExample = createRequire(
  path.join(root, 'examples/react/react-native/package.json'),
);
const requireFromExpo = createRequire(
  requireFromExample.resolve('expo/package.json'),
);
const requireFromCli = createRequire(
  requireFromExpo.resolve('@expo/cli/package.json'),
);

const { createMetroMiddleware } = requireFromCli(
  '@expo/cli/build/src/start/server/metro/dev-server/createMetroMiddleware.js',
);
const { createDebugMiddleware } = requireFromCli(
  '@expo/cli/build/src/start/server/metro/debugging/createDebugMiddleware.js',
);
const { createDevToolsPluginWebsocketEndpoint } = requireFromCli(
  '@expo/cli/build/src/start/server/metro/DevToolsPluginWebsocketEndpoint.js',
);
const {
  startReactDevToolsProxyAsync,
  closeReactDevToolsProxy,
} = requireFromCli(
  '@expo/cli/build/src/start/server/ReactDevToolsProxy.js',
);
const createWebsocketServer = requireFromCli(
  'metro/src/lib/createWebsocketServer.js',
);
const HmrServer = requireFromCli('metro/src/HmrServer.js');

function packageVersion(req) {
  return req(req.resolve('ws/package.json')).version;
}

const wsVersion = {
  '/hot': packageVersion(
    createRequire(requireFromCli.resolve('metro/package.json')),
  ),
  '/inspector/device': packageVersion(
    createRequire(
      requireFromCli.resolve('@react-native/dev-middleware/package.json'),
    ),
  ),
  '/inspector/network': packageVersion(requireFromCli),
  '/message': packageVersion(requireFromCli),
  '/events': packageVersion(requireFromCli),
  '/expo-dev-plugins/broadcast': packageVersion(requireFromCli),
  'react-devtools-proxy': packageVersion(requireFromCli),
};

function fragmentFrames() {
  const count = MAX_FRAGMENTS + 1;
  const frames = Buffer.allocUnsafe(count * 7);
  for (let i = 0; i < count; i++) {
    const offset = i * 7;
    // FIN clear. First frame is text, the rest are continuations.
    // Mask bit set, 1-byte payload, mask of zeros.
    frames[offset] = i === 0 ? 0x01 : 0x00;
    frames[offset + 1] = 0x81;
    frames[offset + 6] = 0x41;
  }
  return frames;
}

const FRAMES = fragmentFrames();

function lanIpv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

function connectWebSocket(host, port, requestPath) {
  const key = crypto.randomBytes(16).toString('base64');
  const socket = net.connect({ host, port });
  socket.setNoDelay(true);
  return new Promise((resolve, reject) => {
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\n` +
          `Host: ${host}:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n',
      );
    });
    let buffered = Buffer.alloc(0);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      socket.off('error', fail);
      const header = buffered.subarray(0, end).toString('latin1');
      if (!header.startsWith('HTTP/1.1 101')) {
        fail(new Error(`handshake failed for ${requestPath}: ${header}`));
        return;
      }
      resolve({ socket, rest: buffered.subarray(end + 4) });
    };
    socket.on('data', onData);
  });
}

function writeAll(socket, data) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.write(data, () => {
      socket.off('error', reject);
      resolve();
    });
  });
}

function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate() || Date.now() - started > timeoutMs) {
        resolve(predicate());
        return;
      }
      setTimeout(tick, 15);
    };
    tick();
  });
}

function isLimitError(error, message) {
  return (
    error instanceof Error &&
    (error.message === message ||
      error.code === 'WS_ERR_TOO_MANY_BUFFERED_PARTS')
  );
}

function watchForCloseFrame(socket) {
  const state = { closed: false };
  socket.on('close', () => {
    state.closed = true;
  });
  socket.on('error', () => {
    state.closed = true;
  });
  socket.on('data', (chunk) => {
    for (let i = 0; i + 1 < chunk.length; i++) {
      if ((chunk[i] & 0x0f) === 0x08 && (chunk[i] & 0x80) === 0x80) {
        state.closed = true;
      }
    }
  });
  return state;
}

function startDevServer() {
  const projectRoot = path.join(root, 'examples/react/react-native');
  const { websocketEndpoints } = createMetroMiddleware({
    projectRoot,
    server: {},
  });
  const { debugWebsocketEndpoints } = createDebugMiddleware({
    projectRoot,
    serverBaseUrl: 'http://localhost:8081',
  });
  Object.assign(websocketEndpoints, debugWebsocketEndpoints);
  Object.assign(websocketEndpoints, createDevToolsPluginWebsocketEndpoint());
  // Same construction runServer-fork uses for the Metro HMR socket.
  const hmrServer = new HmrServer(null, null, null);
  websocketEndpoints['/hot'] = createWebsocketServer({
    websocketServer: hmrServer,
  });

  const clients = new Map();
  for (const [requestPath, endpoint] of Object.entries(websocketEndpoints)) {
    endpoint.on('connection', (ws) => {
      ws.on('error', () => {});
      const list = clients.get(requestPath) ?? [];
      list.push(ws);
      clients.set(requestPath, list);
    });
  }

  const httpServer = http.createServer();
  // Same upgrade routing as @expo/cli runServer-fork.js.
  httpServer.on('upgrade', (request, socket, head) => {
    const { pathname } = parseUrl(request.url);
    const endpoint =
      pathname != null ? websocketEndpoints[pathname] : undefined;
    if (endpoint) {
      endpoint.handleUpgrade(request, socket, head, (ws) => {
        endpoint.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, undefined, () => {
      resolve({
        httpServer,
        clients,
        address: httpServer.address(),
        async close() {
          for (const list of clients.values()) {
            for (const ws of list) ws.terminate?.();
          }
          for (const endpoint of Object.values(websocketEndpoints)) {
            endpoint.close();
          }
          if (httpServer.listening) {
            await new Promise((done) => httpServer.close(() => done()));
          }
        },
      });
    });
  });
}

async function latestClient(clients, requestPath) {
  const found = await waitFor(
    () => (clients.get(requestPath) ?? []).length > 0,
    1000,
  );
  assert.ok(found, `${requestPath} did not accept the peer`);
  const list = clients.get(requestPath);
  return list[list.length - 1];
}

test(
  'dev-server websocket peers cannot exhaust memory with tiny fragments or chunks',
  { timeout: 60_000 },
  async () => {
    const server = await startDevServer();
    try {
      assert.ok(
        server.address &&
          (server.address.address === '::' ||
            server.address.address === '0.0.0.0'),
        `dev server must listen on every interface, got ${JSON.stringify(server.address)}`,
      );

      const lan = lanIpv4();
      const failures = [];
      const paths = [
        '/hot',
        '/inspector/device',
        '/inspector/network',
        '/message',
        '/events',
        '/expo-dev-plugins/broadcast',
      ];

      if (lan) {
        for (const requestPath of paths) {
          const peer = await connectWebSocket(
            lan,
            server.address.port,
            requestPath,
          );
          peer.socket.destroy();
          await latestClient(server.clients, requestPath);
        }
      }

      for (const requestPath of paths) {
        const peer = await connectWebSocket(
          '127.0.0.1',
          server.address.port,
          requestPath,
        );
        const ws = await latestClient(server.clients, requestPath);
        let limitError = null;
        ws.on('error', (error) => {
          limitError = error;
        });
        if (
          requestPath === '/inspector/device' ||
          requestPath === '/inspector/network'
        ) {
          assert.equal(
            ws._receiver._maxPayload,
            0,
            `${requestPath} disables the payload cap`,
          );
        }
        await writeAll(peer.socket, FRAMES);
        await waitFor(
          () =>
            limitError != null ||
            ws._receiver._fragments.length > MAX_FRAGMENTS ||
            ws.readyState !== ws.OPEN,
          2000,
        );
        const fragments = ws._receiver._fragments.length;
        const open = ws.readyState === ws.OPEN;
        if (
          open ||
          fragments > MAX_FRAGMENTS ||
          !isLimitError(limitError, 'Too many message fragments')
        ) {
          failures.push(
            `${requestPath} (ws ${wsVersion[requestPath]}) kept the peer ${open ? 'open' : 'unrejected'} ` +
              `after ${FRAMES.length / 7} one-byte fragments ` +
              `(${fragments} retained, payload bytes ${ws._receiver._totalPayloadLength}, ` +
              `maxPayload ${ws._receiver._maxPayload}, error ${limitError?.message ?? 'none'})`,
          );
        }
        peer.socket.destroy();
        ws.terminate?.();
      }

      const chunkTargets = ['/inspector/device', '/hot', '/message'];
      const chunkByte = Buffer.from([0x61]);
      for (const requestPath of chunkTargets) {
        const peer = await connectWebSocket(
          '127.0.0.1',
          server.address.port,
          requestPath,
        );
        const ws = await latestClient(server.clients, requestPath);
        let limitError = null;
        ws.on('error', (error) => {
          limitError = error;
        });
        const payloadLength = MAX_BUFFERED_CHUNKS + 8;
        const header = Buffer.alloc(14);
        header[0] = 0x82;
        header[1] = 0xff;
        header.writeUInt32BE(0, 2);
        header.writeUInt32BE(payloadLength, 6);
        await writeAll(peer.socket, Buffer.concat([header, chunkByte]));
        const sawSocketChunk = await waitFor(
          () =>
            ws._receiver._totalPayloadLength >= 1 &&
            ws._receiver._buffers.length >= 1,
          1000,
        );
        assert.ok(
          sawSocketChunk,
          `${requestPath} did not retain the first socket data chunk`,
        );
        const receiver = ws._receiver;
        for (
          let i = 0;
          i < MAX_BUFFERED_CHUNKS + 2 &&
          receiver._buffers.length <= MAX_BUFFERED_CHUNKS &&
          limitError == null;
          i++
        ) {
          const before = receiver._buffers.length;
          try {
            receiver.write(chunkByte);
          } catch (error) {
            limitError = error;
            break;
          }
          if (
            before >= MAX_BUFFERED_CHUNKS &&
            receiver._buffers.length === before
          ) {
            break;
          }
        }
        await waitFor(() => limitError != null, 500);
        if (
          receiver._buffers.length > MAX_BUFFERED_CHUNKS ||
          !isLimitError(limitError, 'Too many buffered chunks')
        ) {
          failures.push(
            `${requestPath} (ws ${wsVersion[requestPath]}) retained ${receiver._buffers.length} data chunks ` +
              `without ${limitError?.message ?? 'a limit error'}`,
          );
        }
        peer.socket.destroy();
        ws.terminate?.();
      }

      assert.deepEqual(failures, []);
    } finally {
      await server.close();
    }
  },
);

test(
  'React DevTools proxy rejects a peer that sends tiny fragments',
  { timeout: 20_000 },
  async () => {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(() => resolve()));

    await startReactDevToolsProxyAsync({ port });
    try {
      const lan = lanIpv4();
      if (lan) {
        const lanPeer = await connectWebSocket(lan, port, '/');
        lanPeer.socket.destroy();
      }
      const peer = await connectWebSocket('127.0.0.1', port, '/');
      const outcome = watchForCloseFrame(peer.socket);
      await writeAll(peer.socket, FRAMES);
      const rejected = await waitFor(
        () => outcome.closed || !peer.socket.writable,
        2000,
      );
      assert.ok(
        rejected,
        `react-devtools proxy (ws ${wsVersion['react-devtools-proxy']}) on port ${port} ` +
          `stayed open after ${FRAMES.length / 7} one-byte fragments`,
      );
      peer.socket.destroy();
    } finally {
      closeReactDevToolsProxy();
    }
  },
);
