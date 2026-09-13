# Changelog

## 0.1.0 — unreleased

First release.

- radix tree per HTTP method; static → `:param` → `*wildcard` priority with mandatory backtracking
- `lookup` returns `{ pattern, params, handler }`; `params` has a null prototype
- `allowedMethods` for `405` with `Allow`; `HEAD` and `OPTIONS` implied, both switchable
- `mount`, `off`, `reset`, `routes`, `prettyPrint`
- percent-encoding decoded in two passes; trailing and repeated slashes are insignificant
- `maxPathLength` guards the path, query string excluded
- params builder compiled per route, with a loop fallback where code generation is disallowed
- TypeScript declarations inferring parameter names from the path literal
