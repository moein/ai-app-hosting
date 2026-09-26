import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { Logger, type LogLevel } from '../src/logger';

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
let spies: Record<LogLevel, MockInstance>;

const lastEntry = (level: LogLevel) => JSON.parse(String(spies[level].mock.lastCall?.[0]));

beforeEach(() => {
  spies = {
    debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
});
afterEach(() => vi.restoreAllMocks());

describe('Logger', () => {
  it.each(LEVELS)('%s writes one JSON line through the matching console method', (level) => {
    new Logger()[level]('hello', { appId: 'app_1', count: 2 });
    expect(spies[level]).toHaveBeenCalledOnce();
    for (const other of LEVELS.filter((l) => l !== level)) expect(spies[other]).not.toHaveBeenCalled();
    const entry = lastEntry(level);
    expect(entry).toMatchObject({ level, message: 'hello', appId: 'app_1', count: 2 });
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });

  it('works without metadata', () => {
    new Logger().info('plain');
    expect(Object.keys(lastEntry('info')).sort()).toEqual(['level', 'message', 'timestamp']);
  });

  it('Logger.root is created lazily and reused', () => {
    const root = Logger.root;
    expect(root).toBeInstanceOf(Logger);
    expect(Logger.root).toBe(root);
  });

  it('child() merges context without mutating the parent', () => {
    const parent = new Logger({ worker: 'api' });
    const child = parent.child({ requestId: 'r1' });
    child.info('from child', { step: 1 });
    expect(lastEntry('info')).toMatchObject({ worker: 'api', requestId: 'r1', step: 1 });
    parent.info('from parent');
    expect(lastEntry('info')).toMatchObject({ worker: 'api' });
    expect(lastEntry('info')).not.toHaveProperty('requestId');
  });

  it('metadata overrides context', () => {
    new Logger({ step: 'context' }).info('m', { step: 'metadata' });
    expect(lastEntry('info').step).toBe('metadata');
  });

  it('context and metadata cannot overwrite timestamp, level or message', () => {
    new Logger({ level: 'debug' }).warn('real', { message: 'fake', timestamp: 'fake' });
    const entry = lastEntry('warn');
    expect(entry.level).toBe('warn');
    expect(entry.message).toBe('real');
    expect(entry.timestamp).not.toBe('fake');
  });

  it('serializes errors with their cause chain', () => {
    const error = new Error('outer', { cause: new TypeError('inner') });
    new Logger().error('failed', { error });
    expect(lastEntry('error').error).toMatchObject({
      name: 'Error',
      message: 'outer',
      stack: expect.stringContaining('outer'),
      cause: { name: 'TypeError', message: 'inner' },
    });
  });

  it('never throws on unserializable metadata', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => new Logger().info('circular', { circular, big: 10n })).not.toThrow();
    expect(lastEntry('info')).toMatchObject({ circular: { a: 1, self: '[unserializable]' }, big: '10' });
  });
});
