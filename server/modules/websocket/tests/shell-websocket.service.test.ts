import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket } from 'ws';

import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: string[];
    send: (data: string) => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(data);
  return socket;
}

function createFakePty() {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;

  return {
    killed: false,
    writes: [] as string[],
    onData(listener: (data: string) => void) {
      dataListener = listener;
      return { dispose: () => undefined };
    },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      exitListener = listener;
      return { dispose: () => undefined };
    },
    emitData(data: string) {
      dataListener?.(data);
    },
    emitExit() {
      exitListener?.({ exitCode: 0 });
    },
    write(data: string) {
      this.writes.push(data);
    },
    resize() {},
    kill() {
      this.killed = true;
    },
  };
}

test('plain shell without an initial command starts an interactive shell', () => {
  const pty = createFakePty();
  const spawnCalls: Array<{ executable: string; args: string[] }> = [];
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: ((executable: string, args: string[]) => {
      spawnCalls.push({ executable, args });
      return pty as never;
    }) as never,
  };
  const socket = createFakeSocket();

  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `interactive-${Date.now()}`,
      hasSession: false,
      provider: 'plain-shell',
    })
  );

  assert.deepEqual(spawnCalls, [
    {
      executable: process.platform === 'win32' ? 'powershell.exe' : 'bash',
      args: [],
    },
  ]);

  socket.emit('message', JSON.stringify({ type: 'input', data: 'echo available\r' }));
  assert.deepEqual(pty.writes, ['echo available\r']);
  assert.equal(pty.killed, false);

  pty.emitExit();
});

test('plain shell with an initial command keeps one-shot shell arguments', () => {
  const pty = createFakePty();
  const spawnCalls: Array<{ executable: string; args: string[] }> = [];
  const initialCommand = 'printf explicit-command';
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: ((executable: string, args: string[]) => {
      spawnCalls.push({ executable, args });
      return pty as never;
    }) as never,
  };
  const socket = createFakeSocket();

  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `explicit-${Date.now()}`,
      hasSession: false,
      isPlainShell: true,
      initialCommand,
    })
  );

  assert.deepEqual(spawnCalls, [
    {
      executable: process.platform === 'win32' ? 'powershell.exe' : 'bash',
      args: process.platform === 'win32' ? ['-Command', initialCommand] : ['-c', initialCommand],
    },
  ]);

  pty.emitExit();
});

test('interactive plain shell is isolated from agent default and reconnects safely', () => {
  const plainPty = createFakePty();
  const agentPty = createFakePty();
  const restartedPlainPty = createFakePty();
  const spawned: Array<{ executable: string; args: string[] }> = [];
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: ((executable: string, args: string[]) => {
      spawned.push({ executable, args });
      return (spawned.length === 1
        ? plainPty
        : spawned.length === 2
          ? agentPty
          : restartedPlainPty) as never;
    }) as never,
  };
  const projectPath = process.cwd();
  const plainInit = {
    type: 'init',
    projectPath,
    sessionId: 'plain-session',
    hasSession: false,
    provider: 'plain-shell',
  };

  const plainSocket = createFakeSocket();
  handleShellConnection(plainSocket as never, dependencies);
  plainSocket.emit('message', JSON.stringify(plainInit));

  const agentSocket = createFakeSocket();
  handleShellConnection(agentSocket as never, dependencies);
  agentSocket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath,
      sessionId: 'default',
      hasSession: false,
      provider: 'claude',
    })
  );

  assert.equal(spawned.length, 2);
  assert.deepEqual(spawned[0], {
    executable: process.platform === 'win32' ? 'powershell.exe' : 'bash',
    args: [],
  });
  assert.deepEqual(spawned[1], {
    executable: process.platform === 'win32' ? 'powershell.exe' : 'bash',
    args: process.platform === 'win32' ? ['-Command', 'claude'] : ['-c', 'claude'],
  });

  const reconnectSocket = createFakeSocket();
  handleShellConnection(reconnectSocket as never, dependencies);
  reconnectSocket.emit('message', JSON.stringify(plainInit));
  assert.equal(spawned.length, 2);
  assert.match(reconnectSocket.frames[0], /Reconnected to existing session/);

  const restartSocket = createFakeSocket();
  handleShellConnection(restartSocket as never, dependencies);
  restartSocket.emit(
    'message',
    JSON.stringify({ ...plainInit, forceRestart: true })
  );
  assert.equal(spawned.length, 3);
  assert.equal(plainPty.killed, true);

  restartedPlainPty.emitExit();
  agentPty.emitExit();
});

test('a stale socket close cannot detach the socket that replaced it', () => {
  const pty = createFakePty();
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => pty as never,
  };
  const initMessage = JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `stale-close-${Date.now()}`,
    hasSession: false,
    provider: 'plain-shell',
    isPlainShell: true,
    initialCommand: 'test-command',
  });

  const firstSocket = createFakeSocket();
  handleShellConnection(firstSocket as never, dependencies);
  firstSocket.emit('message', initMessage);

  const replacementSocket = createFakeSocket();
  handleShellConnection(replacementSocket as never, dependencies);
  replacementSocket.emit('message', initMessage);
  replacementSocket.frames.length = 0;

  // This ordering reproduces a delayed close from a backgrounded mobile tab.
  firstSocket.emit('close');
  pty.emitData('output-after-stale-close');

  assert.equal(pty.killed, false);
  assert.equal(replacementSocket.frames.length, 1);
  assert.match(replacementSocket.frames[0], /output-after-stale-close/);

  pty.emitExit();
});

test('shell output detects and normalizes a wrapped authentication URL', () => {
  const pty = createFakePty();
  const socket = createFakeSocket();
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => pty as never,
  };

  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `wrapped-url-${Date.now()}`,
      hasSession: false,
      provider: 'plain-shell',
      isPlainShell: true,
      initialCommand: 'test-command',
    })
  );
  socket.frames.length = 0;

  pty.emitData("Continue in your browser: https://example.com/authorize?\ncode=abc\x1b[0m");

  const frames = socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  const authenticationFrame = frames.find((frame) => frame.type === 'auth_url');
  assert.deepEqual(authenticationFrame, {
    type: 'auth_url',
    url: 'https://example.com/authorize?code=abc',
    autoOpen: false,
  });

  pty.emitExit();
});
