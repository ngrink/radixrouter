import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { Router } from '../src/router.js';

const require = createRequire(import.meta.url);
const FindMyWay = require('find-my-way');

/*
 * A check against a third-party implementation on random route tables. It
 * catches what nobody would think to write a targeted test for: the priority
 * order and the depth of backtracking. The generator is deterministic, so a
 * failure reproduces.
 */

let seed = 987654321;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (list) => list[Math.floor(random() * list.length)];

// Non-ASCII and percent-encoding in the alphabet: without them the check stayed
// silent about static segments not being decoded (a browser sends exactly the
// encoded form).
const WORDS = ['users', 'orgs', 'me', 'feed', 'posts', 'a', 'b', 'x', 'y', 'café', 'ü', 'a b'];
const NAMES = ['id', 'userId', 'slug', 'n'];
const METHODS = ['GET', 'POST', 'DELETE'];

/** Duplicate key: parameter names are not part of a route's identity */
const withoutNames = (pattern) => pattern.replace(/:[^/]+/g, ':');

function randomPattern() {
    const depth = 1 + Math.floor(random() * 4);
    const segments = [];

    // Parameter names are unique within a pattern: the router rejects /:id/:id,
    // and rightly so — the second value would silently overwrite the first.
    const used = new Set();

    for (let i = 0; i < depth; i++) {
        if (random() < 0.35) {
            const free = NAMES.filter((n) => !used.has(n));

            if (free.length > 0) {
                const name = pick(free);
                used.add(name);
                segments.push(':' + name);
                continue;
            }
        }

        segments.push(pick(WORDS));
    }

    // A bare star, not a named one: the reference implementation does not
    // support named wildcards, and only what both sides read the same way can
    // be compared.
    if (random() < 0.2) {
        segments.push('*');
    }

    return '/' + segments.join('/');
}

test('agrees with the reference implementation on random route tables', () => {
    let checked = 0;

    for (let round = 0; round < 300; round++) {
        const ours = new Router();
        const theirs = FindMyWay();
        const registered = new Set();

        for (let i = 0; i < 12; i++) {
            const pattern = randomPattern();
            const method = pick(METHODS);
            const key = method + ' ' + withoutNames(pattern);

            if (registered.has(key)) {
                continue;
            }
            registered.add(key);

            ours.add(method, pattern, pattern);
            theirs.on(method, pattern, () => {}, { pattern });
        }

        for (let query = 0; query < 40; query++) {
            const depth = 1 + Math.floor(random() * 4);
            const segments = Array.from({ length: depth }, () => pick(WORDS));
            // half of the requests are encoded, the way a real client would send them
            const url = '/' + segments.map((s) => (random() < 0.5 ? encodeURIComponent(s) : s)).join('/');
            const method = pick(METHODS);

            const mine = ours.lookup(method, url);
            const other = theirs.find(method, url);
            checked++;

            const a = mine === null ? null : { pattern: mine.pattern, params: { ...mine.params } };
            const b = other === undefined || other === null
                ? null
                : { pattern: other.store.pattern, params: { ...other.params } };

            assert.deepEqual(
                a,
                b,
                `${method} ${url}\nroutes: ${[...registered].join(' | ')}`,
            );
        }
    }

    assert.ok(checked > 10000, `only ${checked} requests compared`);
});
