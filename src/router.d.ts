import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Parameter names inferred from the path literal.
 *
 *   Params<'/users/:id'>                 → { id: string }
 *   Params<'/orgs/:orgId/users/:id'>     → { orgId: string } & { id: string }
 *   Params<'/files/*rest'>               → { rest: string }
 *   Params<'/files/*'>                   → { '*': string }
 *   Params<'/health'>                    → {}
 *
 * Works only where the path is known as a literal — that is, at registration.
 * By `lookup` time the path is a runtime string, and nothing more precise than
 * `Record<string, string>` can be said there.
 */
export type Params<P extends string> =
    P extends `${string}:${infer Name}/${infer Rest}`
        ? { [K in Name]: string } & Params<`/${Rest}`>
        : P extends `${string}:${infer Name}`
            ? { [K in Name]: string }
            : P extends `${string}*${infer Name}`
                ? { [K in Name extends '' ? '*' : Name]: string }
                : {};

/**
 * A route handler.
 *
 * The router never calls it — it only stores and returns it — so this signature
 * describes intent, not a runtime contract. To store something other than a
 * function, an object carrying metadata say, name your own type:
 * `new Router<{ fn: Fn; schema: S }>()`.
 */
export type Handler<P extends string = string> = (
    req: IncomingMessage,
    res: ServerResponse,
    params: Params<P>,
) => unknown;

export interface Match<H> {
    /** The route template exactly as it was registered. */
    pattern: string;
    /** An object with a null prototype: a `__proto__` segment from the URL is harmless. */
    params: Record<string, string>;
    handler: H;
}

export interface RouterOptions {
    /** A longer path (query string excluded) misses without a walk. Default 8192. */
    maxPathLength?: number;
    /** HEAD without a route of its own uses the GET handler. Default `true`. */
    headFallback?: boolean;
    /** Include OPTIONS in `allowedMethods`. Default `true`. */
    implicitOptions?: boolean;
}

export interface RouteEntry<H> {
    method: string;
    pattern: string;
    handler: H;
}

export declare class Router<H = Handler> {
    constructor(options?: RouterOptions);

    /**
     * @throws on a malformed path, a wildcard that is not the last segment, or
     *         registering the same method twice for the same route
     */
    add<P extends string>(method: string, path: P, handler: H extends Handler ? Handler<P> : H): void;

    get<P extends string>(path: P, handler: H extends Handler ? Handler<P> : H): void;
    post<P extends string>(path: P, handler: H extends Handler ? Handler<P> : H): void;
    patch<P extends string>(path: P, handler: H extends Handler ? Handler<P> : H): void;
    put<P extends string>(path: P, handler: H extends Handler ? Handler<P> : H): void;
    delete<P extends string>(path: P, handler: H extends Handler ? Handler<P> : H): void;

    /** @param method uppercase, as it arrives in `req.method` */
    lookup(method: string, url: string): Match<H> | null;

    /** The sorted list of methods on this path; empty means a genuine 404. */
    allowedMethods(url: string): string[];

    /** Re-registers the child router's routes under a prefix. A snapshot, not a live link. */
    mount(prefix: string, child: Router<H>): void;

    /** Removes a route; parameter names are not part of its identity. */
    off(method: string, path: string): boolean;

    /** Removes every route. */
    reset(): void;

    /** Registered routes in registration order. */
    routes(): RouteEntry<H>[];

    /** The trees as text, one per method — shows what collapsed into shared prefixes. */
    prettyPrint(): string;
}
