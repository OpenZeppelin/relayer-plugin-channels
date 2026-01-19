/**
 * Base class for all plugin-related errors
 */
export abstract class PluginClientError extends Error {
  abstract readonly category: 'transport' | 'execution' | 'client';
}

/**
 * HTTP/Network transport failures
 *
 * Thrown when communication with the service fails:
 * - Network errors (connection refused, timeout, DNS failures)
 * - HTTP errors (500, 502, 503, 504)
 * - Invalid responses (malformed JSON)
 */
export class PluginTransportError extends PluginClientError {
  readonly category = 'transport';

  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly errorDetails?: any // eslint-disable-line @typescript-eslint/no-explicit-any
  ) {
    super(message);
    this.name = 'PluginTransportError';
  }
}

/**
 * Plugin execution/validation errors
 *
 * Thrown when the plugin processes the request but returns an error:
 * - Validation failures (invalid parameters, missing auth)
 * - Business logic errors (insufficient balance, rate limits)
 * - On-chain failures (transaction reverted)
 */
export class PluginExecutionError extends PluginClientError {
  readonly category = 'execution';

  constructor(
    message: string,
    public readonly errorDetails?: any // eslint-disable-line @typescript-eslint/no-explicit-any
  ) {
    super(message);
    this.name = 'PluginExecutionError';
  }
}

/**
 * Client-side parsing/validation errors
 *
 * Thrown when the client encounters unexpected issues:
 * - Empty or malformed responses
 * - Missing required fields in response
 * - Unexpected response structure
 */
export class PluginUnexpectedError extends PluginClientError {
  readonly category = 'client';

  constructor(
    message: string,
    public readonly errorDetails?: any // eslint-disable-line @typescript-eslint/no-explicit-any
  ) {
    super(message);
    this.name = 'PluginUnexpectedError';
  }
}
