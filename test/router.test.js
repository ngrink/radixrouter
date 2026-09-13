import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { Router } from '../src/router.js';

/** params has a null prototype, so it is spread into a plain object for comparison */
const params = (match) => ({ ...match.params });

describe('static', () => {
    test('a plain route', () => {
        const router = new Router();
        router.get('/users', 'H');

        const match = router.lookup('GET', '/users');
        assert.equal(match.handler, 'H');
        assert.equal(match.pattern, '/users');
        assert.deepEqual(params(match), {});
    });

    test('the root path', () => {
        const router = new Router();
        router.get('/', 'ROOT');

        const match = router.lookup('GET', '/');
        assert.equal(match.handler, 'ROOT');
        assert.equal(match.pattern, '/');
    });

    test('several methods on one path', () => {
        const router = new Router();
        router.get('/users', 'GET');
        router.post('/users', 'POST');

        assert.equal(router.lookup('GET', '/users').handler, 'GET');
        assert.equal(router.lookup('POST', '/users').handler, 'POST');
    });

    test('path miss', () => {
        const router = new Router();
        router.get('/users', 'H');
        assert.equal(router.lookup('GET', '/nope'), null);
    });

    test('method miss', () => {
        const router = new Router();
        router.get('/users', 'H');
        assert.equal(router.lookup('DELETE', '/users'), null);
    });

    test('an intermediate node is not a match', () => {
        const router = new Router();
        router.get('/me/feed', 'H');
        assert.equal(router.lookup('GET', '/me'), null);
    });
});

describe('params', () => {
    test('one parameter', () => {
        const router = new Router();
        router.get('/users/:id', 'H');

        const match = router.lookup('GET', '/users/42');
        assert.equal(match.pattern, '/users/:id');
        assert.deepEqual(params(match), { id: '42' });
    });

    test('several parameters on different levels', () => {
        const router = new Router();
        router.get('/orgs/:orgId/users/:id', 'H');

        const match = router.lookup('GET', '/orgs/7/users/42');
        assert.deepEqual(params(match), { orgId: '7', id: '42' });
    });

    test('the parametric node is shared between methods', () => {
        const router = new Router();
        router.get('/users/:userId', 'GET');
        router.patch('/users/:userId', 'PATCH');

        assert.equal(router.lookup('GET', '/users/42').handler, 'GET');
        assert.equal(router.lookup('PATCH', '/users/42').handler, 'PATCH');
    });

    test('subtrees under a parameter do not overwrite each other', () => {
        const router = new Router();
        router.get('/users/:id/promote', 'PROMOTE');
        router.get('/users/:id/demote', 'DEMOTE');

        assert.equal(router.lookup('GET', '/users/42/promote').handler, 'PROMOTE');
        assert.equal(router.lookup('GET', '/users/42/demote').handler, 'DEMOTE');
    });

    test('parameter names are per method', () => {
        const router = new Router();
        router.get('/users/:id', 'GET');
        router.post('/users/:userId', 'POST');

        assert.deepEqual(params(router.lookup('GET', '/users/42')), { id: '42' });
        assert.deepEqual(params(router.lookup('POST', '/users/42')), { userId: '42' });
        assert.equal(router.lookup('POST', '/users/42').pattern, '/users/:userId');
    });

    test('params inherits nothing from Object.prototype', () => {
        const router = new Router();
        router.get('/users/:id', 'H');

        const match = router.lookup('GET', '/users/__proto__');
        assert.equal(match.params.id, '__proto__');
        assert.equal(match.params.constructor, undefined);
        assert.equal(match.params.toString, undefined);
        assert.equal('toString' in match.params, false);
        // the chain ends one level deeper: container → null-prototype → null
        assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(match.params)), null);
    });

    test('a parameter named __proto__ does not replace the prototype', () => {
        const router = new Router();
        router.get('/x/:__proto__', 'H');

        const match = router.lookup('GET', '/x/evil');
        assert.equal(match.params['__proto__'], 'evil');
        assert.equal({}.evil, undefined);
    });
});

