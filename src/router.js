/* =============================================================================
   Radix router

   The tree stores compressed chunks of the path rather than segments: a chain of
   static nodes collapses into one node carrying a string prefix. Matching
   /api/v1/users/ is then a single in-place comparison instead of four
   slice + Map.get steps — a 2.7x difference on the benchmark.

   There is one tree per HTTP method. A single shared tree with
   the methods stored at the leaf looked leaner, but charged for it on every
   request: routes of other methods split static chains into extra nodes, and a
   method miss cost a full walk. Per-method trees are shorter, and the method
   plays no part in the walk at all.

   Deliberately one file: path parsing, insertion and lookup share invariants (the
   canonical path form, the priority order), and keeping them side by side is
   safer than synchronising them across a module boundary.
   ============================================================================= */

const SLASH = 47;   // '/'
const COLON = 58;   // ':'
const QUESTION = 63; // '?'
const HASH = 35;    // '#'
const PERCENT = 37; // '%'
const STAR = 42;    // '*'

/* -----------------------------------------------------------------------------
   Node
----------------------------------------------------------------------------- */

/**
 * Node of the radix tree.
 *
 * `prefix` is the compressed static chunk this node stands for; when the node is
 * reached, that chunk has already been matched. Static children are dispatched by
 * the char code of their first character, kept in two parallel arrays rather than
 * a Map: a linear scan over a handful of integers compiles down to a few compares,
 * while `Map.get` hashes the key and probes a bucket — on the hot path that was a
 * third of the whole lookup.
 */
class RadixNode {
    /** @param {string} prefix */
    constructor(prefix) {
        /** @type {string} */
        this.prefix = prefix;

        /** @type {number[]} first char code of each static child */
        this.codes = [];

        /** @type {RadixNode[]} static children, parallel to `codes` */
        this.nodes = [];

        /** @type {RadixNode|null} consumes exactly one segment; its own prefix is '' */
        this.param = null;

        /** @type {RadixNode|null} consumes the whole remainder; always terminal */
        this.wildcard = null;

        /**
         * The route terminating here, if any. One per node: the tree belongs to a
         * single method, so there is nothing to choose between.
         *
         * @type {{ handler: unknown, pattern: string, paramNames: string[], build: (values: string[]) => Params }|null}
         */
        this.entry = null;
    }
}

/**
 * Container for matched parameters.
 *
 * A plain `Object.create(null)` drops into dictionary mode and costs ~4x more per
 * property write. A constructor whose prototype is null keeps the hidden class
 * while still shielding `__proto__` and `constructor` arriving from a URL.
 */
function Params() {}
Params.prototype = Object.create(null);

const EMPTY_PARAMS = () => new Params();

// `new Function` is forbidden under --disallow-code-generation-from-strings and
// under a CSP without 'unsafe-eval'. Checked once: the first failure switches to
// the loop for the rest of the process — the flag never flips back.
let codegen = true;

/**
 * Builds the function that lays the values out under the route's names.
 *
 * The names are literals inside it, so every write compiles to a named store
 * with one hidden class per route. The loop `params[names[i]] = values[i]` with a
 * variable key goes through a keyed store and cost ~10% on routes with two
 * parameters.
 *
 * @param {string[]} names
 * @returns {(values: string[]) => Params}
 */
function compileParams(names) {
    if (names.length === 0) {
        return EMPTY_PARAMS;
    }

    if (codegen) {
        try {
            return generateParams(names);
        } catch {
            codegen = false;
        }
    }

    return (values) => {
        const params = new Params();

        for (let i = 0; i < names.length; i++) {
            params[names[i]] = values[i];
        }

        return params;
    };
}

/**
 * @param {string[]} names
 * @returns {(values: string[]) => Params}
 * @throws {EvalError} when code generation from strings is disallowed
 */
function generateParams(names) {
    const lines = ['return function build(values) {', '    const params = new Params();'];

    for (let i = 0; i < names.length; i++) {
        lines.push(`    params[${JSON.stringify(names[i])}] = values[${i}];`);
    }

    lines.push('    return params;', '};');

    return new Function('Params', lines.join('\n'))(Params);
}

