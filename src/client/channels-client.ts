import axios, { AxiosInstance } from 'axios';
import { Configuration, PluginsApi } from '@openzeppelin/relayer-sdk';
import type { LogEntry } from '@openzeppelin/relayer-sdk';
import { PluginTransportError, PluginExecutionError, PluginUnexpectedError } from './errors';
import type {
  ChannelsClientConfig,
  ChannelsXdrRequest,
  ChannelsFuncAuthRequest,
  ChannelsTransactionResponse,
  ListChannelAccountsResponse,
  SetChannelAccountsResponse,
  GetFeeUsageResponse,
  PluginResponse,
} from './types';

/**
 * Client for interacting with the Channels plugin
 *
 * @example
 * // Connecting to OpenZeppelin's managed Channels service
 * const client = new ChannelsClient({
 *   baseUrl: 'https://channels.openzeppelin.com',
 *   apiKey: 'your-api-key',
 *   adminSecret: 'your-admin-secret', // Optional, for management operations
 * });
 *
 * @example
 * // Connecting to your own Relayer with Channels plugin
 * const client = new ChannelsClient({
 *   baseUrl: 'http://localhost:8080',
 *   pluginId: 'channels',
 *   apiKey: 'your-relayer-api-key',
 *   adminSecret: 'your-admin-secret', // Optional, for management operations
 * });
 */
export class ChannelsClient {
  private readonly adminSecret?: string;
  private readonly axiosClient?: AxiosInstance;
  private readonly pluginsApi?: PluginsApi;
  private readonly pluginId?: string;

  constructor(config: ChannelsClientConfig) {
    this.adminSecret = config.adminSecret;

    // Route through Relayer plugin system if pluginId provided, otherwise connect directly
    if ('pluginId' in config && config.pluginId) {
      this.pluginId = config.pluginId;
      const apiKeyHeader = config.apiKeyHeader || 'x-api-key';

      const relayerConfig = new Configuration({
        basePath: config.baseUrl,
        accessToken: config.apiKey,
        baseOptions: {
          headers: { [apiKeyHeader]: config.apiKey },
        },
      });

      this.pluginsApi = new PluginsApi(relayerConfig);
    } else {
      if (!('baseUrl' in config) || !config.baseUrl) {
        throw new Error('baseUrl is required when pluginId is not provided');
      }

      this.axiosClient = axios.create({
        baseURL: config.baseUrl,
        timeout: config.timeout || 30000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
      });
    }
  }

  /**
   * Submit a signed XDR transaction to the channel accounts service
   *
   * @param request Transaction request with signed XDR
   * @returns Transaction result with ID, hash, and status
   * @throws {PluginTransportError} Network/HTTP failures
   * @throws {PluginExecutionError} Plugin rejected the request
   * @throws {PluginUnexpectedError} Malformed response or client-side errors
   *
   * @example
   * const result = await client.submitTransaction({
   *   xdr: 'AAAAAgAAAAC...',
   * });
   */
  async submitTransaction(request: ChannelsXdrRequest): Promise<ChannelsTransactionResponse> {
    return this.call<ChannelsTransactionResponse>(request);
  }

  /**
   * Submit a Soroban transaction using function and authorization entries
   * This path uses channel accounts and includes automatic simulation
   *
   * @param request Transaction request with func and auth
   * @returns Transaction result with ID, hash, and status
   * @throws {PluginTransportError} Network/HTTP failures
   * @throws {PluginExecutionError} Plugin rejected the request
   * @throws {PluginUnexpectedError} Malformed response or client-side errors
   *
   * @example
   * const result = await client.submitSorobanTransaction({
   *   func: 'AAAABgAAAA...',
   *   auth: ['AAAABwAAAA...', 'AAAABwAAAA...'],
   * });
   */
  async submitSorobanTransaction(request: ChannelsFuncAuthRequest): Promise<ChannelsTransactionResponse> {
    return this.call<ChannelsTransactionResponse>(request);
  }

  /**
   * List currently configured channel accounts (requires adminSecret)
   *
   * @returns List of channel account relayer IDs
   * @throws {Error} If adminSecret not provided in config
   * @throws {PluginTransportError} Network/HTTP failures
   * @throws {PluginExecutionError} Plugin rejected the request
   * @throws {PluginUnexpectedError} Malformed response or client-side errors
   *
   * @example
   * const accounts = await client.listChannelAccounts();
   * console.log(accounts.relayerIds);
   */
  async listChannelAccounts(): Promise<ListChannelAccountsResponse> {
    return this.call<ListChannelAccountsResponse>({
      management: {
        action: 'listChannelAccounts',
        adminSecret: this.requireAdminSecret(),
      },
    });
  }

