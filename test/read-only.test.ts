import { describe, test, expect, vi, beforeEach } from 'vitest';
import { Contract, Networks, SorobanDataBuilder, xdr } from '@stellar/stellar-sdk';
import { simulateTransaction, buildWithChannel, SimulationResult } from '../src/plugin/simulation';

// Build a minimal SorobanTransactionData with empty readWrite footprint (read-only)
function buildReadOnlyTransactionData(): string {
  const sorobanData = new SorobanDataBuilder().build();
  return sorobanData.toXDR('base64');
}

// Build a SorobanTransactionData with a readWrite footprint entry (write)
function buildWriteTransactionData(): string {
  const entry = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: xdr.ScAddress.scAddressTypeContract([...new Uint8Array(32)] as unknown as xdr.Hash),
      key: xdr.ScVal.scvBool(true),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  const sorobanData = new SorobanDataBuilder().setFootprint([entry], [entry]).build();
  return sorobanData.toXDR('base64');
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
    const opXdr = op.toXDR();
    const parsedOp = xdr.Operation.fromXDR(opXdr);
    func = parsedOp.body().invokeHostFunctionOp().hostFunction();
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
    const authEntry = xdr.SorobanAuthorizationEntry.fromXDR(
      xdr.SorobanAuthorizationEntry.toXDR(
        new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
          rootInvocation: new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              new xdr.InvokeContractArgs({
                contractAddress: xdr.ScAddress.scAddressTypeContract([...new Uint8Array(32)] as unknown as xdr.Hash),
                functionName: 'test',
                args: [],
              })
            ),
            subInvocations: [],
          }),
        })
      )
    );

    const relayer = makeRelayerMock({
      results: [{ xdr: 'AAAAAQ==', auth: [] }],
      transactionData: buildReadOnlyTransactionData(),
      latestLedger: 12345,
      minResourceFee: '100',
    });

    // Should not throw when passing auth entries
    const result = await simulateTransaction(func, [authEntry], SOURCE_ADDRESS, relayer, passphrase);
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
    const opXdr = op.toXDR();
    const parsedOp = xdr.Operation.fromXDR(opXdr);
    func = parsedOp.body().invokeHostFunctionOp().hostFunction();
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
});
