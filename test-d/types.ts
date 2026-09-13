/*
 * A type check, not a behaviour check: `node --test` does not run this file.
 * It exists because router.d.ts is not verified against router.js automatically —
 * TypeScript treats the declaration as the truth and never looks at the
 * implementation. This file uses the public API the way a consumer of the
 * package would, and catches the drift.
 *
 * Kept outside test/ because Node 24 executes .ts directly and would otherwise
 * run this file as an ordinary test.
 *
 * Run: npm run typecheck
 */
import { Router } from '../src/router.js';

const router = new Router();

router.get('/health', (req, res, params) => {
    // @ts-expect-error /health has no parameters
    params.id;
});

router.get('/users/:id', (req, res, params) => {
    const id: string = params.id;
    // @ts-expect-error no such parameter in the path
    params.userId;
    void id;
});

router.get('/orgs/:orgId/users/:id', (req, res, params) => {
    const org: string = params.orgId;
    const id: string = params.id;
    void org;
    void id;
});

router.get('/files/*rest', (req, res, params) => {
    const rest: string = params.rest;
    void rest;
});

router.get('/assets/*', (req, res, params) => {
    const rest: string = params['*'];
    void rest;
});

router.post('/orgs/:orgId/files/*rest', (req, res, params) => {
    const org: string = params.orgId;
    const rest: string = params.rest;
    void org;
    void rest;
});

// req and res are the real node:http types
router.patch('/x/:id', (req, res) => {
    const host: string | undefined = req.headers.host;
    res.statusCode = 200;
    void host;
});

// lookup: the path is only known at runtime, nothing more precise than Record applies
const match = router.lookup('GET', '/users/42');

if (match !== null) {
    const pattern: string = match.pattern;
    const id: string = match.params.id;
    void pattern;
    void id;
}

const allowed: string[] = router.allowedMethods('/users/42');
void allowed;

// A payload of your own instead of a function: the router never calls it anyway
interface Route {
    fn: () => void;
    schema: object;
}

const typed = new Router<Route>();
typed.get('/users/:id', { fn: () => {}, schema: {} });

// Constructor options
const limited = new Router({ maxPathLength: 2048, headFallback: false, implicitOptions: false });
limited.get('/x', (req, res) => void res.end());

// Route table management
const removed: boolean = limited.off('GET', '/x');
limited.reset();
void removed;

const child = new Router();
child.get('/ping', (req, res) => void res.end());
limited.mount('/api', child);

for (const route of limited.routes()) {
    const method: string = route.method;
    const pattern: string = route.pattern;
    void method;
    void pattern;
}

const tree: string = limited.prettyPrint();
void tree;

const stored = typed.lookup('GET', '/users/42');

if (stored !== null) {
    stored.handler.fn();
}