/* -----------------------------------------------------------------------------
   Path string handling
----------------------------------------------------------------------------- */

/**
 * The path boundary and its readiness — in one pass.
 *
 * "Ready" means the path can be matched straight against the original string,
 * without allocating a new one. A missing leading slash, repeated slashes,
 * percent-encoding and a trailing slash all break that. All of it is caught here
 * for free: the loop reads every character anyway.
 *
 * The flag travels inside the number — a path that is not ready comes back as
 * `~end`, i.e. negative. A pair of values would otherwise need either an object
 * (an allocation per request) or a module-level variable (a hidden link between
 * two functions and a trap for any attempt to make lookup re-entrant).
 *
 * A character loop rather than one `indexOf` per interesting character: that
 * would take four calls, `//` included, and on twenty-character paths their fixed
 * cost already loses to the loop.
 *
 * @param {string} url
 * @returns {number} `end` for a ready path, `~end` for one that is not
 */
function scanPath(url) {
    const length = url.length;

    let ready = url.charCodeAt(0) === SLASH;
    let previous = 0;
    let i = 0;

    while (i < length) {
        const code = url.charCodeAt(i);

        if (code === QUESTION || code === HASH) {
            break;
        }
        if (code === PERCENT || (code === SLASH && previous === SLASH)) {
            ready = false;
        }

        previous = code;
        i++;
    }

    if (i > 1 && previous === SLASH) {
        ready = false;
    }

    return ready ? i : ~i;
}

/**
 * Pass 1 of percent-decoding — `decodeURI` semantics.
 *
 * Decodes what was encoded only because of the URL character set: non-ASCII
 * (%C3%A9 → é), spaces, brackets. Reserved characters (/ ? # : @ & = + $ ,) stay
 * encoded on purpose, otherwise a %2F inside a value would turn into a separator
 * and break the path into extra segments.
 *
 * The second pass, `decodeValue`, finishes the job — but over the value of a
 * single parameter, once its boundaries are known and the structure is safe.
 *
 * @param {string} path
 * @returns {string|null} null when the percent-encoding is malformed
 */
function decodeURIPath(path) {
    if (!path.includes('%')) {
        return path;
    }

    // '%25' is an encoded percent sign, and decodeURI turns it into '%'. The
    // second pass would then either choke on a lone percent or decode the value
    // twice. Double it: after the first pass exactly '%25' remains, which the
    // second pass turns into '%'. Safe on input that is already doubled.
    const guarded = path.replace(/%25/g, '%2525');

    try {
        return decodeURI(guarded);
    } catch {
        return null;
    }
}

/**
 * Brings slashes to the form the tree is built in: one leading, none repeated,
 * none trailing.
 *
 * @param {string} path
 * @returns {string}
 */
function canonicaliseSlashes(path) {
    let out = '';
    let i = 0;

    while (i < path.length) {
        while (i < path.length && path.charCodeAt(i) === SLASH) {
            i++;
        }
        if (i >= path.length) {
            break;
        }

        let stop = i;
        while (stop < path.length && path.charCodeAt(stop) !== SLASH) {
            stop++;
        }

        out += '/' + path.slice(i, stop);
        i = stop;
    }

    return out === '' ? '/' : out;
}

/**
 * Full preparation of a path for matching. Registration and lookup must perform
 * it identically, otherwise /users and /users/ — or %C3%A9 and é — become
 * different routes. The shared function is that guarantee.
 *
 * @param {string} path
 * @param {number} [end] the path boundary, when already known
 * @returns {string|null} null when the percent-encoding is malformed
 */
function preparePath(path, end) {
    if (end === undefined) {
        const scanned = scanPath(path);
        end = scanned < 0 ? ~scanned : scanned;
    }

    const decoded = decodeURIPath(path.slice(0, end));

    if (decoded === null) {
        return null;
    }

    return canonicaliseSlashes(decoded);
}

