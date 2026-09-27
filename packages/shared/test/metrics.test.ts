import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../src/events';
import { Logger } from '../src/logger';
import { createMetrics, toDataPoint } from '../src/metrics';

describe('metrics (EVT-2.6, EVT-2.7)', () => {
  it('maps fields to the documented slots', () => {
    expect(
      toDataPoint('deployment_finished', {
        orgId: 'org_1',
        sub: 'succeeded',
        outcome: 'ok',
        errorCode: 'X',
        clientName: 'claude',
        clientVersion: '1.2',
        appId: 'app_1',
        userId: 'usr_1',
        durationMs: 900,
        bytes: 1234,
        phase1Ms: 600,
        phase2Ms: 300,
      }),
    ).toEqual({
      indexes: ['org_1'],
      blobs: ['deployment_finished', 'succeeded', 'ok', 'X', 'claude', '1.2', 'app_1', 'usr_1'],
      doubles: [1, 900, 1234, 600, 300],
    });
  });

  it('indexes by anon without an org and fills empty slots', () => {
    expect(toDataPoint('login_code_requested')).toEqual({
      indexes: ['anon'],
      blobs: ['login_code_requested', '', '', '', '', '', '', ''],
      doubles: [1, 0, 0, 0, 0],
    });
  });

  it('writes through the binding and never throws', () => {
    const logger = new Logger({ test: true });
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const writeDataPoint = vi.fn();
    createMetrics({ writeDataPoint }, logger).write('tool_call', { sub: 'list_apps' });
    expect(writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({ blobs: expect.arrayContaining(['list_apps']) }),
    );

    const throwing = {
      writeDataPoint: () => {
        throw new Error('AE down');
      },
    };
    expect(() => createMetrics(throwing, logger).write('tool_call')).not.toThrow();
    expect(error).toHaveBeenCalledWith('metrics write failed', expect.objectContaining({ event: 'tool_call' }));

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const unbound = createMetrics(undefined, logger);
    unbound.write('tool_call');
    unbound.write('tool_call');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('hashes with SHA-256 hex', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
