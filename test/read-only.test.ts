import { describe, test, expect, vi, beforeEach } from 'vitest';
import { Contract, Networks, SorobanDataBuilder, xdr } from '@stellar/stellar-sdk';
import { simulateTransaction, buildWithChannel, SimulationResult } from '../src/plugin/simulation';

// Build a minimal SorobanTransactionData with empty readWrite footprint (read-only)
function buildReadOnlyTransactionData(): string {
  const sorobanData = new SorobanDataBuilder().build();
  return sorobanData.toXdr('base64');
}

// Build a SorobanTransactionData with a readWrite footprint entry (write)
function buildWriteTransactionData(): string {
  const entry = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: xdr.ScAddress.scAddressTypeContract(new xdr.ContractId(new Uint8Array(32))),
      key: xdr.ScVal.scvBool(true),
      durability: xdr.ContractDataDurability.persistent,
    })
  );
  const sorobanData = new SorobanDataBuilder().setFootprint([entry], [entry]).build();
  return sorobanData.toXdr('base64');
}

function buildWriteTransactionDataWithResourceFee(resourceFee: bigint): string {
  const entry = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: xdr.ScAddress.scAddressTypeContract(new xdr.ContractId(new Uint8Array(32))),
      key: xdr.ScVal.scvBool(true),
      durability: xdr.ContractDataDurability.persistent,
    })
  );
  const sorobanData = new SorobanDataBuilder().setFootprint([entry], [entry]).setResourceFee(resourceFee).build();
  return sorobanData.toXdr('base64');
}

function makeRelayerMock(result: object, error?: any) {
  return {
    rpc: vi.fn().mockResolvedValue({
      id: '1',
      result,
      error: error ?? null,
    }),
  } as any;
}

