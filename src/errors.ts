/** Base class for every error thrown on purpose by this package. */
export class SitemapWatchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SitemapWatchError';
  }
}

/** A request failed: network error, timeout, non-2xx status or a response over the size limit. */
export class FetchError extends SitemapWatchError {
  readonly url: string;
  readonly status: number | undefined;
  constructor(message: string, url: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FetchError';
    this.url = url;
    this.status = status;
  }
}

/** The document is not well-formed XML, or not a sitemap. */
export class ParseError extends SitemapWatchError {
  readonly line: number | undefined;
  readonly column: number | undefined;
  constructor(message: string, position?: { line: number; column: number }, options?: { cause?: unknown }) {
    super(position ? `${message} (line ${position.line}, column ${position.column})` : message, options);
    this.name = 'ParseError';
    this.line = position?.line;
    this.column = position?.column;
  }
}

/** The configuration file or an option is invalid. */
export class ConfigError extends SitemapWatchError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

/** A snapshot store could not be opened, read or written. */
export class StoreError extends SitemapWatchError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreError';
  }
}

/** An alert could not be delivered. */
export class AlertError extends SitemapWatchError {
  readonly status: number | undefined;
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AlertError';
    this.status = status;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