/**
 * Pass 2 — `decodeURIComponent` over the value of one parameter.
 *
 * @param {string} raw
 * @returns {string|null} null when the percent-encoding is malformed
 */
function decodeValue(raw) {
    if (!raw.includes('%')) {
        return raw;
    }

    try {
        return decodeURIComponent(raw);
    } catch {
        return null;
    }
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} length of the shared leading part
 */
function commonPrefixLength(a, b) {
    const max = a.length < b.length ? a.length : b.length;

    let i = 0;
    while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) {
        i++;
    }

    return i;
}

/**
 * The first character already matched — the child was picked by it — so the
 * comparison starts from the second. A plain loop, not `startsWith` and not a
 * function generated per node with `new Function`: all three measure the same,
 * and the loop is the only one that stays monomorphic and needs no code
 * generation.
 *
 * @param {string} url
 * @param {number} offset
 * @param {string} prefix
 * @returns {boolean}
 */
function matchPrefix(url, offset, prefix) {
    for (let i = 1; i < prefix.length; i++) {
        if (url.charCodeAt(offset + i) !== prefix.charCodeAt(i)) {
            return false;
        }
    }

    return true;
}

/**
 * @param {string} url
 * @param {number} from
 * @param {number} end
 * @returns {number} position of the next slash, or `end`
 */
function segmentEnd(url, from, end) {
    // Native indexOf: the slash may turn up past `end`, in the query — then `end`.
    const slash = url.indexOf('/', from);
    return slash === -1 || slash > end ? end : slash;
}

/**
 * Position of the nearest ':' or '*' marker, starting at `from`.
 *
 * @param {string} pattern
 * @param {number} from
 * @returns {number} position or -1
 */
function nextMarker(pattern, from) {
    const colon = pattern.indexOf(':', from);
    const star = pattern.indexOf('*', from);

    if (colon === -1) {
        return star;
    }
    if (star === -1) {
        return colon;
    }

    return colon < star ? colon : star;
}

/* -----------------------------------------------------------------------------
   Tree
----------------------------------------------------------------------------- */

const PARAM_NAME = /^[A-Za-z0-9_$]+$/;

/**
 * Pushes the node's fallback branches onto the stack in reverse priority order:
 * the stack is LIFO, so the parameter is popped before the wildcard.
 *
 * Kept out of `walk` on purpose. The case is rare — most nodes have no fallback
 * branches — and keeping it in the main loop would bloat the function past V8's
 * inlining budget. On the benchmark that cost about 15%.
 *
 * @param {{ node: RadixNode, offset: number, paramCount: number, wild: boolean }[]|null} stack
 * @param {RadixNode} node
 * @param {number} offset
 * @param {number} paramCount
 * @param {boolean} withParam whether to push the parametric branch
 */
function pushAlternatives(stack, node, offset, paramCount, withParam) {
    if (stack === null) {
        stack = [];
    }

    if (node.wildcard !== null) {
        stack.push({ node: node.wildcard, offset, paramCount, wild: true });
    }

    if (withParam && node.param !== null) {
        stack.push({ node: node.param, offset, paramCount, wild: false });
    }

    return stack;
}

/**
 * @param {RadixNode} node
 * @param {number} code first char code of the child
 * @param {RadixNode} child
 */
function setChild(node, code, child) {
    const index = node.codes.indexOf(code);

    if (index === -1) {
        node.codes.push(code);
        node.nodes.push(child);
    } else {
        node.nodes[index] = child;
    }
}

/**
 * @param {RadixNode} node
 * @param {number} code
 * @returns {RadixNode|undefined}
 */
function getChild(node, code) {
    const codes = node.codes;

    for (let i = 0; i < codes.length; i++) {
        if (codes[i] === code) {
            return node.nodes[i];
        }
    }

    return undefined;
}