const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const SOURCE_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('simulateTransaction', () => {
  const passphrase = Networks.TESTNET;
  let func: xdr.HostFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    const contract = new Contract(CONTRACT_ID);
    // Build a host function for a contract call
    const op = contract.call('balance', xdr.ScVal.scvBool(true));
    // Extract the HostFunction from the operation XDR
    const body = op.body;
    if (body.type !== 'invokeHostFunction') throw new Error('expected invokeHostFunction');
    func = body.invokeHostFunctionOp.hostFunction;
  });

  test('returns isReadOnly=true when no auth and no readWrite footprint', async () => {
    const relayer = makeRelayerMock({
      results: [{ xdr: 'AAAAAQ==', auth: [] }],
      transactionData: buildReadOnlyTransactionData(),
      latestLedger: 12345,
      minResourceFee: '100',
    });

    const result = await simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase);

    expect(result.isReadOnly).toBe(true);
    expect(result.returnValue).toBe('AAAAAQ==');
    expect(result.latestLedger).toBe(12345);
  });

  test('returns isReadOnly=true when auth field is absent in results', async () => {
    const relayer = makeRelayerMock({
      results: [{ xdr: 'AAAAAQ==' }],
      transactionData: buildReadOnlyTransactionData(),
      latestLedger: 12345,
      minResourceFee: '100',
    });

    const result = await simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase);

    expect(result.isReadOnly).toBe(true);
    expect(result.returnValue).toBe('AAAAAQ==');
  });

  test('returns isReadOnly=false when auth entries are present', async () => {
    const relayer = makeRelayerMock({
      results: [{ xdr: 'AAAAAQ==', auth: ['some_auth_entry_base64'] }],
      transactionData: buildReadOnlyTransactionData(),
      latestLedger: 12345,
      minResourceFee: '100',
    });

    const result = await simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase);

    expect(result.isReadOnly).toBe(false);
    expect(result.returnValue).toBeUndefined();
  });

  test('returns isReadOnly=false when readWrite footprint entries are present', async () => {
    const relayer = makeRelayerMock({
      results: [{ xdr: 'AAAAAQ==', auth: [] }],
      transactionData: buildWriteTransactionData(),
      latestLedger: 12345,
      minResourceFee: '100',
    });

    const result = await simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase);

    expect(result.isReadOnly).toBe(false);
    expect(result.returnValue).toBeUndefined();
  });

  test('returns isReadOnly=false when both auth and readWrite footprint are present', async () => {
    const relayer = makeRelayerMock({
      results: [{ xdr: 'AAAAAQ==', auth: ['some_auth'] }],
      transactionData: buildWriteTransactionData(),
      latestLedger: 12345,
      minResourceFee: '100',
    });

    const result = await simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase);

    expect(result.isReadOnly).toBe(false);
  });

  test('treats invalid transactionData as not read-only (safe fallback)', async () => {
    const relayer = makeRelayerMock({
      results: [{ xdr: 'AAAAAQ==', auth: [] }],
      transactionData: 'invalid_base64_data!!!',
      latestLedger: 12345,
      minResourceFee: '100',
    });

    const result = await simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase);

    expect(result.isReadOnly).toBe(false);
  });

  test('treats missing transactionData as read-only when no auth', async () => {
    const relayer = makeRelayerMock({
      results: [{ xdr: 'AAAAAQ==', auth: [] }],
      latestLedger: 12345,
      minResourceFee: '100',
    });

    const result = await simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase);

    // No transactionData means hasReadWrite stays false, and no auth → read-only
    expect(result.isReadOnly).toBe(true);
  });

  test('treats missing results as read-only when no transactionData', async () => {
    const relayer = makeRelayerMock({
      latestLedger: 12345,
      minResourceFee: '100',
    });

    const result = await simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase);

    // No results means no auth, no transactionData means no readWrite → read-only
    // returnValue will be undefined since there are no results
    expect(result.isReadOnly).toBe(true);
    expect(result.returnValue).toBeUndefined();
  });

  test('propagates simulation network errors', async () => {
    const relayer = {
      rpc: vi.fn().mockRejectedValue(new Error('Network timeout')),
    } as any;

    await expect(simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase)).rejects.toThrow(
      'Simulation network request failed'
    );
  });

  test('propagates RPC errors', async () => {
    const relayer = {
      rpc: vi.fn().mockResolvedValue({
        id: '1',
        result: null,
        error: { code: -32600, message: 'Invalid request' },
      }),
    } as any;

    await expect(simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase)).rejects.toThrow(
      'Simulation RPC failed'
    );
  });

  test('propagates simulation execution errors', async () => {
    const relayer = makeRelayerMock({
      error: 'HostError: Error(Contract, #1)\ndata: "Insufficient balance"',
      latestLedger: 12345,
    });

    await expect(simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase)).rejects.toThrow(
      'Simulation failed'
    );
  });

  test('maps enforce-mode auth failures to dedicated validation error', async () => {
    const relayer = makeRelayerMock({
      error:
        'HostError: Error(Auth, InvalidInput)\n' +
        'Event log (newest first):\n' +
        '0: [Diagnostic Event] topics:[error, Error(Auth, InvalidInput)], data:"signature has expired"',
      latestLedger: 12345,
    });

    try {
      await simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase);
      throw new Error('Expected simulateTransaction to throw');
    } catch (err: any) {
      expect(err.code).toBe('SIMULATION_SIGNED_AUTH_VALIDATION_FAILED');
      expect(String(err.message)).toContain('Signed auth entry validation failed in enforce simulation');
      expect(String(err.message)).toContain('signature has expired (Auth, InvalidInput)');
    }
  });

  test('passes auth parameter through to the simulation', async () => {
    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: xdr.ScAddress.scAddressTypeContract(new xdr.ContractId(new Uint8Array(32))),
            functionName: 'test',
            args: [],
          })
        ),
        subInvocations: [],
      }),
    });
    // round-trip through XDR to mirror what the handler receives
    const authEntryParsed = xdr.SorobanAuthorizationEntry.fromXdr(authEntry.toXdr());

    const relayer = makeRelayerMock({
      results: [{ xdr: 'AAAAAQ==', auth: [] }],
      transactionData: buildReadOnlyTransactionData(),
      latestLedger: 12345,
      minResourceFee: '100',
    });

    // Should not throw when passing auth entries
    const result = await simulateTransaction(func, [authEntryParsed], SOURCE_ADDRESS, relayer, passphrase);
    expect(result).toBeDefined();

    // Verify the relayer.rpc was called (transaction was built and sent)
    expect(relayer.rpc).toHaveBeenCalledTimes(1);
    expect(relayer.rpc).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'simulateTransaction',
        params: expect.objectContaining({
          authMode: 'enforce',
        }),
      })
    );
  });

  test('returns rawSimResult for reuse by buildWithChannel', async () => {
    const rpcResult = {
      results: [{ xdr: 'AAAAAQ==', auth: ['some_auth'] }],
      transactionData: buildWriteTransactionData(),
      latestLedger: 12345,
      minResourceFee: '100',
    };
    const relayer = makeRelayerMock(rpcResult);

    const result = await simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase);

    expect(result.isReadOnly).toBe(false);
    expect(result.rawSimResult).toBeDefined();
    expect(result.rawSimResult.latestLedger).toBe(12345);
    expect(result.rawSimResult.minResourceFee).toBe('100');
  });
});

