import type { FetchLike, HttpResponse } from "./client.js";

/**
 * An in-memory stand-in for the Hyperliquid API.
 *
 * Routes are keyed by what the request actually is — `info:meta`,
 * `exchange:order` — so a test says what the exchange replies without caring
 * about URLs or payload plumbing. Exported rather than kept in the test folder
 * because anyone building an agent on this library needs the same thing.
 */
export type MockRouteKey = `info:${string}` | `exchange:${string}`;

export interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
}

function httpResponse(status: number, body: string): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

export function routeKeyFor(body: Record<string, unknown>): MockRouteKey {
  const action = body["action"];
  if (action && typeof action === "object") {
    const type = (action as Record<string, unknown>)["type"];
    return `exchange:${String(type)}`;
  }
  return `info:${String(body["type"])}`;
}

export class MockTransport {
  readonly calls: RecordedCall[] = [];
  private readonly routes = new Map<MockRouteKey, unknown[]>();
  private failure: { status: number; body: string } | undefined;
  private readonly routeFailures = new Map<
    MockRouteKey,
    { status: number; body: string }
  >();

  /**
   * Queue one or more replies for a route. With several, each call consumes the
   * next; the last one repeats once the queue runs down.
   */
  reply(key: MockRouteKey, ...responses: unknown[]): this {
    const queued = this.routes.get(key) ?? [];
    this.routes.set(key, [...queued, ...responses]);
    return this;
  }

  /** Make every subsequent request fail at the HTTP layer. */
  failWith(status: number, body: string): this {
    this.failure = { status, body };
    return this;
  }

  /**
   * Fail one route while the rest keep working — the shape of most real
   * outages, and the only way to test a failure that happens partway through
   * an operation rather than at the very first call.
   */
  failRoute(key: MockRouteKey, status: number, body: string): this {
    this.routeFailures.set(key, { status, body });
    return this;
  }

  get lastCall(): RecordedCall | undefined {
    return this.calls[this.calls.length - 1];
  }

  callsTo(key: MockRouteKey): RecordedCall[] {
    return this.calls.filter((call) => routeKeyFor(call.body) === key);
  }

  readonly fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    this.calls.push({ url, body });

    if (this.failure) {
      return httpResponse(this.failure.status, this.failure.body);
    }

    const key = routeKeyFor(body);
    const routeFailure = this.routeFailures.get(key);
    if (routeFailure) {
      return httpResponse(routeFailure.status, routeFailure.body);
    }

    const queue = this.routes.get(key);
    if (!queue || queue.length === 0) {
      throw new Error(
        `MockTransport has no reply for "${key}". Queue one with reply("${key}", …).`,
      );
    }
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return httpResponse(200, JSON.stringify(next));
  };
}
