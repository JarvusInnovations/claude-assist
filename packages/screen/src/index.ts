/**
 * Screen module — an isolated check of an outgoing draft against a written
 * policy, made by a model that sees nothing else. See `specs/modules/screen.md`.
 *
 * Registered by the host under `/api` only when a bearer token is configured.
 * It is an invoker workload (one fixed-shape headless call with this module's
 * own prompt), not a route for steering a model: the caller supplies data,
 * never system text, model, tier or token ceiling.
 */

export { registerScreenRoutes, type ScreenRoutesConfig } from './routes.js';
export {
  LIMITS,
  REQUEST_KEYS,
  SCREEN_MAX_TOKENS,
  SCREEN_TASK,
  SCREEN_TIER,
  SCREEN_TIMEOUT_MS,
  SYSTEM_PROMPT,
  ScreenError,
  buildUserMessage,
  hashDraft,
  mapInvokerError,
  parseVerdict,
  runScreen,
  validateRequest,
  type ScreenErrorCode,
  type ScreenOutcome,
  type ScreenRequest,
  type Verdict,
} from './screen.js';
