import { describe, test, expect } from 'vitest';
import { xdr, Contract } from '@stellar/stellar-sdk';
import { validateAndParseRequest } from '../validation';

describe('validation', () => {
  test('accepts xdr-only request', () => {
    const out = validateAndParseRequest({ xdr: 'BASE64XDR' });
    expect(out).toEqual({ type: 'xdr', xdr: 'BASE64XDR' });
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

  test('rejects missing both', () => {
    expect(() => validateAndParseRequest({})).toThrow('Must pass either `xdr` or `func` and `auth`');
  });

  test('rejects missing func or missing auth', () => {
    expect(() => validateAndParseRequest({ func: 'AAAA' } as any)).toThrow('`func` and `auth` are both required');
    expect(() => validateAndParseRequest({ auth: [] } as any)).toThrow('`func` and `auth` are both required');
  });
});
