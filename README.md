# radixrouter

HTTP router on a radix tree. No dependencies, no knowledge of `req`/`res`.

```js
import { Router } from 'radixrouter';

const router = new Router();

router.get('/users/:id', handler);

router.lookup('GET', '/users/42?q=abcd');
// → { pattern: '/users/:id', params: { id: '42' }, handler }
// → null when nothing matches
```

Three fields, each earning its place. `handler` is whatever you registered. `params` holds
the values pulled out of the path. `pattern` is the **route template**, not the concrete
URL — that is what metrics and spans get tagged with, and tagging them with `/users/42`
makes a metric's cardinality equal to your user count.

## Install

```bash
npm i radixrouter
```

Node 20+.

## With `node:http`

The router never calls the handler — it stores it and hands it back. What lives in there,
and how it gets invoked, is the application's business.

```js
import http from 'node:http';
import { Router } from 'radixrouter';

const router = new Router();

router.get('/health', (req, res) => res.end('ok'));
router.get('/users/:id', (req, res, params) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: params.id }));
});
router.post('/users', (req, res) => res.writeHead(201).end());

http.createServer((req, res) => {
    const match = router.lookup(req.method, req.url);

    if (match !== null) {
        // the template, not the URL: a metrics tag with bounded cardinality
        res.setHeader('X-Route', match.pattern);
        return match.handler(req, res, match.params);
    }

    const allowed = router.allowedMethods(req.url);

    if (allowed.length > 0) {
        res.writeHead(405, { Allow: allowed.join(', ') }).end();
        return;
    }

    res.writeHead(404).end();
}).listen(3000);
```

## API

### `new Router(options?)`

| Option | Default | Effect |
|---|---|---|
| `maxPathLength` | `8192` | a longer path misses immediately, without walking; the query string does not count |
| `headFallback` | `true` | a `HEAD` request with no route of its own uses the `GET` handler |
| `implicitOptions` | `true` | `allowedMethods` includes `OPTIONS` |

### `router.add(method, path, handler)`

Registers a route. Shorthands: `get`, `post`, `patch`, `put`, `delete`.

`handler` is stored verbatim — a function, an array of middleware, an object carrying a
schema, anything. The method is upper-cased.

Throws on malformed percent-encoding, on a wildcard that is not the last segment, and on
registering the same method twice for the same route:

```
Duplicate route: GET /users/:userId conflicts with /users/:id
```

The message names both spellings because they are one route: parameter names are not part
of a route's identity.

A parameter name may contain only letters, digits, `_` and `$`. A static suffix after a
parameter — `/:file.json` — is rejected rather than quietly read as a parameter named
`file.json` that swallows the whole segment.

The `params` object of every route is assembled by a small function compiled at
registration with `new Function`: the names become literal keys, which V8 stores as named
properties instead of going through a keyed store — worth ~10% on routes with two
parameters. Under `--disallow-code-generation-from-strings`, or a CSP without
`'unsafe-eval'`, the builder falls back to a plain loop: routes with several parameters
get ~10% slower, nothing else changes.

### `router.lookup(method, url)`

Returns `{ pattern, params, handler }` or `null`. The `url` may carry a query string — it
is cut off. `method` is expected upper-case, the way it arrives in `req.method`.

`params` has a **null prototype**, so a `__proto__` or `constructor` segment coming from a
URL cannot reach inherited properties.

### `router.allowedMethods(url)`

The sorted list of methods registered on this path. An empty array means a genuine `404`;
a non-empty one means `405` with an `Allow` header.

It is a separate call rather than a field on the `lookup` result because every method has
its own tree: finding out who else answers on this path means walking each of them. For
`/users/me`, with `GET /users/me` and `POST /users/:id` registered, the answer is
`['GET', 'POST']`. Only the request that missed pays for it.

`HEAD` is added when `GET` is registered, and `OPTIONS` is added whenever the path matched
anything — an `Allow` header should list what the server will actually answer. Both can be
turned off through the constructor options.

