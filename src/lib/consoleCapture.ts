export const CONSOLE_LEVELS = ['debug', 'log', 'info', 'warn', 'error'] as const;

export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export interface ConsoleCaptureEntry {
  id: number;
  level: ConsoleLevel;
  timestamp: string;
  text: string;
}

type ConsoleTarget = Pick<Console, ConsoleLevel>;
type Listener = () => void;

export interface ConsoleCapture {
  install: (target?: ConsoleTarget) => void;
  getSnapshot: () => readonly ConsoleCaptureEntry[];
  subscribe: (listener: Listener) => () => void;
}

function safelyRead(read: () => unknown, fallback: unknown): unknown {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function formatValue(value: unknown, seen: WeakSet<object>): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'symbol') return safelyRead(() => value.toString(), 'Symbol(?)') as string;
  if (typeof value === 'function') {
    const name = safelyRead(() => value.name, '') as string;
    return `[Function${name ? `: ${name}` : ''}]`;
  }
  if (typeof value !== 'object') return String(value);

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  try {
    if (value instanceof Error) {
      const name = safelyRead(() => value.name, 'Error');
      const message = safelyRead(() => value.message, '[unreadable message]');
      const stack = safelyRead(() => value.stack, undefined);
      return typeof stack === 'string' && stack ? stack : `${String(name)}: ${String(message)}`;
    }

    if (Array.isArray(value)) {
      return `[${value.map(item => formatValue(item, seen)).join(', ')}]`;
    }

    const tag = safelyRead(
      () => Object.prototype.toString.call(value).slice(8, -1),
      'Object',
    );
    const keys = safelyRead(() => Reflect.ownKeys(value), []) as PropertyKey[];
    const fields = keys.map(key => {
      const label = typeof key === 'symbol' ? safelyRead(() => key.toString(), 'Symbol(?)') : key;
      const descriptor = safelyRead(
        () => Object.getOwnPropertyDescriptor(value, key),
        undefined,
      ) as PropertyDescriptor | undefined;
      if (!descriptor) return `${String(label)}: [unreadable]`;
      if ('get' in descriptor || 'set' in descriptor) return `${String(label)}: [Accessor]`;
      return `${String(label)}: ${formatValue(descriptor.value, seen)}`;
    });
    const body = `{${fields.length ? ` ${fields.join(', ')} ` : ''}}`;
    return tag === 'Object' ? body : `${String(tag)} ${body}`;
  } catch {
    return '[Unformattable value]';
  } finally {
    seen.delete(value);
  }
}

export function formatConsoleArguments(args: readonly unknown[]): string {
  try {
    return args.map(value => formatValue(value, new WeakSet<object>())).join(' ');
  } catch {
    return '[Unable to format console message]';
  }
}

export function createConsoleCapture(now: () => Date = () => new Date()): ConsoleCapture {
  let entries: readonly ConsoleCaptureEntry[] = [];
  let nextId = 1;
  const listeners = new Set<Listener>();
  const installedTargets = new WeakSet<object>();

  return {
    install(target = console) {
      if (installedTargets.has(target)) return;
      installedTargets.add(target);

      for (const level of CONSOLE_LEVELS) {
        const original = target[level];
        target[level] = function capturedConsoleMethod(...args: unknown[]) {
          try {
            const timestamp = safelyRead(() => now().toISOString(), new Date(0).toISOString()) as string;
            entries = [...entries, { id: nextId++, level, timestamp, text: formatConsoleArguments(args) }];
            for (const listener of listeners) {
              try {
                listener();
              } catch {
                // Console calls must never fail because a UI subscriber failed.
              }
            }
          } catch {
            // Capturing must not interfere with the original console call.
          }
          return Reflect.apply(original, target, args);
        } as ConsoleTarget[typeof level];
      }
    },
    getSnapshot: () => entries,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const GLOBAL_KEY = Symbol.for('cloudcli.consoleCapture');
const globalCapture = globalThis as typeof globalThis & { [GLOBAL_KEY]?: ConsoleCapture };
const consoleCapture = globalCapture[GLOBAL_KEY] ??= createConsoleCapture();

export const installConsoleCapture = consoleCapture.install;
export const getConsoleMessagesSnapshot = consoleCapture.getSnapshot;
export const subscribeToConsoleMessages = consoleCapture.subscribe;