/**
 * Pushes a static chunk into the tree, splitting an existing node when the new
 * text diverges in the middle of its prefix.
 *
 *   before:  [users/x]
 *   +        users/y
 *   after:   [users/] -> [x]
 *                     -> [y]
 *
 * The existing node becomes the tail: it stands for the very same position as
 * before and merely loses the shared head from its prefix, so its children, param
 * and entry stay where they are. The freshly created node takes the shared head
 * and is empty by construction — nothing terminates there yet.
 *
 * @param {RadixNode} node
 * @param {string} text
 * @returns {RadixNode} node standing for the position right after `text`
 */
function insertStatic(node, text) {
    let rest = text;

    while (rest.length > 0) {
        const first = rest.charCodeAt(0);
        let child = getChild(node, first);

        if (child === undefined) {
            child = new RadixNode(rest);
            setChild(node, first, child);
            return child;
        }

        const shared = commonPrefixLength(child.prefix, rest);

        if (shared < child.prefix.length) {
            child.prefix = child.prefix.slice(shared);

            const head = new RadixNode(rest.slice(0, shared));
            setChild(head, child.prefix.charCodeAt(0), child);
            setChild(node, first, head);

            child = head;
        }

        rest = rest.slice(shared);
        node = child;
    }

    return node;
}

/**
 * @param {{ handler: unknown, pattern: string, paramNames: string[], build: (values: string[]) => Params }} entry
 * @param {string[]} paramValues collected positionally during the walk
 */
function buildMatch(entry, paramValues) {
    return {
        pattern: entry.pattern,
        params: entry.build(paramValues),
        handler: entry.handler,
    };
}

/**
 * Order of attempts at every node: static, then parameter, then wildcard. The
 * fallback branches go onto the stack in reverse priority order — the stack is
 * LIFO, so the parameter is popped before the wildcard.
 *
 * A module function rather than a private method of the class: a `this.#walk`
 * call carries a brand check, and on the shortest paths it showed up in the
 * benchmark.
 *
 * @param {RadixNode} root the tree of one method
 * @param {string} url
 * @param {number} end
 * @param {boolean} encoded whether values may still carry percent sequences
 * @returns {{ pattern: string, params: Params, handler: unknown }|null}
 */
function walk(root, url, end, encoded) {
    /** @type {{ node: RadixNode, offset: number, paramCount: number, wild: boolean }[]|null} */
    let stack = null;   // created only once there is somewhere to come back to
    const paramValues = [];

    let node = root;
    let offset = root.prefix.length;

    for (;;) {
        if (offset === end) {
            if (node.entry !== null) {
                return buildMatch(node.entry, paramValues);
            }
        } else {
            const child = getChild(node, url.charCodeAt(offset));

            if (child !== undefined && matchPrefix(url, offset, child.prefix)) {
                if (node.param !== null || node.wildcard !== null) {
                    stack = pushAlternatives(stack, node, offset, paramValues.length, true);
                }

                node = child;
                offset += child.prefix.length;
                continue;
            }

            if (node.param !== null) {
                if (node.wildcard !== null) {
                    stack = pushAlternatives(stack, node, offset, paramValues.length, false);
                }

                const stop = segmentEnd(url, offset, end);
                const value = encoded ? decodeValue(url.slice(offset, stop)) : url.slice(offset, stop);

                if (value === null) {
                    return null;
                }

                paramValues.push(value);
                node = node.param;
                offset = stop;
                continue;
            }

            if (node.wildcard !== null) {
                const value = encoded ? decodeValue(url.slice(offset, end)) : url.slice(offset, end);

                if (value === null) {
                    return null;
                }

                paramValues.push(value);
                node = node.wildcard;
                offset = end;
                continue;
            }
        }

        if (stack === null) {
            return null;
        }

        let resumed = false;

        while (stack.length > 0) {
            const state = stack.pop();
            const stop = state.wild ? end : segmentEnd(url, state.offset, end);

            if (stop === state.offset) {
                continue;
            }

            const value = encoded ? decodeValue(url.slice(state.offset, stop)) : url.slice(state.offset, stop);
            if (value === null) {
                return null;
            }

            paramValues.length = state.paramCount;
            paramValues.push(value);

            node = state.node;
            offset = stop;
            resumed = true;
            break;
        }

        if (!resumed) {
            return null;
        }
    }
}

