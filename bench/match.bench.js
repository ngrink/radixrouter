import { createRequire } from 'node:module';
import { Router } from '../src/router.js';

const require = createRequire(import.meta.url);
const FindMyWay = require('find-my-way');

/* -----------------------------------------------------------------------------
   A route table modelled on a real REST API.
   On five routes a tree loses to a plain Map, so we measure on 200+.
----------------------------------------------------------------------------- */

const RESOURCES = ['users', 'orgs', 'teams', 'projects', 'issues', 'comments', 'labels', 'milestones', 'webhooks', 'keys'];
const SUBRESOURCES = ['members', 'settings', 'activity', 'stats', 'invites'];
const ACTIONS = ['promote', 'demote', 'archive', 'restore', 'duplicate'];

function buildRoutes() {
    const routes = [
        ['GET', '/health'],
        ['GET', '/metrics'],
        ['GET', '/api/v1/status'],
    ];

    for (const resource of RESOURCES) {
        routes.push(['GET', `/api/v1/${resource}`]);
        routes.push(['POST', `/api/v1/${resource}`]);
        // a static sibling of the parameter — the source of backtracking
        routes.push(['GET', `/api/v1/${resource}/search`]);

        routes.push(['GET', `/api/v1/${resource}/:id`]);
        routes.push(['PATCH', `/api/v1/${resource}/:id`]);
        routes.push(['DELETE', `/api/v1/${resource}/:id`]);

        for (const sub of SUBRESOURCES) {
            routes.push(['GET', `/api/v1/${resource}/:id/${sub}`]);
            routes.push(['GET', `/api/v1/${resource}/:id/${sub}/:subId`]);
        }

        for (const action of ACTIONS) {
            routes.push(['POST', `/api/v1/${resource}/:id/${action}`]);
        }
    }

    // explicit backtracking cases
    routes.push(['GET', '/deep/:a/:b/:c/end']);
    routes.push(['GET', '/deep/x/y/z/other']);

    return routes;
}

const ROUTES = buildRoutes();

/* -----------------------------------------------------------------------------
   Requests split by kind: averaging them into one number is meaningless,
   a static hit and a walk with backtracking cost different things.
----------------------------------------------------------------------------- */

const QUERIES = {
    'static, shallow': ['GET', '/health'],
    'static, deep': ['GET', '/api/v1/issues/search'],
    'one parameter': ['GET', '/api/v1/users/1234567'],
    'parameter + sub-resource': ['GET', '/api/v1/projects/42/members'],
    'two parameters': ['GET', '/api/v1/orgs/42/invites/7'],
    'backtrack three levels': ['GET', '/deep/x/y/z/end'],
    'path miss': ['GET', '/api/v1/nope/1234'],
    'method miss': ['DELETE', '/api/v1/users/42/members'],
};

/* -------------------------------------------------------------------------- */

const ITERATIONS = 1_000_000;
const ROUNDS = 5;

/** @returns {number} nanoseconds per operation, best round */
function measure(fn) {
    for (let i = 0; i < 50_000; i++) fn();

    let best = Infinity;

    for (let round = 0; round < ROUNDS; round++) {
        const started = process.hrtime.bigint();
        let sink = 0;

        for (let i = 0; i < ITERATIONS; i++) {
            if (fn() !== null) sink++;
        }

        const elapsed = Number(process.hrtime.bigint() - started);
        if (sink < 0) console.log(sink); // keeps the optimiser from dropping the loop
        best = Math.min(best, elapsed / ITERATIONS);
    }

    return best;
}

/**
 * One build is invisible against a heap of megabytes, so build fifty and divide.
 *
 * @returns {number} kilobytes per router
 */
function heapPerRouter(build) {
    const keep = [];

    global.gc?.();
    const before = process.memoryUsage().heapUsed;

    for (let i = 0; i < 50; i++) keep.push(build());

    global.gc?.();
    return (process.memoryUsage().heapUsed - before) / keep.length / 1024;
}

function buildTime(build) {
    for (let i = 0; i < 20; i++) build();
    const started = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) build();
    return Number(process.hrtime.bigint() - started) / 100 / 1e6;
}

function buildOurs() {
    const router = new Router();
    for (const [method, path] of ROUTES) router.add(method, path, path);
    return router;
}

function buildTheirs() {
    const router = FindMyWay();
    for (const [method, path] of ROUTES) router.on(method, path, () => {}, { path });
    return router;
}

const ours = buildOurs();
const theirs = buildTheirs();

console.log(`Routes: ${ROUTES.length}`);
console.log(`Node: ${process.version}\n`);

/* --- correctness before measuring ----------------------------------------- */

// Doubles as a warm-up with every query shape. Without it V8 specialises find()
// to a single shape: the reference router on shallow static gives 23M ops/s alone
// and 15M after the first parametric request. The settled version is the one to
// measure — it is the one a server runs.

for (const [name, [method, url]] of Object.entries(QUERIES)) {
    const a = ours.lookup(method, url);
    const b = theirs.find(method, url);
    const same = (a === null) === (b === null) && (a === null || a.pattern === b.store.path);
    if (!same) {
        console.error(`\nMISMATCH on "${name}": ${a?.pattern} vs ${b?.store.path}`);
        process.exit(1);
    }
}

/* --- lookup --------------------------------------------------------------- */

console.log('\nLOOKUP (million operations per second, higher is better)');
console.log('  ' + 'request'.padEnd(26) + 'radixrouter'.padStart(13) + 'find-my-way'.padStart(14) + 'ratio'.padStart(9));

for (const [name, [method, url]] of Object.entries(QUERIES)) {
    const oursNs = measure(() => ours.lookup(method, url));
    const theirsNs = measure(() => theirs.find(method, url));

    const oursOps = 1000 / oursNs;
    const theirsOps = 1000 / theirsNs;
    const ratio = theirsNs / oursNs;

    console.log(
        '  ' + name.padEnd(26) +
        oursOps.toFixed(2).padStart(13) +
        theirsOps.toFixed(2).padStart(14) +
        `×${ratio.toFixed(2)}`.padStart(9),
    );
}

console.log('\nratio > 1 — radixrouter is faster');

/* --- registration and memory ---------------------------------------------- */

// After lookup, not before: a hundred builds ahead of the measurement are also
// GC background noise for the first rounds.

console.log('\nREGISTRATION');
console.log(`  radixrouter   ${buildTime(buildOurs).toFixed(2)} ms   heap ~${heapPerRouter(buildOurs).toFixed(0)} KB`);
console.log(`  find-my-way   ${buildTime(buildTheirs).toFixed(2)} ms   heap ~${heapPerRouter(buildTheirs).toFixed(0)} KB`);