### `router.mount(prefix, child)`

Re-registers the child router's routes under a prefix, which may itself contain parameters:

```js
const users = new Router();
users.get('/', list);
users.get('/:id', one);

const root = new Router();
root.mount('/orgs/:orgId/users', users);

root.lookup('GET', '/orgs/7/users/42');
// → pattern '/orgs/:orgId/users/:id', params { orgId: '7', id: '42' }
```

It is a snapshot, not a live link: routes added to the child afterwards do not appear in
the parent. A parameter name colliding between the prefix and the child throws.

The joined pattern is normalised rather than concatenated blindly: nobody typed it by
hand, and it ends up in metrics, where `/api/users` and `/api/users/` would be two series
for one endpoint.

### `router.off(method, path)`

Removes a route, returns whether there was one. Parameter names are not part of a route's
identity, so `off('GET', '/users/:id')` also removes `/users/:userId`.

Removal rebuilds the tree from the registration log: splitting a node is easy to do
incrementally and impossible to undo the same way.

### `router.reset()`

Drops every route.

### `router.routes()`

Registered routes as `{ method, pattern, handler }`, in registration order.

Instance fields such as `trees`, `treeGET` and `registered` are implementation details,
not API: they are deliberately absent from the type declarations, and a minor release may
rename them.

### `router.prettyPrint()`

The trees as text, one per method — which is where the compression becomes visible:

```
GET
    /
        api/v1/
            users  [GET]
                /
                    :param  [GET]
            orgs  [GET]
        files/
            *wildcard  [GET]
```

Four routes share one `api/v1/` node instead of three per-segment ones.

## Pattern syntax

| Syntax | Matches | Example |
|---|---|---|
| `users` | that exact segment | `/users` |
| `:name` | any single segment | `/users/:id` → `params.id` |
| `*name` | the whole remainder | `/files/*rest` → `params.rest` |
| `*` | same, named `'*'` | `/files/*` → `params['*']` |

A wildcard must occupy the entire last segment — `/a/*/b` and `/a*b` are rejected at
registration.

A static prefix before a parameter works — `/user:name` matches `/userBob`. A static
*suffix* after one does not: `/:file.json` is rejected at registration.

Regex constraints on parameters (`:id(\\d+)`) and multiple parameters inside one segment
(`:file.:ext`) are **not supported**: both drag matching back to linear scanning and
defeat the point of a tree.

## Matching rules

Branch priority: **static → `:param` → wildcard**.

**Backtracking is mandatory.** When a static branch matches but dead-ends deeper, the
search returns and tries the parametric one:

| Registered | Request | Result |
|---|---|---|
| `/a/:b/c`, `/a/x/d` | `/a/x/c` | `/a/:b/c`, `{ b: 'x' }` |
| `/users/me`, `/users/:id` | `/users/me` | `/users/me` — static wins |
| `/a/:b/stop`, `/a/*` | `/a/x/go` | `/a/*`, `{ '*': 'x/go' }` |

**Every method has its own tree.** With `GET /users/me` and `POST /users/:id`
registered, `POST /users/me` resolves to `/users/:id` with `{ id: 'me' }`: the POST tree
has no `me` node, so there is nothing to check at the end and nothing to get wrong. Routes
of one method never shape the tree of another — a `POST /users/:id/promote` does not split
GET's `/members` node into `/` and `members`, and does not cost a GET request a hop.

`HEAD` is the one method that looks at two trees: its own first, in full, then GET's when
`headFallback` is on. An explicit `HEAD /users/:id` therefore beats an implicit
`GET /users/me` for `HEAD /users/me` — a HEAD route you wrote wins over one you did not.

**Parameter names belong to the route, not the node.** `/users/:id` and `/users/:userId`
are one route — registering both for the same method throws — and different methods may
name the parameter differently:

```js
router.get('/users/:id', a);
router.post('/users/:userId', b);

router.lookup('GET', '/users/42');   // { id: '42' }
router.lookup('POST', '/users/42');  // { userId: '42' }
```

