import { ChannelsClient } from '../src/client/channels-client';
import { PluginTransportError, PluginExecutionError, PluginUnexpectedError } from '../src/client/errors';
import axios from 'axios';
import { PluginsApi, Configuration } from '@openzeppelin/relayer-sdk';
import { describe, test, expect, beforeEach, vi } from 'vitest';

// Mock axios
vi.mock('axios');
const mockedAxios = axios as any;

// Mock PluginsApi
vi.mock('@openzeppelin/relayer-sdk', () => ({
  Configuration: vi.fn(),
  PluginsApi: vi.fn(),
}));

describe('ChannelsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Configuration', () => {
    test('should configure direct HTTP connection when pluginId is not provided', () => {
      const mockAxiosInstance = {
        post: vi.fn(),
      };
      mockedAxios.create.mockReturnValue(mockAxiosInstance as any);

      new ChannelsClient({
        baseUrl: 'https://channels.example.com',
        apiKey: 'test-api-key',
      });

      expect(mockedAxios.create).toHaveBeenCalledWith({
        baseURL: 'https://channels.example.com',
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-api-key',
        },
      });
    });

    test('should configure relayer connection when pluginId is provided', () => {
      const mockPluginsApi = {
        callPlugin: vi.fn(),
      };
      (PluginsApi as any).mockImplementation(function (this: any) {
        return mockPluginsApi;
      });

      new ChannelsClient({
        pluginId: 'test-plugin-id',
        apiKey: 'test-api-key',
        baseUrl: 'https://relayer.example.com',
      });

      expect(Configuration).toHaveBeenCalledWith({
        basePath: 'https://relayer.example.com',
        accessToken: 'test-api-key',
      });
      expect(PluginsApi).toHaveBeenCalled();
    });

    test('should throw error when baseUrl is missing without pluginId', () => {
      expect(() => {
        new ChannelsClient({
          apiKey: 'test-api-key',
        } as any);
      }).toThrow('baseUrl is required when pluginId is not provided');
    });

    test('should respect custom timeout', () => {
      const mockAxiosInstance = {
        post: vi.fn(),
      };
      mockedAxios.create.mockReturnValue(mockAxiosInstance as any);

      new ChannelsClient({
        baseUrl: 'https://channels.example.com',
        apiKey: 'test-api-key',
        timeout: 60000,
      });

      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: 60000,
        })
      );
    });
  });

  describe('submitTransaction - Direct HTTP', () => {
    let client: ChannelsClient;
    let mockAxiosInstance: any;

    beforeEach(() => {
      mockAxiosInstance = {
        post: vi.fn(),
      };
      mockedAxios.create.mockReturnValue(mockAxiosInstance);

      client = new ChannelsClient({
        baseUrl: 'https://channels.example.com',
        apiKey: 'test-api-key',
      });
    });

    test('should submit XDR transaction successfully', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          success: true,
          data: {
            transactionId: 'tx-123',
            hash: 'hash-abc',
            status: 'confirmed',
          },
        },
      });

      const result = await client.submitTransaction({
        xdr: 'AAAAAgAAAAC...',
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/', {
        params: {
          xdr: 'AAAAAgAAAAC...',
        },
      });

      expect(result).toEqual({
        transactionId: 'tx-123',
        hash: 'hash-abc',
        status: 'confirmed',
      });
    });

    test('should include metadata in response', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          success: true,
          data: {
            transactionId: 'tx-123',
            hash: 'hash-abc',
            status: 'confirmed',
          },
          metadata: {
            logs: [{ level: 'info', message: 'Transaction processed' }],
            traces: [{ action: 'simulate' }],
          },
        },
      });

      const result = await client.submitTransaction({
        xdr: 'AAAAAgAAAAC...',
      });

      expect(result.metadata).toEqual({
        logs: [{ level: 'info', message: 'Transaction processed' }],
        traces: [{ action: 'simulate' }],
      });
    });
  });

  describe('submitSorobanTransaction - Direct HTTP', () => {
    let client: ChannelsClient;
    let mockAxiosInstance: any;

    beforeEach(() => {
      mockAxiosInstance = {
        post: vi.fn(),
      };
      mockedAxios.create.mockReturnValue(mockAxiosInstance);

      client = new ChannelsClient({
        baseUrl: 'https://channels.example.com',
        apiKey: 'test-api-key',
      });
    });

    test('should submit func+auth transaction successfully', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          success: true,
          data: {
            transactionId: 'tx-456',
            hash: 'hash-def',
            status: 'confirmed',
          },
        },
      });

      const result = await client.submitSorobanTransaction({
        func: 'BASE64FUNC',
        auth: ['AUTH1', 'AUTH2'],
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/', {
        params: {
          func: 'BASE64FUNC',
          auth: ['AUTH1', 'AUTH2'],
        },
      });

      expect(result).toEqual({
        transactionId: 'tx-456',
        hash: 'hash-def',
        status: 'confirmed',
      });
    });
  });

  describe('submitTransaction - Via Relayer', () => {
    let client: ChannelsClient;
    let mockPluginsApi: any;

    beforeEach(() => {
      mockPluginsApi = {
        callPlugin: vi.fn(),
      };
      (PluginsApi as any).mockImplementation(function (this: any) {
        return mockPluginsApi;
      });

      client = new ChannelsClient({
        pluginId: 'test-plugin-id',
        apiKey: 'test-api-key',
        baseUrl: 'https://relayer.example.com',
      });
    });

    test('should submit transaction successfully via relayer', async () => {
      mockPluginsApi.callPlugin.mockResolvedValue({
        data: {
          success: true,
          data: {
            transactionId: 'tx-789',
            hash: 'hash-ghi',
            status: 'confirmed',
          },
        },
      });

      const result = await client.submitTransaction({
        xdr: 'AAAAAgAAAAC...',
      });

      expect(mockPluginsApi.callPlugin).toHaveBeenCalledWith('test-plugin-id', {
        params: {
          xdr: 'AAAAAgAAAAC...',
        },
      });

      expect(result).toEqual({
        transactionId: 'tx-789',
        hash: 'hash-ghi',
        status: 'confirmed',
      });
    });
  });

  describe('listChannelAccounts', () => {
    let client: ChannelsClient;
    let mockAxiosInstance: any;

    beforeEach(() => {
      mockAxiosInstance = {
        post: vi.fn(),
      };
      mockedAxios.create.mockReturnValue(mockAxiosInstance);

      client = new ChannelsClient({
        baseUrl: 'https://channels.example.com',
        apiKey: 'test-api-key',
        adminSecret: 'admin-secret',
      });
    });

    test('should list channel accounts successfully', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          success: true,
          data: {
            relayerIds: ['channel-001', 'channel-002'],
          },
        },
      });

      const result = await client.listChannelAccounts();

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/', {
        params: {
          management: {
            action: 'listChannelAccounts',
            adminSecret: 'admin-secret',
          },
        },
      });

      expect(result).toEqual({
        relayerIds: ['channel-001', 'channel-002'],
      });
    });

    test('should throw error when adminSecret is not provided', async () => {
      const clientWithoutSecret = new ChannelsClient({
        baseUrl: 'https://channels.example.com',
        apiKey: 'test-api-key',
      });

      await expect(clientWithoutSecret.listChannelAccounts()).rejects.toThrow(
        'adminSecret required for management operations'
      );
    });
  });

  describe('setChannelAccounts', () => {
    let client: ChannelsClient;
    let mockAxiosInstance: any;

    beforeEach(() => {
      mockAxiosInstance = {
        post: vi.fn(),
      };
      mockedAxios.create.mockReturnValue(mockAxiosInstance);

      client = new ChannelsClient({
        baseUrl: 'https://channels.example.com',
        apiKey: 'test-api-key',
        adminSecret: 'admin-secret',
      });
    });

    test('should set channel accounts successfully', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          success: true,
          data: {
            ok: true,
            appliedRelayerIds: ['channel-001', 'channel-002'],
          },
        },
      });

      const result = await client.setChannelAccounts(['channel-001', 'channel-002']);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/', {
        params: {
          management: {
            action: 'setChannelAccounts',
            adminSecret: 'admin-secret',
            relayerIds: ['channel-001', 'channel-002'],
          },
        },
      });

      expect(result).toEqual({
        ok: true,
        appliedRelayerIds: ['channel-001', 'channel-002'],
      });
    });

    test('should throw error when adminSecret is not provided', async () => {
      const clientWithoutSecret = new ChannelsClient({
        baseUrl: 'https://channels.example.com',
        apiKey: 'test-api-key',
      });

      await expect(clientWithoutSecret.setChannelAccounts(['channel-001'])).rejects.toThrow(
        'adminSecret required for management operations'
      );
    });
  });

  describe('Error Handling', () => {
    let client: ChannelsClient;
    let mockAxiosInstance: any;

    beforeEach(() => {
      mockAxiosInstance = {
        post: vi.fn(),
      };
      mockedAxios.create.mockReturnValue(mockAxiosInstance);

      client = new ChannelsClient({
        baseUrl: 'https://channels.example.com',
        apiKey: 'test-api-key',
      });
    });

    test('should throw PluginExecutionError when plugin returns error', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          success: false,
          error: 'Invalid transaction',
          data: { code: 'INVALID_TX' },
        },
      });

      await expect(
        client.submitTransaction({
          xdr: 'INVALID',
        })
      ).rejects.toThrow(PluginExecutionError);

      try {
        await client.submitTransaction({
          xdr: 'INVALID',
        });
      } catch (error: any) {
        expect(error.message).toBe('Invalid transaction');
        expect(error.category).toBe('execution');
        expect(error.errorDetails).toEqual({ code: 'INVALID_TX' });
      }
    });

    test('should throw PluginTransportError on network error', async () => {
      const axiosError = {
        isAxiosError: true,
        message: 'Network Error',
        response: {
          status: 503,
        },
      };
      (mockedAxios.isAxiosError as any) = vi.fn().mockReturnValue(true);
      mockAxiosInstance.post.mockRejectedValue(axiosError);

      await expect(
        client.submitTransaction({
          xdr: 'AAAAAgAAAAC...',
        })
      ).rejects.toThrow(PluginTransportError);

      try {
        await client.submitTransaction({
          xdr: 'AAAAAgAAAAC...',
        });
      } catch (error: any) {
        expect(error.category).toBe('transport');
        expect(error.statusCode).toBe(503);
      }
    });

    test('should throw PluginExecutionError on axios error with response data', async () => {
      const axiosError = {
        isAxiosError: true,
        message: 'Request failed',
        response: {
          status: 500,
          data: {
            success: false,
            error: 'Internal server error',
          },
        },
      };
      (mockedAxios.isAxiosError as any) = vi.fn().mockReturnValue(true);
      mockAxiosInstance.post.mockRejectedValue(axiosError);

      await expect(
        client.submitTransaction({
          xdr: 'AAAAAgAAAAC...',
        })
      ).rejects.toThrow(PluginExecutionError);
    });

    test('should throw PluginUnexpectedError on empty response', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: null,
      });

      await expect(
        client.submitTransaction({
          xdr: 'AAAAAgAAAAC...',
        })
      ).rejects.toThrow(PluginUnexpectedError);

      try {
        await client.submitTransaction({
          xdr: 'AAAAAgAAAAC...',
        });
      } catch (error: any) {
        expect(error.message).toBe('Empty or invalid response from plugin');
        expect(error.category).toBe('client');
      }
    });

    test('should throw PluginUnexpectedError on malformed response', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          // Missing success field
          data: { foo: 'bar' },
        },
      });

      await expect(
        client.submitTransaction({
          xdr: 'AAAAAgAAAAC...',
        })
      ).rejects.toThrow(PluginUnexpectedError);

      try {
        await client.submitTransaction({
          xdr: 'AAAAAgAAAAC...',
        });
      } catch (error: any) {
        expect(error.message).toBe('Malformed response: missing success field');
        expect(error.category).toBe('client');
      }
    });

    test('should throw PluginUnexpectedError on non-axios error', async () => {
      mockAxiosInstance.post.mockRejectedValue(new Error('Something went wrong'));
      (mockedAxios.isAxiosError as any) = vi.fn().mockReturnValue(false);

      await expect(
        client.submitTransaction({
          xdr: 'AAAAAgAAAAC...',
        })
      ).rejects.toThrow(PluginUnexpectedError);

      try {
        await client.submitTransaction({
          xdr: 'AAAAAgAAAAC...',
        });
      } catch (error: any) {
        expect(error.message).toContain('Unexpected error');
        expect(error.category).toBe('client');
      }
    });
  });
});