describe('priority and backtracking', () => {
    test('static wins over the parameter', () => {
        const router = new Router();
        router.get('/users/me', 'STATIC');
        router.get('/users/:id', 'PARAM');

        const match = router.lookup('GET', '/users/me');
        assert.equal(match.handler, 'STATIC');
        assert.deepEqual(params(match), {});
    });

    test('backtracks out of a dead-end static branch', () => {
        const router = new Router();
        router.get('/a/:b/c', 'PARAM');
        router.get('/a/x/d', 'STATIC');

        const match = router.lookup('GET', '/a/x/c');
        assert.equal(match.handler, 'PARAM');
        assert.equal(match.pattern, '/a/:b/c');
        assert.deepEqual(params(match), { b: 'x' });
    });

    test('backtracks two levels', () => {
        const router = new Router();
        router.get('/:a/:b/c', 'PARAM');
        router.get('/x/y/d', 'STATIC');

        const match = router.lookup('GET', '/x/y/c');
        assert.equal(match.handler, 'PARAM');
        assert.deepEqual(params(match), { a: 'x', b: 'y' });
    });

    test('the method takes part in the search rather than being checked at the end', () => {
        const router = new Router();
        router.get('/users/me', 'GET-STATIC');
        router.post('/users/:id', 'POST-PARAM');

        const match = router.lookup('POST', '/users/me');
        assert.equal(match.handler, 'POST-PARAM');
        assert.deepEqual(params(match), { id: 'me' });
    });

    test('parameters of a failed branch do not leak into the result', () => {
        const router = new Router();
        router.get('/a/:x/stop', 'DEADEND');
        router.get('/a/b/c/:y', 'MATCH');

        const match = router.lookup('GET', '/a/b/c/z');
        assert.equal(match.handler, 'MATCH');
        assert.deepEqual(params(match), { y: 'z' });
    });

    test('deep backtracking leaves no extra parameters behind', () => {
        const router = new Router();
        router.get('/:a/:b/:c/end', 'DEEP');
        router.get('/x/y/z/other', 'OTHER');

        const match = router.lookup('GET', '/x/y/z/end');
        assert.deepEqual(params(match), { a: 'x', b: 'y', c: 'z' });
    });
});

describe('node splitting', () => {
    test('the tail keeps its handlers and subtree across a split', () => {
        const router = new Router();

        // 1. the node gets the prefix '/users/x' and a handler
        router.get('/users/x', 'X');
        // 2. a subtree appears underneath it
        router.get('/users/x/deep', 'DEEP');
        // 3. a new route diverges in the middle of the prefix → the node is cut into
        //    '/users/' and the tail 'x'; the tail must carry both the handler and '/deep'
        router.get('/users/y', 'Y');

        assert.equal(router.lookup('GET', '/users/x').handler, 'X');
        assert.equal(router.lookup('GET', '/users/x/deep').handler, 'DEEP');
        assert.equal(router.lookup('GET', '/users/y').handler, 'Y');
    });

    test('the tail keeps its parametric branch across a split', () => {
        const router = new Router();

        router.get('/users/x/:id', 'PARAM');
        router.get('/users/y', 'Y');

        const match = router.lookup('GET', '/users/x/42');
        assert.equal(match.handler, 'PARAM');
        assert.deepEqual(params(match), { id: '42' });
    });

    test('a split at a point shared by several branches', () => {
        const router = new Router();

        router.get('/api/v1/users', 'USERS');
        router.get('/api/v1/orgs', 'ORGS');
        router.get('/api/v2/users', 'V2');
        router.get('/api', 'ROOT');

        assert.equal(router.lookup('GET', '/api/v1/users').handler, 'USERS');
        assert.equal(router.lookup('GET', '/api/v1/orgs').handler, 'ORGS');
        assert.equal(router.lookup('GET', '/api/v2/users').handler, 'V2');
        assert.equal(router.lookup('GET', '/api').handler, 'ROOT');
        assert.equal(router.lookup('GET', '/api/v1'), null);
    });

    test('registration order does not affect the result', () => {
        const forward = new Router();
        forward.get('/users/x', 'X');
        forward.get('/users/y', 'Y');

        const backward = new Router();
        backward.get('/users/y', 'Y');
        backward.get('/users/x', 'X');

        for (const router of [forward, backward]) {
            assert.equal(router.lookup('GET', '/users/x').handler, 'X');
            assert.equal(router.lookup('GET', '/users/y').handler, 'Y');
        }
    });
});