  /**
   * Configure channel accounts for the service (requires adminSecret)
   *
   * @param relayerIds Array of relayer IDs to use as channel accounts
   * @returns Confirmation with applied relayer IDs
   * @throws {Error} If adminSecret not provided in config
   * @throws {PluginTransportError} Network/HTTP failures
   * @throws {PluginExecutionError} Plugin rejected the request
   * @throws {PluginUnexpectedError} Malformed response or client-side errors
   *
   * @example
   * const result = await client.setChannelAccounts([
   *   'relayer-id-1',
   *   'relayer-id-2',
   * ]);
   */
  async setChannelAccounts(relayerIds: string[]): Promise<SetChannelAccountsResponse> {
    return this.call<SetChannelAccountsResponse>({
      management: {
        action: 'setChannelAccounts',
        adminSecret: this.requireAdminSecret(),
        relayerIds,
      },
    });
  }

  /**
   * Get fee usage for a specific API key (requires adminSecret)
   *
   * @param apiKey The client API key to query fee usage for
   * @returns Fee usage data including total consumed
   * @throws {Error} If adminSecret not provided in config
   * @throws {PluginTransportError} Network/HTTP failures
   * @throws {PluginExecutionError} Plugin rejected the request
   * @throws {PluginUnexpectedError} Malformed response or client-side errors
   *
   * @example
   * const usage = await client.getFeeUsage('client-api-key-123');
   * console.log(`Consumed: ${usage.consumed} stroops`);
   */
  async getFeeUsage(apiKey: string): Promise<GetFeeUsageResponse> {
    return this.call<GetFeeUsageResponse>({
      management: {
        action: 'getFeeUsage',
        adminSecret: this.requireAdminSecret(),
        apiKey,
      },
    });
  }

  /**
   * Ensures adminSecret is configured
   *
   * @returns The admin secret value
   * @throws {Error} If adminSecret not provided in config
   */
  private requireAdminSecret(): string {
    if (!this.adminSecret) {
      throw new Error('adminSecret required for management operations. Provide it in client config.');
    }
    return this.adminSecret;
  }

  /**
   * Parses axios errors and extracts response body if available
   *
   * @param error The caught error from axios
   * @returns Plugin response if available in error
   * @throws {PluginTransportError} For network/transport errors
   * @throws {PluginUnexpectedError} For unknown error types
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseAxiosError(error: unknown): PluginResponse<any> | never {
    if (axios.isAxiosError(error)) {
      if (error.response?.data) {
        // HTTP error with response body - return it for further processing
        return error.response.data;
      }
      // Network/transport error without response body
      throw new PluginTransportError(`Network error: ${error.message}`, error.response?.status, error);
    }
    // Unknown error type
    throw new PluginUnexpectedError(
      `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }

  /**
   * Validates that response has the expected plugin response structure
   *
   * @param responseBody The raw response body to validate
   * @returns Validated plugin response
   * @throws {PluginUnexpectedError} For invalid/malformed responses
   */
  private validateResponse<T>(responseBody: unknown): PluginResponse<T> {
    if (!responseBody || typeof responseBody !== 'object') {
      throw new PluginUnexpectedError('Empty or invalid response from plugin');
    }

    const response = responseBody as PluginResponse<T>;

    if (response.success === undefined) {
      throw new PluginUnexpectedError('Malformed response: missing success field');
    }

    return response;
  }

  /**
   * Merges metadata into the response data if present
   *
   * @param data The response data
   * @param metadata Optional metadata (logs and traces)
   * @returns Data with metadata merged if present
   */
  private mergeMetadata<T>(
    data: T,
    metadata?: { logs?: LogEntry[]; traces?: any[] } // eslint-disable-line @typescript-eslint/no-explicit-any
  ): T {
    if (!metadata || (!metadata.logs && !metadata.traces)) {
      return data;
    }
    return { ...data, metadata } as T;
  }

  /**
   * Internal method to make a plugin call with automatic payload wrapping and response parsing
   *
   * @param params Request parameters
   * @returns Parsed response data with optional metadata
   * @throws {PluginTransportError} Network/HTTP failures
   * @throws {PluginExecutionError} Plugin rejected the request
   * @throws {PluginUnexpectedError} Malformed response or client-side errors
   */
  private async call<T>(params: unknown): Promise<T> {
    const payload = { params };

    // Send request and handle transport errors
    let responseBody: unknown;
    try {
      responseBody = await this.sendCall(payload);
    } catch (error) {
      responseBody = this.parseAxiosError(error);
    }

    // Validate response structure
    const response = this.validateResponse<T>(responseBody);

    // Handle execution errors
    if (!response.success) {
      const errorDetails = response.metadata ? { ...response.data, metadata: response.metadata } : response.data;
      throw new PluginExecutionError(response.error || 'Plugin execution failed', errorDetails);
    }

    // Return data with metadata if present
    return this.mergeMetadata(response.data, response.metadata);
  }

  /**
   * Internal method to send the actual HTTP request
   * Routes to either axios (direct HTTP) or PluginsApi (relayer) based on configuration
   *
   * @param payload The complete payload (already wrapped in {params})
   * @returns Raw response from the service/relayer
   */
  private async sendCall(payload: { params: unknown }): Promise<unknown> {
    if (this.pluginsApi) {
      const response = await this.pluginsApi.callPlugin(this.pluginId!, payload);
      return response.data;
    }

    const response = await this.axiosClient!.post('/', payload);
    return response.data;
  }
}
