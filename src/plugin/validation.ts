/**
 * validation.ts
 *
 * Request validation and parsing for the Channel Accounts plugin.
 * Supports either a signed XDR or func+auth.
 */

import { xdr } from '@stellar/stellar-sdk';
import { pluginError } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS } from './constants';
import { ChannelAccountsRequest } from './types';

export function validateAndParseRequest(params: any): ChannelAccountsRequest {
  if (!params || typeof params !== 'object') {
    throw pluginError('Invalid request: params must be an object', {
      code: 'INVALID_PARAMS',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }

  // Disallow any management-shaped keys leaking into here; management is handled earlier
  const keys = Object.keys(params);

  // Mode: XDR
  if ('xdr' in params) {
    if (typeof params.xdr !== 'string' || params.xdr.trim() === '') {
      throw pluginError('`xdr` must be a non-empty base64 string', {
        code: 'INVALID_PARAMS',
        status: HTTP_STATUS.BAD_REQUEST,
      });
    }

    // Strict: cannot include func/auth when using xdr
    const unknown = keys.filter((k) => !['xdr'].includes(k));
    if (unknown.length > 0) {
      throw pluginError('`xdr` request must not include other parameters', {
        code: 'INVALID_PARAMS',
        status: HTTP_STATUS.BAD_REQUEST,
        details: { unknown },
      });
    }

    return { type: 'xdr', xdr: params.xdr.trim() };
  }

  // Mode: func+auth
  if ('func' in params || 'auth' in params) {
    if (!params.func || !params.auth) {
      throw pluginError('`func` and `auth` are both required when omitting `xdr`', {
        code: 'INVALID_PARAMS',
        status: HTTP_STATUS.BAD_REQUEST,
      });
    }

    // Parse values from base64
    let func: xdr.HostFunction;
    let auth: xdr.SorobanAuthorizationEntry[] = [];
    try {
      func = xdr.HostFunction.fromXDR(params.func, 'base64');
      if (!Array.isArray(params.auth)) {
        throw new Error('auth must be an array of base64 strings');
      }
      auth = params.auth.map((a: string) => xdr.SorobanAuthorizationEntry.fromXDR(a, 'base64'));
    } catch (e: any) {
      throw pluginError('Invalid `func` or `auth` encoding', {
        code: 'INVALID_PARAMS',
        status: HTTP_STATUS.BAD_REQUEST,
        details: { message: e instanceof Error ? e.message : String(e) },
      });
    }

    // Reject SourceAccount credentials: incompatible with relayer-managed channel source
    for (const entry of auth) {
      const credType = entry.credentials().switch();
      if (credType === xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount()) {
        throw pluginError(
          'Detached address credentials required: source-account credentials are incompatible with relayer-managed channel accounts',
          {
            code: 'INVALID_PARAMS',
            status: HTTP_STATUS.BAD_REQUEST,
            details: { reason: 'source-account credentials not allowed' },
          },
        );
      }
    }

    return { type: 'func-auth', func, auth };
  }

  throw pluginError('Must pass either `xdr` or `func` and `auth`', {
    code: 'INVALID_PARAMS',
    status: HTTP_STATUS.BAD_REQUEST,
  });
}