describe('path parsing', () => {
    test('the query string is cut off', () => {
        const router = new Router();
        router.get('/users/:id', 'H');

        const match = router.lookup('GET', '/users/42?q=abcd&page=2');
        assert.deepEqual(params(match), { id: '42' });
    });

    test('the hash is cut off', () => {
        const router = new Router();
        router.get('/users', 'H');
        assert.equal(router.lookup('GET', '/users#section').handler, 'H');
    });

    test('a trailing slash is insignificant', () => {
        const router = new Router();
        router.get('/users', 'H');
        assert.equal(router.lookup('GET', '/users/').handler, 'H');
    });

    test('repeated slashes collapse', () => {
        const router = new Router();
        router.get('/users/:id', 'H');

        const match = router.lookup('GET', '//users//42//');
        assert.deepEqual(params(match), { id: '42' });
    });

    test('a pattern without a leading slash is the same route', () => {
        const router = new Router();
        router.add('GET', 'users/:id', 'H');
        assert.equal(router.lookup('GET', '/users/42').handler, 'H');
    });

    test('the parameter value is decoded', () => {
        const router = new Router();
        router.get('/users/:name', 'H');

        const match = router.lookup('GET', '/users/John%20Doe');
        assert.deepEqual(params(match), { name: 'John Doe' });
    });

    test('%2F inside a segment does not split the path', () => {
        const router = new Router();
        router.get('/files/:name', 'H');

        const match = router.lookup('GET', '/files/a%2Fb.txt');
        assert.equal(match.handler, 'H');
        assert.deepEqual(params(match), { name: 'a/b.txt' });
    });

    test('malformed percent-encoding gives null, not an exception', () => {
        const router = new Router();
        router.get('/users/:id', 'H');
        assert.equal(router.lookup('GET', '/users/%ZZ'), null);
    });

    test('the method is upper-cased at registration', () => {
        const router = new Router();
        router.add('get', '/users', 'H');
        assert.equal(router.lookup('GET', '/users').handler, 'H');
    });
});

describe('wildcard', () => {
    test('consumes the rest of the path', () => {
        const router = new Router();
        router.get('/files/*rest', 'H');

        const match = router.lookup('GET', '/files/a/b/c.txt');
        assert.equal(match.handler, 'H');
        assert.deepEqual(params(match), { rest: 'a/b/c.txt' });
    });

    test('a bare star is named "*"', () => {
        const router = new Router();
        router.get('/files/*', 'H');

        assert.deepEqual(params(router.lookup('GET', '/files/a/b')), { '*': 'a/b' });
    });

    test('a last resort: static and the parameter come first', () => {
        const router = new Router();
        router.get('/files/a/b', 'STATIC');
        router.get('/files/:x', 'PARAM');
        router.get('/files/*', 'WILD');

        assert.equal(router.lookup('GET', '/files/a/b').handler, 'STATIC');
        assert.equal(router.lookup('GET', '/files/zzz').handler, 'PARAM');
        assert.equal(router.lookup('GET', '/files/a/c').handler, 'WILD');
    });

    test('backtracks into the wildcard out of a dead-end parametric branch', () => {
        const router = new Router();
        router.get('/a/:b/stop', 'PARAM');
        router.get('/a/*', 'WILD');

        assert.equal(router.lookup('GET', '/a/x/stop').handler, 'PARAM');

        const match = router.lookup('GET', '/a/x/go');
        assert.equal(match.handler, 'WILD');
        // the value starts at the wildcard's position, not where the parameter got stuck
        assert.deepEqual(params(match), { '*': 'x/go' });
    });

    test('the wildcard takes part in the per-method search', () => {
        const router = new Router();
        router.get('/x/*', 'GET-WILD');
        router.post('/x/:id', 'POST-PARAM');

        assert.equal(router.lookup('POST', '/x/abc').handler, 'POST-PARAM');
        assert.equal(router.lookup('GET', '/x/a/b').handler, 'GET-WILD');
    });

    test('the value is decoded as a whole, %2F included', () => {
        const router = new Router();
        router.get('/files/*rest', 'H');

        assert.deepEqual(params(router.lookup('GET', '/files/a%2Fb/c')), { rest: 'a/b/c' });
    });

    test('a wildcard that is not the last segment throws', () => {
        assert.throws(() => new Router().get('/a/*/b', 'H'), /Wildcard must be the last segment/);
        assert.throws(() => new Router().get('/a*b', 'H'), /Wildcard must be the last segment/);
    });

    test('an empty remainder does not match — the same in every spelling', () => {
        const router = new Router();
        router.get('/files/*', 'H');

        // trailing and repeated slashes are insignificant here, so all three are one path
        assert.equal(router.lookup('GET', '/files'), null);
        assert.equal(router.lookup('GET', '/files/'), null);
        assert.equal(router.lookup('GET', '/files///'), null);

        // a router with a significant trailing slash answers { '*': '' } to
        // '/files/' here; this divergence is deliberate
        assert.deepEqual(router.allowedMethods('/files/'), []);
    });
});

