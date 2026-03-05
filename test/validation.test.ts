import { describe, test, expect } from 'vitest';
import { xdr, Contract } from '@stellar/stellar-sdk';
import { validateAndParseRequest } from '../src/plugin/validation';

describe('validation', () => {
  test('accepts xdr-only request', () => {
    const out = validateAndParseRequest({ xdr: 'BASE64XDR' });
    expect(out).toEqual({ type: 'xdr', xdr: 'BASE64XDR', skipWait: false, x402: false });
  });

  test('rejects xdr with extra keys', () => {
    expect(() => validateAndParseRequest({ xdr: 'X', extra: 1 } as any)).toThrow(
      '`xdr` request must not include other parameters'
    );
  });

  test('accepts func+auth with valid base64', () => {
    const contract = new Contract('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    const op = contract.call('no_auth_bump', xdr.ScVal.scvU32(1)) as any;
    const body = op.body();
    const inv = body.invokeHostFunctionOp();
    const func = inv.hostFunction().toXDR('base64');
    const auth = (inv.auth() ?? []).map((a: any) => a.toXDR('base64'));
    const out = validateAndParseRequest({ func, auth });
    expect(out.type).toBe('func-auth');
  });

  test('accepts xdr with skipWait without unknown-key error', () => {
    const out = validateAndParseRequest({ xdr: 'BASE64XDR', skipWait: true });
    expect(out).toEqual({ type: 'xdr', xdr: 'BASE64XDR', skipWait: true, x402: false });
  });

  test('parses skipWait as boolean in func+auth', () => {
    const contract = new Contract('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    const op = contract.call('no_auth_bump', xdr.ScVal.scvU32(1)) as any;
    const body = op.body();
    const inv = body.invokeHostFunctionOp();
    const func = inv.hostFunction().toXDR('base64');
    const auth = (inv.auth() ?? []).map((a: any) => a.toXDR('base64'));
    const out = validateAndParseRequest({ func, auth, skipWait: true });
    expect(out.type).toBe('func-auth');
    expect((out as any).skipWait).toBe(true);
  });

  test('skipWait defaults to false', () => {
    const out = validateAndParseRequest({ xdr: 'BASE64XDR' });
    expect((out as any).skipWait).toBe(false);
  });

  test('rejects non-boolean skipWait in xdr request', () => {
    expect(() => validateAndParseRequest({ xdr: 'BASE64XDR', skipWait: 'false' })).toThrow(
      '`skipWait` must be a boolean'
    );
    expect(() => validateAndParseRequest({ xdr: 'BASE64XDR', skipWait: 1 })).toThrow('`skipWait` must be a boolean');
  });

  test('rejects non-boolean skipWait in func+auth request', () => {
    const contract = new Contract('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    const op = contract.call('no_auth_bump', xdr.ScVal.scvU32(1)) as any;
    const body = op.body();
    const inv = body.invokeHostFunctionOp();
    const func = inv.hostFunction().toXDR('base64');
    const auth = (inv.auth() ?? []).map((a: any) => a.toXDR('base64'));
    expect(() => validateAndParseRequest({ func, auth, skipWait: 'true' })).toThrow('`skipWait` must be a boolean');
  });

  test('accepts getTransaction request', () => {
    const out = validateAndParseRequest({ getTransaction: { transactionId: 'tx-1' } });
    expect(out).toEqual({ type: 'get-transaction', transactionId: 'tx-1', x402: false });
  });

  test('trims getTransaction transactionId', () => {
    const out = validateAndParseRequest({ getTransaction: { transactionId: '  tx-2  ' } });
    expect(out).toEqual({ type: 'get-transaction', transactionId: 'tx-2', x402: false });
  });

  test('accepts getTransaction with x402 flag', () => {
    const out = validateAndParseRequest({ getTransaction: { transactionId: 'tx-1' }, x402: true });
    expect(out).toEqual({ type: 'get-transaction', transactionId: 'tx-1', x402: true });
  });

  test('rejects getTransaction with non-boolean x402', () => {
    expect(() => validateAndParseRequest({ getTransaction: { transactionId: 'tx-1' }, x402: 'yes' })).toThrow(
      '`x402` must be a boolean'
    );
  });

  test('rejects getTransaction with missing transactionId', () => {
    expect(() => validateAndParseRequest({ getTransaction: {} })).toThrow(
      '`getTransaction.transactionId` must be a non-empty string'
    );
  });

  test('rejects getTransaction with empty transactionId', () => {
    expect(() => validateAndParseRequest({ getTransaction: { transactionId: '' } })).toThrow(
      '`getTransaction.transactionId` must be a non-empty string'
    );
  });

  test('rejects getTransaction with non-string transactionId', () => {
    expect(() => validateAndParseRequest({ getTransaction: { transactionId: 123 } })).toThrow(
      '`getTransaction.transactionId` must be a non-empty string'
    );
  });

  test('rejects getTransaction with extra top-level keys', () => {
    expect(() => validateAndParseRequest({ getTransaction: { transactionId: 'tx-1' }, extra: 1 } as any)).toThrow(
      '`getTransaction` request must not include other parameters'
    );
  });

  test('rejects getTransaction with extra inner keys', () => {
    expect(() => validateAndParseRequest({ getTransaction: { transactionId: 'tx-1', extra: 'foo' } })).toThrow(
      '`getTransaction` must only contain `transactionId`'
    );
  });

  test('accepts x402 as boolean in xdr request', () => {
    const out = validateAndParseRequest({ xdr: 'BASE64XDR', x402: true });
    expect(out).toEqual({ type: 'xdr', xdr: 'BASE64XDR', skipWait: false, x402: true });
  });

  test('x402 defaults to false in xdr request', () => {
    const out = validateAndParseRequest({ xdr: 'BASE64XDR' });
    expect((out as any).x402).toBe(false);
  });

  test('rejects non-boolean x402 in xdr request', () => {
    expect(() => validateAndParseRequest({ xdr: 'BASE64XDR', x402: 'true' })).toThrow('`x402` must be a boolean');
    expect(() => validateAndParseRequest({ xdr: 'BASE64XDR', x402: 1 })).toThrow('`x402` must be a boolean');
  });

  test('accepts x402 as boolean in func+auth request', () => {
    const contract = new Contract('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    const op = contract.call('no_auth_bump', xdr.ScVal.scvU32(1)) as any;
    const body = op.body();
    const inv = body.invokeHostFunctionOp();
    const func = inv.hostFunction().toXDR('base64');
    const auth = (inv.auth() ?? []).map((a: any) => a.toXDR('base64'));
    const out = validateAndParseRequest({ func, auth, x402: true });
    expect(out.type).toBe('func-auth');
    expect((out as any).x402).toBe(true);
  });

  test('rejects non-boolean x402 in func+auth request', () => {
    const contract = new Contract('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    const op = contract.call('no_auth_bump', xdr.ScVal.scvU32(1)) as any;
    const body = op.body();
    const inv = body.invokeHostFunctionOp();
    const func = inv.hostFunction().toXDR('base64');
    const auth = (inv.auth() ?? []).map((a: any) => a.toXDR('base64'));
    expect(() => validateAndParseRequest({ func, auth, x402: 'yes' })).toThrow('`x402` must be a boolean');
  });

  test('rejects missing both', () => {
    expect(() => validateAndParseRequest({})).toThrow('Must pass either `xdr` or `func` and `auth`');
  });

  test('rejects missing func or missing auth', () => {
    expect(() => validateAndParseRequest({ func: 'AAAA' } as any)).toThrow('`func` and `auth` are both required');
    expect(() => validateAndParseRequest({ auth: [] } as any)).toThrow('`func` and `auth` are both required');
  });
});