/* =============================================================================
   Public API
   ============================================================================= */

export class Router {
    /**
     * @param {object} [options]
     * @param {number} [options.maxPathLength=8192] a longer path (query excluded) misses without a walk
     * @param {boolean} [options.headFallback=true] HEAD without a route of its own uses GET
     * @param {boolean} [options.implicitOptions=true] include OPTIONS in allowedMethods
     */
    constructor(options = {}) {
        /**
         * One tree per method. The root is the `/` node itself: every path starts
         * with it, and keeping it as a separate child would mean an extra step on
         * every lookup.
         *
         * @type {Map<string, RadixNode>}
         */
        this.trees = new Map();

        /**
         * GET as a dedicated field: it is the overwhelming majority of requests, and
         * a field read is cheaper than `Map.get` on a string. `undefined` until the
         * first GET route.
         *
         * @type {RadixNode|undefined}
         */
        this.treeGET = undefined;

        this.maxPathLength = options.maxPathLength ?? 8192;
        this.headFallback = options.headFallback !== false;
        this.implicitOptions = options.implicitOptions !== false;

        /**
         * The registration log. Not needed for its own sake: `routes`, `mount` and
         * `off` grow out of it. Removing a route is a rebuild from the log, because
         * a node split cannot be undone incrementally.
         *
         * @type {{ method: string, path: string, handler: unknown }[]}
         */
        this.registered = [];
    }

    /**
     * Parameter names belong to the route, not to the node: /users/:id and
     * /users/:userId lead to the same node but keep their own names. Since names
     * are not part of node identity, a duplicate is the node already having an entry.
     *
     * @param {string} method
     * @param {string} path pattern, e.g. '/users/:id' or '/files/*rest'
     * @param {unknown} handler stored as is, never called by the router
     * @throws {Error} on a malformed path, or when the method is already registered
     */
    add(method, path, handler) {
        const entry = { method: method.toUpperCase(), path, handler };

        this.#insert(entry);
        this.registered.push(entry);
    }

    get(path, handler) {
        this.add('GET', path, handler);
    }

    post(path, handler) {
        this.add('POST', path, handler);
    }

    patch(path, handler) {
        this.add('PATCH', path, handler);
    }

    put(path, handler) {
        this.add('PUT', path, handler);
    }

    delete(path, handler) {
        this.add('DELETE', path, handler);
    }

    /**
     * Re-registers the child router's routes under a prefix. The prefix may
     * contain parameters: `mount('/orgs/:orgId', users)`.
     *
     * A snapshot, not a live link: routes added to the child after `mount` do not
     * show up here. Otherwise a two-phase tree would be needed, along with a
     * decision about requests that have already happened.
     *
     * @param {string} prefix
     * @param {Router} child
     */
    mount(prefix, child) {
        // The join is normalised rather than taken as is. Nobody typed the mounted
        // pattern by hand, but it ends up in metrics: '/api/users' and
        // '/api/users/' would be two series for one and the same endpoint.
        const base = prefix.replace(/\/+$/, '');

        for (const entry of child.registered) {
            const path = entry.path === '/' ? base || '/' : base + entry.path;
            this.add(entry.method, path, entry.handler);
        }
    }

    /**
     * Removes a route. Parameter names are not part of a route's identity, so
     * `off('GET', '/users/:id')` also removes `/users/:userId`.
     *
     * @param {string} method
     * @param {string} path
     * @returns {boolean} whether there was such a route
     */
    off(method, path) {
        const key = routeKey(method, path);
        const kept = this.registered.filter((entry) => routeKey(entry.method, entry.path) !== key);

        if (kept.length === this.registered.length) {
            return false;
        }

        this.registered = kept;
        this.#rebuild();

        return true;
    }

    /** Removes every route. */
    reset() {
        this.trees = new Map();
        this.treeGET = undefined;
        this.registered = [];
    }

