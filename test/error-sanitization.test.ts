import { describe, test, expect } from 'vitest';
import { parseSimulationError } from '../src/plugin/simulation';
import { sanitizeReason, decodeTransactionResult, buildStellarLabTransactionUrl } from '../src/plugin/submit';

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

  test('keeps only the last segment of a failure that is not a validation error', () => {
    const reason = 'Preparation failed: Signer error: Failed to sign: KMS key unavailable';
    expect(sanitizeReason(reason)).toBe('KMS key unavailable');
  });

  test('keeps the Relayer message for an insufficient max_fee', () => {
    const reason =
      'Preparation failed: Transaction validation error: max_fee (100203) is insufficient. Required fee-bump fee: 20000000';
    expect(sanitizeReason(reason)).toBe('max_fee (100203) is insufficient. Required fee-bump fee: 20000000');
  });

  test('keeps the Relayer message for a max_fee overflow', () => {
    const reason =
      'Preparation failed: Transaction validation error: Fee conversion overflow: max_fee (1000000000203) exceeds u32::MAX';
    expect(sanitizeReason(reason)).toBe('Fee conversion overflow: max_fee (1000000000203) exceeds u32::MAX');
  });

  test('keeps an on-chain failure reason whole', () => {
    const reason =
      'Transaction failed on-chain. reason=TxFeeBumpInnerFailed inner=TxFailed op=Trapped contract_error=Contract(7) message="oracle provider error: stale"';
    expect(sanitizeReason(reason)).toBe(reason);
  });
});

describe('decodeTransactionResult', () => {
  test('extracts result code from relayer status_reason format', () => {
    const reason = 'Transaction failed on-chain. Provider status: FAILED. Specific XDR reason: TxFailed.';
    const result = decodeTransactionResult(reason);
    expect(result).toEqual({ feeCharged: 0, resultCode: 'TxFailed' });
  });

  test('extracts TxInsufficientFee from relayer status_reason format', () => {
    const reason = 'Transaction failed on-chain. Provider status: FAILED. Specific XDR reason: TxInsufficientFee.';
    const result = decodeTransactionResult(reason);
    expect(result).toEqual({ feeCharged: 0, resultCode: 'TxInsufficientFee' });
  });

  test('extracts TxFeeBumpInnerFailed from relayer status_reason format', () => {
    const reason = 'Transaction failed on-chain. Provider status: FAILED. Specific XDR reason: TxFeeBumpInnerFailed.';
    const result = decodeTransactionResult(reason);
    expect(result).toEqual({ feeCharged: 0, resultCode: 'TxFeeBumpInnerFailed' });
  });

  test('decodes insufficient fee error with fee details from trailing XDR format', () => {
    const reason = 'Submission failed: Unexpected error: Transaction submission error: AAAAAAAAliP////3AAAAAA==';
    const result = decodeTransactionResult(reason);
    expect(result).toMatchObject({
      feeCharged: 38435,
      resultCode: 'txInsufficientFee',
    });
  });

  test('unwraps fee bump inner failure to get actual result code from trailing XDR format', () => {
    const reason =
      'Transaction submission error: AAAAAAAAYtb////z/HtXpj8u7oLTVl/vBKsqKiL79U4NAOI5sWy7pi97rHoAAAAAAAAAAP////sAAAAAAAAAAA==';
    const result = decodeTransactionResult(reason);
    expect(result).not.toBeNull();
    expect(result!.resultCode).toBe('txFeeBumpInnerFailed:txBadSeq');
  });

  test('extracts result code from relayer status text with inner result', () => {
    const reason =
      'Transaction failed on-chain. Provider status: FAILED. Specific XDR reason: TxFeeBumpInnerFailed. Inner result: TxFailed.';
    const result = decodeTransactionResult(reason);
    expect(result).not.toBeNull();
    expect(result!.resultCode).toBe('TxFeeBumpInnerFailed:TxFailed');
  });

  test('extracts outer result code from relayer status text without inner result', () => {
    const reason = 'Transaction failed on-chain. Provider status: FAILED. Specific XDR reason: TxInsufficientFee.';
    const result = decodeTransactionResult(reason);
    expect(result).not.toBeNull();
    expect(result!.resultCode).toBe('TxInsufficientFee');
  });

  test('extracts the outer result code from the on-chain failure reason', () => {
    const result = decodeTransactionResult('Transaction failed on-chain. reason=TxBadSeq');
    expect(result).toEqual({ feeCharged: 0, resultCode: 'TxBadSeq' });
  });

  test('extracts outer and inner result codes from the on-chain failure reason', () => {
    const reason =
      'Transaction failed on-chain. reason=TxFeeBumpInnerFailed inner=TxFailed op=Trapped contract_error=Contract(7) message="reason=Fake inner=Fake"';
    const result = decodeTransactionResult(reason);
    expect(result).toEqual({ feeCharged: 0, resultCode: 'TxFeeBumpInnerFailed:TxFailed' });
  });

  test('returns null when the Relayer could not read the on-chain result', () => {
    expect(decodeTransactionResult('Transaction failed on-chain. reason=unknown')).toBeNull();
  });

  test('extracts the result code from a submission rejection', () => {
    const reason = 'Submission failed: Unexpected error: Transaction submission error: TxFeeBumpInnerFailed';
    const result = decodeTransactionResult(reason);
    expect(result).toEqual({ feeCharged: 0, resultCode: 'TxFeeBumpInnerFailed' });
  });

  test('returns null for reason without XDR', () => {
    expect(decodeTransactionResult('Transaction failed')).toBeNull();
  });

  test('returns null for reason with invalid base64', () => {
    expect(decodeTransactionResult('Error: not-valid-xdr===')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(decodeTransactionResult('')).toBeNull();
  });
});

describe('buildStellarLabTransactionUrl', () => {
  test('builds mainnet URL', () => {
    const url = buildStellarLabTransactionUrl('mainnet', 'abc123');
    expect(url).toContain('network$id=mainnet');
    expect(url).toContain('label=Mainnet');
    expect(url).toContain('horizonUrl=https:////horizon.stellar.org');
    expect(url).toContain('rpcUrl=https:////mainnet.sorobanrpc.com');
    expect(url).toContain('txDashboard$transactionHash=abc123');
  });

  test('builds testnet URL', () => {
    const url = buildStellarLabTransactionUrl('testnet', 'def456');
    expect(url).toContain('network$id=testnet');
    expect(url).toContain('label=Testnet');
    expect(url).toContain('horizonUrl=https:////horizon-testnet.stellar.org');
    expect(url).toContain('rpcUrl=https:////soroban-testnet.stellar.org');
    expect(url).toContain('txDashboard$transactionHash=def456');
  });
});
