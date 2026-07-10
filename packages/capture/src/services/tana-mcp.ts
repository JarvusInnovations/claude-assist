/**
 * The tana-local MCP client now lives in core so the capture executor and the
 * briefing render share one verified implementation. This module re-exports it
 * to keep capture's internal import paths (and its parseMcpBody test) stable.
 */

export {
  TanaMcpClient,
  parseMcpBody,
  type TanaMcpConfig,
} from '@jarvus/claude-assist-core';