describe('buildWithChannel', () => {
  const passphrase = Networks.TESTNET;
  const CHANNEL_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  let func: xdr.HostFunction;

  beforeEach(() => {
    const contract = new Contract(CONTRACT_ID);
    const op = contract.call('balance', xdr.ScVal.scvBool(true));
    const body = op.body;
    if (body.type !== 'invokeHostFunction') throw new Error('expected invokeHostFunction');
    func = body.invokeHostFunctionOp.hostFunction;
  });

  function buildAuthEntryXdr(
    expiryLedger: number,
    variant:
      | 'sorobanCredentialsAddress'
      | 'sorobanCredentialsAddressV2'
      | 'sorobanCredentialsAddressWithDelegates' = 'sorobanCredentialsAddress'
  ): xdr.SorobanAuthorizationEntry {
    const addressCredentials = new xdr.SorobanAddressCredentials({
      address: xdr.ScAddress.scAddressTypeContract(new xdr.ContractId(new Uint8Array(32))),
      nonce: 0n,
      signatureExpirationLedger: expiryLedger,
      signature: xdr.ScVal.scvVoid(),
    });
    return new xdr.SorobanAuthorizationEntry({
      credentials:
        variant === 'sorobanCredentialsAddressV2'
          ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentials)
          : variant === 'sorobanCredentialsAddressWithDelegates'
            ? xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
                new xdr.SorobanAddressCredentialsWithDelegates({ addressCredentials, delegates: [] })
              )
            : xdr.SorobanCredentials.sorobanCredentialsAddress(addressCredentials),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: xdr.ScAddress.scAddressTypeContract(new xdr.ContractId(new Uint8Array(32))),
            functionName: 'test',
            args: [],
          })
        ),
        subInvocations: [],
      }),
    });
  }

  test('rejects CAP-71 addressV2 auth entries with expiry below minSignatureExpirationLedgerBuffer', async () => {
    const latestLedger = 10000;
    const authEntry = buildAuthEntryXdr(latestLedger + 1, 'sorobanCredentialsAddressV2');
    const rpcResult = {
      results: [{ xdr: 'AAAAAQ==', auth: [authEntry.toXdr('base64')] }],
      transactionData: buildWriteTransactionData(),
      latestLedger,
      minResourceFee: '100',
    };
    const channel = { address: SOURCE_ADDRESS, sequence: '1' };

    expect(() => buildWithChannel(func, undefined, channel, passphrase, rpcResult as any)).toThrow(
      expect.objectContaining({ code: 'AUTH_EXPIRY_TOO_SHORT' })
    );
  });

  test('rejects CAP-71 addressWithDelegates auth entries with expiry below minSignatureExpirationLedgerBuffer', async () => {
    const latestLedger = 10000;
    const authEntry = buildAuthEntryXdr(latestLedger + 1, 'sorobanCredentialsAddressWithDelegates');
    const rpcResult = {
      results: [{ xdr: 'AAAAAQ==', auth: [authEntry.toXdr('base64')] }],
      transactionData: buildWriteTransactionData(),
      latestLedger,
      minResourceFee: '100',
    };
    const channel = { address: SOURCE_ADDRESS, sequence: '1' };

    expect(() => buildWithChannel(func, undefined, channel, passphrase, rpcResult as any)).toThrow(
      expect.objectContaining({ code: 'AUTH_EXPIRY_TOO_SHORT' })
    );
  });

  test('accepts CAP-71 addressV2 auth entries returned by simulation when expiry margin is sufficient', async () => {
    const latestLedger = 10000;
    const authEntry = buildAuthEntryXdr(latestLedger + 100, 'sorobanCredentialsAddressV2');
    const rpcResult = {
      results: [{ xdr: 'AAAAAQ==', auth: [authEntry.toXdr('base64')] }],
      transactionData: buildWriteTransactionData(),
      latestLedger,
      minResourceFee: '100',
    };
    const channel = { address: SOURCE_ADDRESS, sequence: '1' };

    const tx = buildWithChannel(func, undefined, channel, passphrase, rpcResult as any);
    const envelope = tx.toEnvelope();
    if (envelope.type !== 'envelopeTypeTx') throw new Error('expected envelopeTypeTx');
    const body = envelope.v1.tx.operations[0].body;
    if (body.type !== 'invokeHostFunction') throw new Error('expected invokeHostFunction');
    expect(body.invokeHostFunctionOp.auth).toHaveLength(1);
    expect(body.invokeHostFunctionOp.auth[0].credentials.type).toBe('sorobanCredentialsAddressV2');
  });

  test('rejects when auth signatureExpirationLedger is below minSignatureExpirationLedgerBuffer', async () => {
    const latestLedger = 10000;
    // expiry = 10001 → margin = 1, default buffer = 2 → should reject
    const authEntry = buildAuthEntryXdr(latestLedger + 1);
    const rpcResult = {
      results: [{ xdr: 'AAAAAQ==', auth: [authEntry.toXdr('base64')] }],
      transactionData: buildWriteTransactionData(),
      latestLedger,
      minResourceFee: '100',
    };
    const relayer = makeRelayerMock(rpcResult);
    const simResult = await simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase);

    try {
      buildWithChannel(
        func,
        [authEntry],
        { address: CHANNEL_ADDRESS, sequence: '100' },
        passphrase,
        simResult.rawSimResult
      );
      throw new Error('Expected buildWithChannel to throw');
    } catch (err: any) {
      expect(err.code).toBe('AUTH_EXPIRY_TOO_SHORT');
      expect(err.details.margin).toBe(1);
      expect(err.details.minimumRequired).toBe(2);
    }
  });

  test('rejects when auth expiry margin is below custom minSignatureExpirationLedgerBuffer', async () => {
    const latestLedger = 10000;
    // expiry = 10004 → margin = 4, custom buffer = 5 → should reject
    const authEntry = buildAuthEntryXdr(latestLedger + 4);
    const rpcResult = {
      results: [{ xdr: 'AAAAAQ==', auth: [authEntry.toXdr('base64')] }],
      transactionData: buildWriteTransactionData(),
      latestLedger,
      minResourceFee: '100',
    };
    const relayer = makeRelayerMock(rpcResult);
    const simResult = await simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase);

    try {
      buildWithChannel(
        func,
        [authEntry],
        { address: CHANNEL_ADDRESS, sequence: '100' },
        passphrase,
        simResult.rawSimResult,
        5
      );
      throw new Error('Expected buildWithChannel to throw');
    } catch (err: any) {
      expect(err.code).toBe('AUTH_EXPIRY_TOO_SHORT');
      expect(err.details.margin).toBe(4);
      expect(err.details.minimumRequired).toBe(5);
    }
  });

  test('accepts when auth expiry margin meets custom minSignatureExpirationLedgerBuffer', async () => {
    const latestLedger = 10000;
    // expiry = 10005 → margin = 5, custom buffer = 5 → should pass
    const authEntry = buildAuthEntryXdr(latestLedger + 5);
    const rpcResult = {
      results: [{ xdr: 'AAAAAQ==', auth: [authEntry.toXdr('base64')] }],
      transactionData: buildWriteTransactionData(),
      latestLedger,
      minResourceFee: '100',
    };
    const relayer = makeRelayerMock(rpcResult);
    const simResult = await simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase);

    const tx = buildWithChannel(
      func,
      [authEntry],
      { address: CHANNEL_ADDRESS, sequence: '100' },
      passphrase,
      simResult.rawSimResult,
      5
    );
    expect(tx).toBeDefined();
    expect(tx.source).toBe(CHANNEL_ADDRESS);
  });

  test('assembles a transaction from cached simulation result without network calls', async () => {
    // First simulate to get a real rawSimResult
    const rpcResult = {
      results: [{ xdr: 'AAAAAQ==', auth: [] }],
      transactionData: buildWriteTransactionData(),
      latestLedger: 12345,
      minResourceFee: '100',
    };
    const relayer = makeRelayerMock(rpcResult);
    const simResult = await simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase);

    // buildWithChannel should NOT make any network calls
    const tx = buildWithChannel(
      func,
      [],
      { address: CHANNEL_ADDRESS, sequence: '100' },
      passphrase,
      simResult.rawSimResult
    );

    expect(tx).toBeDefined();
    expect(tx.source).toBe(CHANNEL_ADDRESS);
    // Verify the relayer was only called once (by simulateTransaction, not by buildWithChannel)
    expect(relayer.rpc).toHaveBeenCalledTimes(1);
  });

  test('builds inner tx fee as classic fee + resource fee exactly once', async () => {
    const resourceFee = 25102n;
    const rpcResult = {
      results: [{ xdr: 'AAAAAQ==', auth: [] }],
      transactionData: buildWriteTransactionDataWithResourceFee(resourceFee),
      latestLedger: 12345,
      // Intentionally set doubled minResourceFee to mirror problematic provider responses.
      minResourceFee: (resourceFee * 2n).toString(),
    };
    const relayer = makeRelayerMock(rpcResult);
    const simResult = await simulateTransaction(func, [], SOURCE_ADDRESS, relayer, passphrase);

    const tx = buildWithChannel(
      func,
      [],
      { address: CHANNEL_ADDRESS, sequence: '100' },
      passphrase,
      simResult.rawSimResult
    );

    expect(tx.fee).toBe((100n + resourceFee).toString());
  });
});
