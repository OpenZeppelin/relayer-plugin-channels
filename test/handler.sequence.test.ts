import { describe, test, expect, vi, beforeEach } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';
import type { Relayer } from '@openzeppelin/relayer-sdk';
import { getAccountSequence } from '../src/plugin/sequence';

const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('getAccountSequence', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('returns sequence number on valid ledger response', async () => {
    vi.spyOn(xdr.LedgerEntryData, 'fromXDR').mockReturnValue({
      account: () => ({
        seqNum: () => ({
          toString: () => '123',
        }),
      }),
    } as unknown as xdr.LedgerEntryData);

    const relayer = {
      rpc: vi.fn().mockResolvedValue({
        id: '1',
        result: { entries: [{ xdr: 'AAAA' }] },
        error: null,
      }),
    } as unknown as Relayer;

    await expect(getAccountSequence(relayer, ADDRESS)).resolves.toBe('123');
  });

  test('throws FAILED_TO_GET_SEQUENCE when RPC returns error', async () => {
    const relayer = {
      rpc: vi.fn().mockResolvedValue({
        id: '1',
        result: null,
        error: { message: 'rpc failed' },
      }),
    } as unknown as Relayer;

    await expect(getAccountSequence(relayer, ADDRESS)).rejects.toMatchObject({
      code: 'FAILED_TO_GET_SEQUENCE',
    });
  });

  test('throws FAILED_TO_GET_SEQUENCE when result is malformed', async () => {
    const relayer = {
      rpc: vi.fn().mockResolvedValue({
        id: '1',
        result: {},
        error: null,
      }),
    } as unknown as Relayer;

    await expect(getAccountSequence(relayer, ADDRESS)).rejects.toMatchObject({
      code: 'FAILED_TO_GET_SEQUENCE',
    });
  });

  test('throws ACCOUNT_NOT_FOUND when entries is empty', async () => {
    const relayer = {
      rpc: vi.fn().mockResolvedValue({
        id: '1',
        result: { entries: [] },
        error: null,
      }),
    } as unknown as Relayer;

    await expect(getAccountSequence(relayer, ADDRESS)).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
  });

  test('throws FAILED_TO_GET_SEQUENCE when entry xdr is not a string', async () => {
    const relayer = {
      rpc: vi.fn().mockResolvedValue({
        id: '1',
        result: { entries: [{ xdr: 42 }] },
        error: null,
      }),
    } as unknown as Relayer;

    await expect(getAccountSequence(relayer, ADDRESS)).rejects.toMatchObject({
      code: 'FAILED_TO_GET_SEQUENCE',
    });
  });

  test('throws FAILED_TO_GET_SEQUENCE when xdr decode fails', async () => {
    vi.spyOn(xdr.LedgerEntryData, 'fromXDR').mockImplementation(() => {
      throw new Error('invalid xdr');
    });

    const relayer = {
      rpc: vi.fn().mockResolvedValue({
        id: '1',
        result: { entries: [{ xdr: 'AAAA' }] },
        error: null,
      }),
    } as unknown as Relayer;

    await expect(getAccountSequence(relayer, ADDRESS)).rejects.toMatchObject({
      code: 'FAILED_TO_GET_SEQUENCE',
    });
  });
});
