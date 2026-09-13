/*
 * API tour. Run: node examples/router.js
 */
import { Router } from '../src/router.js';

/* --- a child router, mounted further down ------------------------------- */

const users = new Router();

users.get('/', () => 'list users');
users.post('/', () => 'create user');
users.get('/:id', () => 'user by id');
users.patch('/:userId', () => 'update');            // its own parameter name per method
users.get('/:id/promote', () => 'promote');
users.get('/me', () => 'current user');            // static wins over the parameter

/* --- the root ------------------------------------------------------------ */

const router = new Router();

router.mount('/api/v1/users', users);
router.get('/api/v1/orgs/:orgId/members/:id', () => 'organisation member');
router.get('/files/*path', () => 'serve file');
router.get('/health', () => 'ok');

/* --- lookup -------------------------------------------------------------- */

const requests = [
    ['GET', '/health'],
    ['GET', '/api/v1/users'],
    ['GET', '/api/v1/users/42?q=abcd'],        // the query string is cut off
    ['PATCH', '/api/v1/users/42'],             // the parameter name is per method
    ['GET', '/api/v1/users/me'],               // static wins over the parameter
    ['GET', '/api/v1/users/42/promote'],
    ['GET', '/api/v1/orgs/7/members/3'],
    ['GET', '/files/img/logo%2Ffinal.png'],    // %2F does not split the path
    ['GET', '//api/v1//users//42//'],          // repeated slashes collapse
    ['HEAD', '/health'],                       // HEAD uses the GET handler
    ['DELETE', '/api/v1/users'],               // the path exists, the method does not
    ['GET', '/nope'],
];

console.log('LOOKUP\n');

for (const [method, url] of requests) {
    const match = router.lookup(method, url);
    const request = `${method} ${url}`;

    if (match !== null) {
        console.log(
            `  ${request.padEnd(34)} → ${match.pattern.padEnd(34)} ` +
            `${JSON.stringify({ ...match.params })}  ${match.handler()}`,
        );
        continue;
    }

    // a miss: 404 and 405 are told apart by the list of allowed methods
    const allowed = router.allowedMethods(url);

    console.log(
        `  ${request.padEnd(34)} → ` +
        (allowed.length > 0 ? `405, Allow: ${allowed.join(', ')}` : '404'),
    );
}

/* --- introspection ------------------------------------------------------- */

console.log('\nTREES\n');
console.log(router.prettyPrint().split('\n').map((line) => '  ' + line).join('\n'));

console.log(`\nREGISTERED: ${router.routes().length} routes`);

router.off('GET', '/health');
console.log(`AFTER off('GET', '/health'): ${router.routes().length}, lookup gives ${router.lookup('GET', '/health')}`);
