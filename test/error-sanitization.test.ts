import { describe, test, expect } from 'vitest';
import { parseSimulationError } from '../src/plugin/simulation';
import { sanitizeReason } from '../src/plugin/submit';

describe('parseSimulationError', () => {
  test('extracts message and error type from data array', () => {
    const error = `HostError: Error(Auth, InvalidInput)

Event log (newest first):
   0: [Diagnostic Event] contract:CDPSD6T6OEYPJACAMAZC7VYFBYMI6IOR2Y5FKRFXKN3VD2M2THOLV7FM, topics:[error, Error(Auth, InvalidInput)], data:"escalating error to VM trap from failed host function call: require_auth"
   1: [Diagnostic Event] contract:CDPSD6T6OEYPJACAMAZC7VYFBYMI6IOR2Y5FKRFXKN3VD2M2THOLV7FM, topics:[error, Error(Auth, InvalidInput)], data:["signature has expired", GCGYP3G7..., 323520, 323510]`;

    expect(parseSimulationError(error)).toBe('signature has expired (Auth, InvalidInput)');
  });

  test('extracts message and error type from data string', () => {
    const error = `HostError: Error(Storage, MissingValue)

Event log (newest first):
   0: [Diagnostic Event] topics:[error, Error(Storage, MissingValue)], data:"trying to get non-existing value for contract instance"`;

    expect(parseSimulationError(error)).toBe(
      'trying to get non-existing value for contract instance (Storage, MissingValue)'
    );
  });

  test('falls back to first line when no data field', () => {
    expect(parseSimulationError('HostError: Error(Contract, Panic)')).toBe('HostError: Error(Contract, Panic)');
  });

  test('trims whitespace in fallback', () => {
    expect(parseSimulationError('  HostError: Error(Budget, Exceeded)  \n\nDetails...')).toBe(
      'HostError: Error(Budget, Exceeded)'
    );
  });

  test('returns fallback for empty string', () => {
    expect(parseSimulationError('')).toBe('Simulation failed');
  });

  test('returns fallback for whitespace only', () => {
    expect(parseSimulationError('   \n\n   ')).toBe('Simulation failed');
  });

  test('ignores short data messages', () => {
    // Messages <= 3 chars are ignored (likely not human-readable)
    const error = `HostError: Error(Test, Code)

Event log:
   0: [Diagnostic Event] data:"ab"`;

    expect(parseSimulationError(error)).toBe('HostError: Error(Test, Code)');
  });

  test('handles error without HostError prefix', () => {
    expect(parseSimulationError('Some other error format')).toBe('Some other error format');
  });

  test('prefers array format over string format', () => {
    // When both formats exist, array format (more specific) is preferred
    const error = `HostError: Error(Auth, InvalidInput)

Event log:
   0: [Diagnostic Event] data:"generic error message"
   1: [Diagnostic Event] data:["specific user error", more data]`;

    expect(parseSimulationError(error)).toBe('specific user error (Auth, InvalidInput)');
  });

  test('includes message without error type when not present', () => {
    const error = `Some error without standard format

Event log:
   0: [Diagnostic Event] data:["user friendly message", extra]`;

    expect(parseSimulationError(error)).toBe('user friendly message');
  });
});

describe('sanitizeReason', () => {
  test('extracts TxInsufficientBalance from wrapped error', () => {
    const reason =
      'Submission failed: Underlying provider error: Other provider error: Failed to send transaction: Transaction submission failed: TxInsufficientBalance';

    expect(sanitizeReason(reason)).toBe('TxInsufficientBalance');
  });

  test('extracts TxBadSeq from wrapped error', () => {
    const reason = 'Submission failed: Underlying provider error: TxBadSeq';

    expect(sanitizeReason(reason)).toBe('TxBadSeq');
  });

  test('handles simple error without wrapping', () => {
    expect(sanitizeReason('TxInsufficientFee')).toBe('TxInsufficientFee');
  });

  test('handles Transaction failed default', () => {
    expect(sanitizeReason('Transaction failed')).toBe('Transaction failed');
  });

  test('filters out segments containing provider', () => {
    const reason = 'Error: provider error';
    // Last segment contains "provider", should fallback
    expect(sanitizeReason(reason)).toBe('Error: provider error');
  });

  test('truncates very long messages in fallback case', () => {
    // Truncation only happens when last segment contains 'provider' (triggers fallback)
    const longReason = 'provider error '.repeat(10); // 150 chars, all segments contain 'provider'
    const result = sanitizeReason(longReason);
    expect(result.length).toBeLessThanOrEqual(103); // 100 + '...'
    expect(result.endsWith('...')).toBe(true);
  });

  test('keeps long last segment if valid', () => {
    // If last segment is valid (no provider), it's returned as-is even if long
    const longReason = 'error: ' + 'A'.repeat(150);
    expect(sanitizeReason(longReason)).toBe('A'.repeat(150));
  });

  test('handles empty string', () => {
    expect(sanitizeReason('')).toBe('');
  });

  test('extracts OpUnderfunded', () => {
    const reason = 'Transaction failed: Operation failed: OpUnderfunded';
    expect(sanitizeReason(reason)).toBe('OpUnderfunded');
  });

  test('handles colons in error message', () => {
    // Edge case: actual error contains colon
    const reason = 'Error: Invalid format: expected JSON';
    expect(sanitizeReason(reason)).toBe('expected JSON');
  });
});
