/**
 * index.ts
 *
 * Main entry point for the @openzeppelin/relayer-plugin-channels package
 * Re-exports both the client (for external use) and the plugin handler
 */

// Export client for external consumers
export * from './client';

// Export plugin handler for the OpenZeppelin Relayer
export * from './plugin';