describe('allowedMethods', () => {
    test('collects the methods from every matching branch', () => {
        const router = new Router();
        router.get('/users/me', 'A');
        router.post('/users/:id', 'B');
        router.delete('/users/:id', 'C');

        // /users/me matches both the static and the parametric branch
        // HEAD is implied by GET, OPTIONS always: the Allow header must list
        // what the server will actually answer
        assert.deepEqual(router.allowedMethods('/users/me'), ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST']);
        assert.deepEqual(router.allowedMethods('/users/42'), ['DELETE', 'OPTIONS', 'POST']);
    });

    test('takes the wildcard into account', () => {
        const router = new Router();
        router.get('/files/*', 'A');

        assert.deepEqual(router.allowedMethods('/files/x/y'), ['GET', 'HEAD', 'OPTIONS']);
    });

    test('an empty array means 404, not 405', () => {
        const router = new Router();
        router.get('/users', 'A');

        assert.deepEqual(router.allowedMethods('/nope'), []);
    });

    test('an intermediate node is not a route', () => {
        const router = new Router();
        router.get('/me/feed', 'A');

        assert.deepEqual(router.allowedMethods('/me'), []);
    });

    test('parses the path the same way lookup does', () => {
        const router = new Router();
        router.get('/café/:id', 'A');
        router.post('/café/:id', 'B');

        assert.deepEqual(router.allowedMethods('/caf%C3%A9/42'), ['GET', 'HEAD', 'OPTIONS', 'POST']);
        assert.deepEqual(router.allowedMethods('//café//42/?q=1'), ['GET', 'HEAD', 'OPTIONS', 'POST']);
    });

    test('a malformed URL gives an empty list, not an exception', () => {
        const router = new Router();
        router.get('/users/:id', 'A');

        assert.deepEqual(router.allowedMethods('/users/%ZZ'), []);
    });
});

describe('percent-encoding', () => {
    const ENCODED_CAFE = '/caf%C3%A9';

    test('non-ASCII static matches in its encoded form', () => {
        // this is exactly what a browser sends: new URL('http://x/café/42').pathname
        const router = new Router();
        router.get('/café/:id', 'CAFE');

        const match = router.lookup('GET', ENCODED_CAFE + '/42');
        assert.equal(match.handler, 'CAFE');
        assert.deepEqual(params(match), { id: '42' });
    });

    test('the pattern may be written encoded — it is the same route', () => {
        const router = new Router();
        router.add('GET', ENCODED_CAFE + '/:id', 'CAFE');

        assert.equal(router.lookup('GET', '/café/42').handler, 'CAFE');
        assert.equal(router.lookup('GET', ENCODED_CAFE + '/42').handler, 'CAFE');
    });

    test('both spellings of the pattern are one route, hence a duplicate', () => {
        const router = new Router();
        router.get('/café/:id', 'CAFE');

        assert.throws(() => router.add('GET', ENCODED_CAFE + '/:id', 'DUP'), /Duplicate route/);
    });

    test('a space in a static segment', () => {
        const router = new Router();
        router.get('/a b/:id', 'H');

        assert.equal(router.lookup('GET', '/a%20b/7').handler, 'H');
    });

    test('%2F in a value does not split the path', () => {
        const router = new Router();
        router.get('/files/:name', 'H');

        const match = router.lookup('GET', '/files/a%2Fb.txt');
        assert.deepEqual(params(match), { name: 'a/b.txt' });
    });

    test('an encoded percent sign is not decoded twice', () => {
        const router = new Router();
        router.get('/users/:value', 'H');

        // %25 → '%', not an empty string and not an exception on a lone percent
        assert.deepEqual(params(router.lookup('GET', '/users/100%25')), { value: '100%' });
        assert.deepEqual(params(router.lookup('GET', '/users/a%2525b')), { value: 'a%25b' });
    });

    test('reserved characters in a value', () => {
        const router = new Router();
        router.get('/q/:value', 'H');

        assert.deepEqual(params(router.lookup('GET', '/q/a%3Fb')), { value: 'a?b' });
        assert.deepEqual(params(router.lookup('GET', '/q/a%23b')), { value: 'a#b' });
    });

    test('malformed encoding in the URL gives null', () => {
        const router = new Router();
        router.get('/users/:id', 'H');

        assert.equal(router.lookup('GET', '/users/%ZZ'), null);
        assert.equal(router.lookup('GET', '/%ZZ/42'), null);
    });
});

describe('HEAD and OPTIONS', () => {
    test('HEAD uses the GET handler when it has none of its own', () => {
        const router = new Router();
        router.get('/users/:id', 'GET');

        const match = router.lookup('HEAD', '/users/42');
        assert.equal(match.handler, 'GET');
        assert.deepEqual(params(match), { id: '42' });
    });

    test('an explicit HEAD route wins over the fallback', () => {
        const router = new Router();
        router.get('/users', 'GET');
        router.add('HEAD', '/users', 'HEAD');

        assert.equal(router.lookup('HEAD', '/users').handler, 'HEAD');
    });

    test('the HEAD tree is walked in full before the fallback', () => {
        const router = new Router();
        router.get('/users/me', 'GET-STATIC');
        router.add('HEAD', '/users/:id', 'HEAD-PARAM');

        // The fallback is a second walk after a miss in the HEAD tree, not a
        // per-node alternative: an explicit HEAD route beats an implicit one even
        // when its pattern is less specific.
        const match = router.lookup('HEAD', '/users/me');
        assert.equal(match.handler, 'HEAD-PARAM');
        assert.deepEqual(params(match), { id: 'me' });
    });

    test('the fallback can be switched off', () => {
        const router = new Router({ headFallback: false });
        router.get('/users', 'GET');

        assert.equal(router.lookup('HEAD', '/users'), null);
        assert.deepEqual(router.allowedMethods('/users'), ['GET', 'OPTIONS']);
    });

    test('OPTIONS can be switched off', () => {
        const router = new Router({ implicitOptions: false });
        router.get('/users', 'GET');

        assert.deepEqual(router.allowedMethods('/users'), ['GET', 'HEAD']);
    });

    test('nothing is implied on a path that did not match', () => {
        const router = new Router();
        router.get('/users', 'GET');

        assert.deepEqual(router.allowedMethods('/nope'), []);
    });
});

describe('mount', () => {
    test('re-registers the routes under a prefix', () => {
        const users = new Router();
        users.get('/', 'LIST');
        users.get('/:id', 'ONE');

        const root = new Router();
        root.mount('/api/v1/users', users);

        assert.equal(root.lookup('GET', '/api/v1/users').handler, 'LIST');
        assert.equal(root.lookup('GET', '/api/v1/users/42').handler, 'ONE');
        assert.equal(root.lookup('GET', '/api/v1/users/42').pattern, '/api/v1/users/:id');
    });

    test('the pattern is joined without a stray slash', () => {
        const child = new Router();
        child.get('/', 'ROOT');
        child.get('/:id', 'ONE');

        const root = new Router();
        root.mount('/api/users/', child);

        // the pattern ends up in metrics: /api/users and /api/users/ would be two series
        assert.equal(root.lookup('GET', '/api/users').pattern, '/api/users');
        assert.equal(root.lookup('GET', '/api/users/42').pattern, '/api/users/:id');
    });

    test('a parameter in the prefix itself', () => {
        const members = new Router();
        members.get('/members/:id', 'MEMBER');

        const root = new Router();
        root.mount('/orgs/:orgId', members);

        const match = root.lookup('GET', '/orgs/7/members/42');
        assert.equal(match.handler, 'MEMBER');
        assert.deepEqual(params(match), { orgId: '7', id: '42' });
    });

    test('one router can be mounted twice', () => {
        const child = new Router();
        child.get('/ping', 'PING');

        const root = new Router();
        root.mount('/a', child);
        root.mount('/b', child);

        assert.equal(root.lookup('GET', '/a/ping').handler, 'PING');
        assert.equal(root.lookup('GET', '/b/ping').handler, 'PING');
    });

    test('a snapshot, not a live link', () => {
        const child = new Router();
        child.get('/early', 'EARLY');

        const root = new Router();
        root.mount('/api', child);

        child.get('/late', 'LATE');

        assert.equal(root.lookup('GET', '/api/early').handler, 'EARLY');
        assert.equal(root.lookup('GET', '/api/late'), null);
    });

    test('a parameter name clash on mount throws', () => {
        const child = new Router();
        child.get('/:id', 'H');

        const root = new Router();
        assert.throws(() => root.mount('/orgs/:id', child), /Duplicate parameter name/);
    });
});

describe('off and reset', () => {
    test('removes the route and rebuilds the tree', () => {
        const router = new Router();
        router.get('/users', 'A');
        router.get('/users/:id', 'B');

        assert.equal(router.off('GET', '/users/:id'), true);
        assert.equal(router.lookup('GET', '/users/42'), null);
        assert.equal(router.lookup('GET', '/users').handler, 'A');
    });

    test('parameter names are not part of the identity', () => {
        const router = new Router();
        router.get('/users/:userId', 'B');

        assert.equal(router.off('GET', '/users/:id'), true);
        assert.equal(router.lookup('GET', '/users/42'), null);
    });

    test('removes only the given method', () => {
        const router = new Router();
        router.get('/users', 'GET');
        router.post('/users', 'POST');

        router.off('GET', '/users');

        assert.equal(router.lookup('GET', '/users'), null);
        assert.equal(router.lookup('POST', '/users').handler, 'POST');
    });

    test('a route that does not exist gives false', () => {
        const router = new Router();
        router.get('/users', 'A');

        assert.equal(router.off('GET', '/nope'), false);
        assert.equal(router.lookup('GET', '/users').handler, 'A');
    });

    test('the same route can be registered again after off', () => {
        const router = new Router();
        router.get('/users', 'A');
        router.off('GET', '/users');
        router.get('/users', 'B');

        assert.equal(router.lookup('GET', '/users').handler, 'B');
    });

    test('reset clears everything', () => {
        const router = new Router();
        router.get('/users', 'A');
        router.reset();

        assert.equal(router.lookup('GET', '/users'), null);
        assert.deepEqual(router.routes(), []);
    });
});

describe('introspection', () => {
    test('routes returns the routes in registration order', () => {
        const router = new Router();
        router.get('/users', 'A');
        router.post('/users/:id', 'B');

        assert.deepEqual(router.routes(), [
            { method: 'GET', pattern: '/users', handler: 'A' },
            { method: 'POST', pattern: '/users/:id', handler: 'B' },
        ]);
    });

    test('prettyPrint shows the prefix compression', () => {
        const router = new Router();
        router.get('/api/v1/users', 'A');
        router.get('/api/v1/orgs', 'B');
        router.get('/api/v1/users/:id', 'C');
        router.get('/files/*', 'D');

        const printed = router.prettyPrint();

        // the shared chunk collapsed into one node, not three per-segment ones
        assert.match(printed, /^\s+api\/v1\/$/m);
        assert.match(printed, /users {2}\[GET\]/);
        assert.match(printed, /:param {2}\[GET\]/);
        assert.match(printed, /\*wildcard {2}\[GET\]/);
    });

    test('routes of another method do not fragment the tree', () => {
        const router = new Router();
        router.get('/users/:id/members', 'A');
        router.post('/users/:id/promote', 'B');

        // In a shared tree the POST route would split '/members' into '/' and
        // 'members' — an extra node on every GET request. Every method has its own tree.
        assert.match(router.prettyPrint(), /^\s+\/members {2}\[GET\]$/m);
    });
});

describe('limits', () => {
    test('a URL that is too long misses without a walk', () => {
        const router = new Router({ maxPathLength: 64 });
        router.get('/a/:b', 'H');

        assert.equal(router.lookup('GET', '/a/' + 'x'.repeat(200)), null);
        assert.deepEqual(router.allowedMethods('/a/' + 'x'.repeat(200)), []);
        assert.equal(router.lookup('GET', '/a/short').handler, 'H');
    });

    test('the limit measures the path, not the URL with its query', () => {
        const router = new Router({ maxPathLength: 64 });
        router.get('/a/:b', 'H');

        // A long query string is normal (OAuth callbacks, filters); a 404 on it is unacceptable.
        const query = '?token=' + 'x'.repeat(5000);
        assert.equal(router.lookup('GET', '/a/short' + query).handler, 'H');
        assert.deepEqual(router.allowedMethods('/a/short' + query), ['GET', 'HEAD', 'OPTIONS']);
        assert.equal(router.lookup('GET', '/a/' + 'x'.repeat(200) + query), null);
    });

    test('a pattern that is too long throws at registration', () => {
        const router = new Router({ maxPathLength: 32 });

        assert.throws(() => router.get('/' + 'x'.repeat(100), 'H'), /maxPathLength/);
    });

    test('a static suffix after a parameter is rejected rather than silently swallowed', () => {
        const router = new Router();

        assert.throws(() => router.get('/:file.json', 'H'), /Invalid parameter name/);
    });

    test('a duplicate parameter name within one pattern throws', () => {
        const router = new Router();

        assert.throws(() => router.get('/:id/x/:id', 'H'), /Duplicate parameter name/);
    });

    test('a prefix before a parameter still works', () => {
        const router = new Router();
        router.get('/user:name', 'H');

        assert.deepEqual(params(router.lookup('GET', '/userBob')), { name: 'Bob' });
    });
});

describe('registration', () => {
    test('without code generation the params builder runs on a loop', () => {
        // The builder is compiled with new Function; under the Node flag that is an
        // EvalError, and the router must silently switch to the loop. Checked in a
        // child process — the flag cannot be turned on in this one.
        const script = `
            const { Router } = await import(${JSON.stringify(new URL('../src/router.js', import.meta.url).href)});
            const router = new Router();
            router.get('/users/:id/:sub', 'H');
            router.get('/files/*rest', 'H');
            const a = router.lookup('GET', '/users/42/x');
            const b = router.lookup('GET', '/files/a/b');
            console.log(JSON.stringify([{ ...a.params }, { ...b.params }]));
        `;

        const out = execFileSync(
            process.execPath,
            ['--disallow-code-generation-from-strings', '--input-type=module', '-e', script],
            { encoding: 'utf8' },
        );

        assert.deepEqual(JSON.parse(out), [{ id: '42', sub: 'x' }, { rest: 'a/b' }]);
    });

    test('a duplicate method and path throws', () => {
        const router = new Router();
        router.get('/users', 'first');
        assert.throws(() => router.get('/users', 'second'), /Duplicate route: GET \/users/);
    });

    test('a duplicate with different parameter names throws and names the conflict', () => {
        const router = new Router();
        router.get('/users/:id', 'first');
        assert.throws(
            () => router.get('/users/:userId', 'second'),
            /conflicts with \/users\/:id/,
        );
    });

    test('a malformed pattern throws at registration', () => {
        const router = new Router();
        assert.throws(() => router.get('/users/%ZZ', 'H'), /Malformed path/);
    });

    test('the handler is stored as is and never called', () => {
        const router = new Router();
        const payload = { fn: () => {}, schema: {} };
        router.get('/users', payload);
        assert.equal(router.lookup('GET', '/users').handler, payload);
    });
});