## Path handling

A leading slash is required; trailing and repeated slashes are insignificant, so `/users`,
`/users/` and `//users//` are one route. Registration and lookup prepare the path with the
same function — otherwise the two would drift apart.

**Percent-encoding is resolved in two passes.** Decoding everything up front is unsafe:
a `%2F` inside a value would turn into a separator, and `/files/a%2F..%2F..%2Fetc%2Fpasswd`
would climb out of its subtree. Leaving everything encoded is equally wrong: a browser
sends `/café/42` as `/caf%C3%A9/42`, and the static segment would never match.

So: `decodeURI` over the whole path — non-ASCII and spaces come out, reserved characters
stay encoded — then `decodeURIComponent` over each parameter value.

```js
router.get('/café/:id', h);
router.lookup('GET', '/caf%C3%A9/42');  // → { id: '42' }

router.get('/files/:name', h);
router.lookup('GET', '/files/a%2Fb.txt');  // → { name: 'a/b.txt' }
```

Malformed encoding yields `null` from `lookup` and throws from `add`.

## Types

Parameter names are inferred from the path literal, wildcards included:

```ts
router.get('/orgs/:orgId/files/*rest', (req, res, params) => {
    params.orgId;   // string
    params.rest;    // string
    params.userId;  // compile error
});
```

The precision exists exactly where the path is a literal — at registration. By `lookup`
time the path is a runtime string, and nothing more specific than
`Record<string, string>` can be said about `params`.

By default the handler is typed `(req, res, params) => unknown` using `node:http` types.
To store something other than a function, name your own type:

```ts
const router = new Router<{ fn: Handler; schema: Schema }>();
```

## Benchmarks

215 routes modelled on a real REST API, Node 24.15, best of 5 rounds of 1M iterations.
Millions of operations per second:

| request | ops/s |
|---|---|
| static, shallow | 23.8M |
| static, deep | 6.4M |
| one parameter | 6.5M |
| parameter + sub-resource | 4.8M |
| two parameters | 4.5M |
| backtrack three levels | 5.4M |
| path miss | 11.6M |
| method miss | 6.6M |
| registering 215 routes | 0.36 ms |
| heap per router | 179 KB |

The first version was 30–50% slower on every row, and the gap was closed by changing one
thing at a time and measuring each: static children in two parallel arrays instead of a
`Map` (~30% on every row — `Map.get` hashes and probes, a scan over a handful of integers
is a few compares); one tree per method instead of one shared tree (routes of other
methods no longer split static chains, and a method miss no longer walks the whole path);
a root node that is `/` itself rather than a parent of one; and the compiled params
builder. Things that measured as noise or worse were left out: scanning the path with
`indexOf` instead of a character loop (four calls cost more than the loop on
20-character paths), a flat backtracking stack, a shared values array (−40%: it escapes
the function and defeats escape analysis).

The bench warms the router with every query shape before measuring: V8 otherwise
specialises the walk to the one shape it has seen and reports a number a server would
never get.

## Not there yet

- host and version constraints — pick a route by request header, not by path alone
- a static suffix after a parameter (`/:file.json`)

## Development

```bash
npm test        # 87 tests, differential check included
npm run typecheck
npm run bench

node examples/router.js   # API tour: mount, wildcards, 405, the tree
```

CI runs the suite on Node 20, 22 and 24 — the minimum declared in `engines`, the current
release, and the one in between, since both `.ts` execution and the test runner's
behaviour shift across that range.

The differential test runs 300 random route tables and 12,000 requests through this
router and an independent reference implementation and compares `pattern` together with
`params`. The generator is
deterministic, so a failure reproduces. It is what catches disagreements about priority
and backtracking depth — the kind of thing you would never think to write a targeted test
for.

`src/router.d.ts` is not checked against `src/router.js` automatically: TypeScript treats
the declaration as the truth and never looks at the implementation beside it.
`test-d/types.ts` guards against the drift by using the API exactly as a consumer of the
package would.

## License

MIT
