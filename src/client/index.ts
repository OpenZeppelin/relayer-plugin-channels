/**
 * Channels Plugin Client
 *
 * Unified client for interacting with the channels plugin
 * in both direct HTTP mode and OpenZeppelin Relayer mode.
 */

export { ChannelsClient } from './channels-client';
export {
  ChannelsClientConfig,
  DirectHttpConfig,
  RelayerConfig,
  ChannelsXdrRequest,
  ChannelsFuncAuthRequest,
  ChannelsTransactionResponse,
  ListChannelAccountsResponse,
  SetChannelAccountsResponse,
} from './types';
export { PluginClientError, PluginTransportError, PluginExecutionError, PluginUnexpectedError } from './errors';
