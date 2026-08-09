/**
 * Page-publishing contract — the server-side half of the pages module.
 *
 * The pages module's HTTP surface is how an *agent* publishes a page. A
 * scheduled pipeline has no request to hang a publish off, and shelling out to
 * its own API would be a second auth surface for a call that is already
 * in-process. So the contract lives here, in core, and the pages module
 * decorates `fastify.pages` with it — the same star-shaped dependency the
 * notify, ledger, invoker, and approvals contracts use. A consumer takes the
 * interface; a test satisfies it with a stub.
 *
 * Consumers guard with `fastify.pages?.publish(...)`: the pages module is
 * optional, and a pipeline whose render target is absent should say so rather
 * than fail.
 */

export interface PublishPageInput {
  /** Stable public identity — republishing the same slug adds a version. */
  slug: string;
  title: string;
  /** Self-contained HTML (the pages CSP forbids external subresources). */
  html: string;
  /** Batch a response notification into the digest tier instead of a notice. */
  digestOptin?: boolean;
}

export interface PublishedPage {
  slug: string;
  /**
   * Where the page is reachable. Absolute when the instance configured a
   * public base URL; otherwise the site-relative path, which is honest about
   * not knowing the host rather than inventing one.
   */
  url: string;
  /** False on a republish of an existing slug. */
  created: boolean;
  versionId: number;
}

/** Server-side publish surface. Implemented by the pages module. */
export interface PagePublisher {
  publish(input: PublishPageInput): Promise<PublishedPage>;
}
