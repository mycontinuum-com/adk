import {
  getLogs,
  clearLogs,
  setBufferSize,
  subscribe,
  repatchConsole,
  LogEntry,
} from './logCapture';

describe('logCapture', () => {
  beforeEach(() => {
    clearLogs();
    repatchConsole();
  });

  describe('console interception', () => {
    it('captures console.log', () => {
      console.log('test log message');
      const logs = getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('log');
      expect(logs[0].message).toBe('test log message');
    });

    it('captures console.info', () => {
      console.info('test info message');
      const logs = getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('info');
      expect(logs[0].message).toBe('test info message');
    });

    it('captures console.debug', () => {
      console.debug('test debug message');
      const logs = getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('debug');
      expect(logs[0].message).toBe('test debug message');
    });

    it('captures console.warn', () => {
      console.warn('test warn message');
      const logs = getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('warn');
      expect(logs[0].message).toBe('test warn message');
    });

    it('captures console.error', () => {
      console.error('test error message');
      const logs = getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('error');
      expect(logs[0].message).toBe('test error message');
    });

    it('captures multiple arguments', () => {
      console.log('message', 'with', 'multiple', 'args');
      const logs = getLogs();
      expect(logs[0].message).toBe('message with multiple args');
    });

    it('stringifies objects', () => {
      console.log('object:', { key: 'value' });
      const logs = getLogs();
      expect(logs[0].message).toBe('object: {"key":"value"}');
    });
  });

  describe('logger subscriber', () => {
    it('logger.subscribe captures info logs', () => {
      const {
        Logger,
      } = require('../../../platform/primitives/observability/logger');
      const testLogger = new Logger();
      const captured: Array<{ level: string; message: string }> = [];

      const unsubscribe = testLogger.subscribe(
        (level: string, message: string) => {
          captured.push({ level, message });
        },
      );

      testLogger.info('test logger info');

      expect(captured).toHaveLength(1);
      expect(captured[0].level).toBe('info');
      expect(captured[0].message).toBe('test logger info');

      unsubscribe();
    });

    it('logger.subscribe captures warn logs', () => {
      const {
        Logger,
      } = require('../../../platform/primitives/observability/logger');
      const testLogger = new Logger();
      const captured: Array<{ level: string; message: string }> = [];

      const unsubscribe = testLogger.subscribe(
        (level: string, message: string) => {
          captured.push({ level, message });
        },
      );

      testLogger.warn('test logger warn');

      expect(captured).toHaveLength(1);
      expect(captured[0].level).toBe('warn');
      expect(captured[0].message).toBe('test logger warn');

      unsubscribe();
    });

    it('logger.subscribe captures error logs', () => {
      const {
        Logger,
      } = require('../../../platform/primitives/observability/logger');
      const testLogger = new Logger();
      const captured: Array<{ level: string; message: string }> = [];

      const unsubscribe = testLogger.subscribe(
        (level: string, message: string) => {
          captured.push({ level, message });
        },
      );

      testLogger.error('test logger error', new Error('test'));

      expect(captured).toHaveLength(1);
      expect(captured[0].level).toBe('error');
      expect(captured[0].message).toBe('test logger error');

      unsubscribe();
    });

    it('logger.subscribe unsubscribe stops notifications', () => {
      const {
        Logger,
      } = require('../../../platform/primitives/observability/logger');
      const testLogger = new Logger();
      const captured: Array<{ level: string; message: string }> = [];

      const unsubscribe = testLogger.subscribe(
        (level: string, message: string) => {
          captured.push({ level, message });
        },
      );

      testLogger.info('before');
      unsubscribe();
      testLogger.info('after');

      expect(captured).toHaveLength(1);
      expect(captured[0].message).toBe('before');
    });
  });

  describe('buffer management', () => {
    it('getLogs returns copy of buffer', () => {
      console.log('test');
      const logs1 = getLogs();
      const logs2 = getLogs();
      expect(logs1).not.toBe(logs2);
      expect(logs1).toEqual(logs2);
    });

    it('clearLogs empties buffer', () => {
      console.log('test1');
      console.log('test2');
      expect(getLogs()).toHaveLength(2);
      clearLogs();
      expect(getLogs()).toHaveLength(0);
    });

    it('setBufferSize limits entries', () => {
      setBufferSize(3);
      console.log('1');
      console.log('2');
      console.log('3');
      console.log('4');
      console.log('5');
      const logs = getLogs();
      expect(logs).toHaveLength(3);
      expect(logs[0].message).toBe('3');
      expect(logs[2].message).toBe('5');
      setBufferSize(1000);
    });

    it('entries have unique incrementing ids', () => {
      console.log('first');
      console.log('second');
      const logs = getLogs();
      expect(logs[1].id).toBeGreaterThan(logs[0].id);
    });

    it('entries have timestamps', () => {
      const before = new Date();
      console.log('test');
      const after = new Date();
      const logs = getLogs();
      expect(logs[0].timestamp.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
      expect(logs[0].timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('subscribe', () => {
    it('notifies subscribers of new entries', () => {
      const entries: LogEntry[] = [];
      const unsubscribe = subscribe((entry) => entries.push(entry));

      console.log('subscribed message');

      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe('subscribed message');

      unsubscribe();
    });

    it('unsubscribe stops notifications', () => {
      const entries: LogEntry[] = [];
      const unsubscribe = subscribe((entry) => entries.push(entry));

      console.log('before');
      unsubscribe();
      console.log('after');

      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe('before');
    });

    it('multiple subscribers receive same entries', () => {
      const entries1: LogEntry[] = [];
      const entries2: LogEntry[] = [];
      const unsub1 = subscribe((entry) => entries1.push(entry));
      const unsub2 = subscribe((entry) => entries2.push(entry));

      console.log('broadcast');

      expect(entries1).toHaveLength(1);
      expect(entries2).toHaveLength(1);
      expect(entries1[0].id).toBe(entries2[0].id);

      unsub1();
      unsub2();
    });
  });

  describe('repatchConsole', () => {
    it('restores console patches after being overwritten', () => {
      const originalPatched = console.log;
      console.log = () => {};

      expect(console.log).not.toBe(originalPatched);

      repatchConsole();
      console.log('after repatch');

      const logs = getLogs();
      const repatched = logs.find((l) => l.message === 'after repatch');
      expect(repatched).toBeDefined();
    });
  });
});