    /**
     * Registered routes in registration order.
     *
     * @returns {{ method: string, pattern: string, handler: unknown }[]}
     */
    routes() {
        return this.registered.map((entry) => ({
            method: entry.method,
            pattern: entry.path,
            handler: entry.handler,
        }));
    }

    /**
     * The trees as text, one per method — which is where it becomes visible what
     * collapsed into shared prefixes.
     *
     * @returns {string}
     */
    prettyPrint() {
        const lines = [];

        for (const [method, root] of this.trees) {
            lines.push(method);
            printNode(root, root.prefix, '    ', method, lines);
        }

        return lines.join('\n');
    }

    /**
     * @param {string} method uppercase, as it arrives in req.method
     * @param {string} url may carry a query string
     * @returns {{ pattern: string, params: Record<string, string>, handler: unknown }|null}
     */
    lookup(method, url) {
        let root = method === 'GET' ? this.treeGET : this.trees.get(method);

        if (root === undefined) {
            // A method without a single route. HEAD without routes of its own goes
            // straight to GET.
            if (method !== 'HEAD' || !this.headFallback || this.treeGET === undefined) {
                return null;
            }
            root = this.treeGET;
        }

        const scanned = scanPath(url);

        let end = scanned < 0 ? ~scanned : scanned;

        // The length cap handles both the walk over an absurd URL and the number
        // of segments at once: every segment takes at least a character plus a
        // slash. It measures the path, not the whole URL: a long query string is
        // legitimate — OAuth callbacks, filters — and cutting on it would mean
        // answering 404 on a live endpoint.
        if (end > this.maxPathLength) {
            return null;
        }

        let path = url;
        let encoded = false;

        // The only branch that allocates a string. The query string never brings
        // us here — there is no '?' in any tree prefix, so it cannot run past the
        // path boundary.
        if (scanned < 0) {
            path = preparePath(url, end);

            if (path === null) {
                return null;
            }

            end = path.length;
            encoded = true;
        }

        const match = walk(root, path, end, encoded);

        // The HEAD → GET fallback is a second walk, and only after a miss in its
        // own tree: an explicit HEAD route beats the substituted one.
        if (match === null && method === 'HEAD' && root !== this.treeGET
            && this.headFallback && this.treeGET !== undefined) {
            return walk(this.treeGET, path, end, encoded);
        }

        return match;
    }

    /**
     * The methods registered on this path — for a `405` response with an `Allow`
     * header and for answering `OPTIONS`. An empty array means a genuine `404`.
     *
     * A separate method rather than a field on the `lookup` result: every method
     * has its own tree, and finding out who else answers on this path means
     * walking each of them. Paying for that on every successful request would be
     * pointless — misses are rare.
     *
     * @param {string} url
     * @returns {string[]} sorted list of methods
     */
    allowedMethods(url) {
        const scanned = scanPath(url);
        const end = scanned < 0 ? ~scanned : scanned;

        if (end > this.maxPathLength) {
            return [];
        }

        const path = scanned < 0 ? preparePath(url, end) : url.slice(0, end);

        if (path === null) {
            return [];
        }

        const found = [];

        for (const [method, root] of this.trees) {
            if (walk(root, path, path.length, scanned < 0) !== null) {
                found.push(method);
            }
        }

        if (found.length > 0) {
            if (this.headFallback && found.includes('GET') && !found.includes('HEAD')) {
                found.push('HEAD');
            }
            if (this.implicitOptions && !found.includes('OPTIONS')) {
                found.push('OPTIONS');
            }
        }

        return found.sort();
    }

    /** @param {{ method: string, path: string, handler: unknown }} entry */
    #insert(entry) {
        const { method, path, handler } = entry;

        if (path.length > this.maxPathLength) {
            throw new Error(`Path exceeds maxPathLength (${this.maxPathLength}): ${path}`);
        }

        const canonical = preparePath(path);

        if (canonical === null) {
            throw new Error(`Malformed path: ${path}`);
        }

        let root = method === 'GET' ? this.treeGET : this.trees.get(method);

