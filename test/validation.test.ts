import { describe, test, expect } from 'vitest';
import { xdr, Contract } from '@stellar/stellar-sdk';
import { validateAndParseRequest } from '../src/plugin/validation';

describe('validation', () => {
  test('accepts xdr-only request', () => {
    const out = validateAndParseRequest({ xdr: 'BASE64XDR' });
    expect(out).toEqual({ type: 'xdr', xdr: 'BASE64XDR', skipWait: false, fundRelayerId: undefined });
  });

  test('rejects xdr with extra keys', () => {
    expect(() => validateAndParseRequest({ xdr: 'X', extra: 1 } as any)).toThrow(
      '`xdr` request must not include other parameters'
    );
  });

  test('accepts func+auth with valid base64', () => {
    const contract = new Contract('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    const op = contract.call('no_auth_bump', xdr.ScVal.scvU32(1)) as any;
    const body = op.body;
    const inv = body.invokeHostFunctionOp;
    const func = inv.hostFunction.toXdr('base64');
    const auth = (inv.auth ?? []).map((a: any) => a.toXdr('base64'));
    const out = validateAndParseRequest({ func, auth });
    expect(out.type).toBe('func-auth');
  });

  test('accepts xdr with skipWait without unknown-key error', () => {
    const out = validateAndParseRequest({ xdr: 'BASE64XDR', skipWait: true });
    expect(out).toEqual({ type: 'xdr', xdr: 'BASE64XDR', skipWait: true, fundRelayerId: undefined });
  });

  test('parses skipWait as boolean in func+auth', () => {
    const contract = new Contract('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    const op = contract.call('no_auth_bump', xdr.ScVal.scvU32(1)) as any;
    const body = op.body;
    const inv = body.invokeHostFunctionOp;
    const func = inv.hostFunction.toXdr('base64');
    const auth = (inv.auth ?? []).map((a: any) => a.toXdr('base64'));
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

  function buildAuthEntry(credentials: xdr.SorobanCredentials): string {
    const contractAddress = xdr.ScAddress.scAddressTypeContract(new xdr.ContractId(new Uint8Array(32)));
    return new xdr.SorobanAuthorizationEntry({
      credentials,
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({ contractAddress, functionName: 'test', args: [] })
        ),
        subInvocations: [],
      }),
    }).toXdr('base64');
  }

  function addressCredentials(): xdr.SorobanAddressCredentials {
    return new xdr.SorobanAddressCredentials({
      address: xdr.ScAddress.scAddressTypeContract(new xdr.ContractId(new Uint8Array(32))),
      nonce: 0n,
      signatureExpirationLedger: 100,
      signature: xdr.ScVal.scvVoid(),
    });
  }

  function hostFunctionXdr(): string {
    const contract = new Contract('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    const body = contract.call('no_auth_bump', xdr.ScVal.scvU32(1)).body;
    if (body.type !== 'invokeHostFunction') throw new Error('expected invokeHostFunction');
    return body.invokeHostFunctionOp.hostFunction.toXdr('base64');
  }

  test('accepts legacy address auth entries', () => {
    const auth = [buildAuthEntry(xdr.SorobanCredentials.sorobanCredentialsAddress(addressCredentials()))];
    const out = validateAndParseRequest({ func: hostFunctionXdr(), auth });
    expect(out.type).toBe('func-auth');
    if (out.type !== 'func-auth') return;
    expect(out.auth[0].credentials.type).toBe('sorobanCredentialsAddress');
  });

  test('accepts CAP-71 addressV2 auth entries (Protocol 27+ default, mandatory in Protocol 28)', () => {
    const auth = [buildAuthEntry(xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentials()))];
    const out = validateAndParseRequest({ func: hostFunctionXdr(), auth });
    expect(out.type).toBe('func-auth');
    if (out.type !== 'func-auth') return;
    expect(out.auth[0].credentials.type).toBe('sorobanCredentialsAddressV2');
  });

  test('rejects source-account auth entries', () => {
    const auth = [buildAuthEntry(xdr.SorobanCredentials.sorobanCredentialsSourceAccount())];
    expect(() => validateAndParseRequest({ func: hostFunctionXdr(), auth })).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' })
    );
  });

  test('rejects non-boolean skipWait in func+auth request', () => {
    const contract = new Contract('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    const op = contract.call('no_auth_bump', xdr.ScVal.scvU32(1)) as any;
    const body = op.body;
    const inv = body.invokeHostFunctionOp;
    const func = inv.hostFunction.toXdr('base64');
    const auth = (inv.auth ?? []).map((a: any) => a.toXdr('base64'));
    expect(() => validateAndParseRequest({ func, auth, skipWait: 'true' })).toThrow('`skipWait` must be a boolean');
  });

  test('accepts getTransaction request', () => {
    const out = validateAndParseRequest({ getTransaction: { transactionId: 'tx-1' } });
    expect(out).toEqual({ type: 'get-transaction', transactionId: 'tx-1', fundRelayerId: undefined });
  });

  test('trims getTransaction transactionId', () => {
    const out = validateAndParseRequest({ getTransaction: { transactionId: '  tx-2  ' } });
    expect(out).toEqual({ type: 'get-transaction', transactionId: 'tx-2', fundRelayerId: undefined });
  });

  test('accepts getTransaction with fundRelayerId', () => {
    const out = validateAndParseRequest({ getTransaction: { transactionId: 'tx-1' }, fundRelayerId: 'x402-fund' });
    expect(out).toEqual({ type: 'get-transaction', transactionId: 'tx-1', fundRelayerId: 'x402-fund' });
  });

  test('rejects getTransaction with non-string fundRelayerId', () => {
    expect(() => validateAndParseRequest({ getTransaction: { transactionId: 'tx-1' }, fundRelayerId: true })).toThrow(
      '`fundRelayerId` must be a non-empty string'
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

  test('accepts fundRelayerId as string in xdr request', () => {
    const out = validateAndParseRequest({ xdr: 'BASE64XDR', fundRelayerId: 'x402-fund' });
    expect(out).toEqual({ type: 'xdr', xdr: 'BASE64XDR', skipWait: false, fundRelayerId: 'x402-fund' });
  });

  test('fundRelayerId defaults to undefined in xdr request', () => {
    const out = validateAndParseRequest({ xdr: 'BASE64XDR' });
    expect((out as any).fundRelayerId).toBeUndefined();
  });

  test('rejects non-string fundRelayerId in xdr request', () => {
    expect(() => validateAndParseRequest({ xdr: 'BASE64XDR', fundRelayerId: true })).toThrow(
      '`fundRelayerId` must be a non-empty string'
    );
    expect(() => validateAndParseRequest({ xdr: 'BASE64XDR', fundRelayerId: 1 })).toThrow(
      '`fundRelayerId` must be a non-empty string'
    );
  });

  test('rejects empty string fundRelayerId in xdr request', () => {
    expect(() => validateAndParseRequest({ xdr: 'BASE64XDR', fundRelayerId: '' })).toThrow(
      '`fundRelayerId` must be a non-empty string'
    );
    expect(() => validateAndParseRequest({ xdr: 'BASE64XDR', fundRelayerId: '  ' })).toThrow(
      '`fundRelayerId` must be a non-empty string'
    );
  });

  test('accepts fundRelayerId as string in func+auth request', () => {
    const contract = new Contract('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    const op = contract.call('no_auth_bump', xdr.ScVal.scvU32(1)) as any;
    const body = op.body;
    const inv = body.invokeHostFunctionOp;
    const func = inv.hostFunction.toXdr('base64');
    const auth = (inv.auth ?? []).map((a: any) => a.toXdr('base64'));
    const out = validateAndParseRequest({ func, auth, fundRelayerId: 'x402-fund' });
    expect(out.type).toBe('func-auth');
    expect((out as any).fundRelayerId).toBe('x402-fund');
  });

  test('rejects non-string fundRelayerId in func+auth request', () => {
    const contract = new Contract('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    const op = contract.call('no_auth_bump', xdr.ScVal.scvU32(1)) as any;
    const body = op.body;
    const inv = body.invokeHostFunctionOp;
    const func = inv.hostFunction.toXdr('base64');
    const auth = (inv.auth ?? []).map((a: any) => a.toXdr('base64'));
    expect(() => validateAndParseRequest({ func, auth, fundRelayerId: 123 })).toThrow(
      '`fundRelayerId` must be a non-empty string'
    );
  });

  test('rejects missing both', () => {
    expect(() => validateAndParseRequest({})).toThrow('Must pass either `xdr` or `func` and `auth`');
  });

  test('rejects missing func or missing auth', () => {
    expect(() => validateAndParseRequest({ func: 'AAAA' } as any)).toThrow('`func` and `auth` are both required');
    expect(() => validateAndParseRequest({ auth: [] } as any)).toThrow('`func` and `auth` are both required');
  });
});