        if (root === undefined) {
            root = new RadixNode('/');
            this.trees.set(method, root);

            if (method === 'GET') {
                this.treeGET = root;
            }
        }

        const paramNames = [];

        let node = root;
        let i = root.prefix.length;

        while (i < canonical.length) {
            const marker = nextMarker(canonical, i);
            const staticEnd = marker === -1 ? canonical.length : marker;

            if (staticEnd > i) {
                node = insertStatic(node, canonical.slice(i, staticEnd));
            }

            if (marker === -1) {
                break;
            }

            if (canonical.charCodeAt(marker) === STAR) {
                const name = canonical.slice(marker + 1);

                // A wildcard eats the rest of the path, so nothing may follow it,
                // and it has to start at a segment boundary.
                if (canonical.charCodeAt(marker - 1) !== SLASH || name.includes('/')) {
                    throw new Error(`Wildcard must be the last segment: ${path}`);
                }

                // A bare star gets the conventional name '*'.
                addParamName(paramNames, name === '' ? '*' : name, path);

                if (node.wildcard === null) {
                    node.wildcard = new RadixNode('');
                }
                node = node.wildcard;
                break;
            }

            let stop = marker + 1;
            while (stop < canonical.length && canonical.charCodeAt(stop) !== SLASH) {
                stop++;
            }

            const name = canonical.slice(marker + 1, stop);

            // The name runs up to the slash, so '/:file.json' would produce a
            // parameter named 'file.json' that silently swallows the whole
            // segment. A static suffix after a parameter is not supported —
            // better to refuse loudly.
            if (!PARAM_NAME.test(name)) {
                throw new Error(
                    `Invalid parameter name ':${name}' in ${path}` +
                    ' — only letters, digits, _ and $ are allowed, and a static suffix after a parameter is not supported',
                );
            }

            addParamName(paramNames, name, path);

            if (node.param === null) {
                node.param = new RadixNode('');
            }
            node = node.param;
            i = stop;
        }

        if (node.entry !== null) {
            throw new Error(`Duplicate route: ${method} ${path} conflicts with ${node.entry.pattern}`);
        }

        // Stored as written, not rebuilt from the tree, so it matches the source.
        node.entry = { handler, pattern: path, paramNames, build: compileParams(paramNames) };
    }

    /** Full rebuild from the log: a route cannot be removed incrementally. */
    #rebuild() {
        this.trees = new Map();
        this.treeGET = undefined;

        for (const entry of this.registered) {
            this.#insert(entry);
        }
    }
}

/**
 * The route's identity key: parameter names are cut out of it, because
 * /users/:id and /users/:userId are one and the same route.
 *
 * @param {string} method
 * @param {string} path
 * @returns {string}
 */
function routeKey(method, path) {
    const canonical = preparePath(path) ?? path;
    return method.toUpperCase() + ' ' + canonical.replace(/:[^/]*/g, ':').replace(/\*[^/]*/g, '*');
}

/**
 * @param {string[]} names
 * @param {string} name
 * @param {string} path
 */
function addParamName(names, name, path) {
    if (names.includes(name)) {
        throw new Error(`Duplicate parameter name ':${name}' in ${path}`);
    }
    names.push(name);
}

/**
 * The label comes from the caller: a parametric or wildcard node has an empty
 * prefix, and printing it as is would show both as equally nameless.
 *
 * @param {RadixNode} node
 * @param {string} label
 * @param {string} indent
 * @param {string} method
 * @param {string[]} lines
 */
function printNode(node, label, indent, method, lines) {
    lines.push(indent + label + (node.entry !== null ? '  [' + method + ']' : ''));

    const deeper = indent + '    ';

    for (const child of node.nodes) {
        printNode(child, child.prefix, deeper, method, lines);
    }

    if (node.param !== null) {
        printNode(node.param, ':param', deeper, method, lines);
    }

    if (node.wildcard !== null) {
        printNode(node.wildcard, '*wildcard', deeper, method, lines);
    }
}
