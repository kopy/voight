# voight

`voight` is a TypeScript SQL compiler and policy engine for a restricted MySQL `SELECT` subset.

It is built for untrusted query text: parse it with a native WebAssembly frontend, normalize it through a staged compiler pipeline, resolve it against an explicit catalog, enforce policies, and emit canonical SQL.

The published consumer package is [`@voight8/voight`](./packages/voight/README.md).

## Workspace

This repository is a `pnpm` workspace.

```txt
.
├── native/parser/        # ANTLR grammar, C++ frontend, wasm build pipeline
├── packages/
│   ├── voight/           # public compiler and policy engine package
│   └── voight-parser/    # internal workspace wrapper for the generated wasm bundle
├── scripts/              # shared parser/build/release helpers
├── tools/                # pinned parser toolchain metadata
└── docs/                 # design notes and implementation plans
```

## Supported SQL

The current compiler intentionally targets a constrained `SELECT`-only surface:

- `WITH` and `SELECT`
- Derived tables, `CROSS JOIN`, `INNER JOIN`, and `LEFT JOIN`
- `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`, and `OFFSET`
- Scalar subqueries, `EXISTS`, `IN (...)`, and `IN (subquery)`
- Arithmetic and boolean expressions
- `CASE`, `CAST`, interval expressions, and `CURRENT_*` keywords
- Positional parameters using `?`
- MySQL-style quoted identifiers using backticks

Unsupported SQL should be rejected before it reaches emission.

## Main Package

The main package lives in [`packages/voight`](./packages/voight).

Its source is grouped by concern:

```txt
packages/voight/src/
├── ast/          # parser-facing AST schema, bound AST, traversal helpers
├── binder/       # name resolution, scope handling, bound query construction
├── catalog/      # catalog interfaces, schema helpers, aliasing
├── compiler/     # compile orchestration, rewrite, enforce
├── core/         # diagnostics, source spans, stage results
├── emitter/      # canonical SQL emission and parameter metadata
├── parser/       # parser entrypoint and native adapter
├── policies/     # policy registry and built-in policy implementations
└── testing/      # test fixtures and helpers
```

## Pipeline

`compile(...)` runs queries through these stages:

1. `parse`
2. `rewrite`
3. `bind`
4. `enforce`
5. `emit`

Stage responsibilities:

- `parse` uses the wasm parser to produce a validated `QueryAst`.
- `rewrite` applies policy rewrites and any custom rewriters.
- `bind` resolves tables, columns, aliases, CTEs, and subquery scopes against a catalog.
- `enforce` runs policies against the bound query.
- `emit` produces canonical SQL and parameter position metadata.

By default, `compile(...)` returns a public-safe result surface: emitted SQL on success, or sanitized diagnostics on failure. With `debug: true`, it also returns AST, rewritten AST, bound query state, per-stage results, and internal diagnostics.

## Built-in Policies

`voight` currently ships with these policy helpers:

- `tenantScopingPolicy(...)` to inject and enforce tenant filters on configured tables
- `maxLimitPolicy(...)` to cap the outer `LIMIT`, optionally cap outer `OFFSET`, and optionally add a default outer `LIMIT`
- `allowedFunctionsPolicy(...)` to restrict callable SQL functions and `CURRENT_*` keywords
- `supportedOperatorsPolicy()` to reject operators outside the supported policy surface

`maxLimitPolicy(...)` constrains the final result set by default, so nested selects are not
limited unless `recursive: true` is configured.

`tenantScopingPolicy(...)` requires `scopeValueType` on every scope rule and enforces that type
at runtime. Use `scopeValueType: "string"` for string scope columns, or configure the matching
numeric or boolean type, for example `scopeValueType: "bigint"` for a `BIGINT project_id`.

String tenant scopes require careful database configuration. MySQL in particular has many
string comparison gotchas around implicit casts, collations, charsets, padding, and
case/accent equivalence. Avoid string tenant identifiers unless those semantics are deliberate;
if you use them, choose binary or otherwise case-sensitive comparison semantics so values such
as `project-alpha` and `PROJECT-ALPHA` cannot share a scope unintentionally.

## Example

```ts
import {
    InMemoryCatalog,
    compile,
    createTableSchema,
    maxLimitPolicy,
    tenantScopingPolicy,
} from "@voight8/voight";

const catalog = new InMemoryCatalog([
    createTableSchema({
        path: ["tracking", "time_series_stats"],
        columns: ["id", "tenant_id", "metric", "created_at"],
    }),
]);

const result = compile(
    "SELECT ts.metric FROM tracking.time_series_stats AS ts WHERE ts.created_at >= ? ORDER BY ts.created_at DESC",
    {
        catalog,
        policies: [
            maxLimitPolicy({ maxLimit: 100, defaultLimit: 25 }),
            tenantScopingPolicy({
                tables: ["tracking.time_series_stats"],
                scopeColumn: "tenant_id",
                contextKey: "tenantId",
                scopeValueType: "string",
            }),
        ],
        policyContext: {
            tenantId: "tenant-123",
        },
    },
);

if (result.ok) {
    console.log(result.emitted.sql);
    console.log(result.emitted.parameters);
}
```

## Catalog Helpers

Catalogs are explicit. `InMemoryCatalog` resolves tables and columns case-insensitively, `createTableSchema(...)` derives canonical table and column ids from the declared path, and `AliasCatalog` plus `createCatalogAlias(...)` let you map logical table names to physical tables.

Columns can also be marked as non-selectable with:

```ts
createTableSchema({
    path: ["users"],
    columns: ["id", { name: "tenant_id", selectable: false }],
});
```

Wildcard expansion respects that metadata, and direct references to non-selectable columns fail during binding.

## Parser Stack

The parser is split into two layers:

- [`native/parser`](./native/parser) owns the grammar, generated C++, wasm build, and native JSON lowering.
- [`packages/voight-parser`](./packages/voight-parser) is the internal workspace boundary that loads the generated parser bundle for `@voight8/voight`.

ANTLR is pinned through [`tools/antlr-toolchain.env`](./tools/antlr-toolchain.env). The parser build scripts verify the toolchain checksum and skip unnecessary regeneration when grammar inputs have not changed.

## Development

```bash
pnpm install
pnpm parser:build
pnpm typecheck
pnpm test
```

Useful package-specific commands:

```bash
pnpm --filter @voight8/voight build
pnpm --filter @voight8/voight test
pnpm --filter @voight/voight-parser parser:build
```

## Publishing

`@voight8/voight` is published from [`packages/voight`](./packages/voight) and ships as an ESM-only package.

Release flow:

1. Update [`packages/voight/package.json`](./packages/voight/package.json) with the target version.
2. Create a Git tag and GitHub Release named `v<version>`, for example `v0.1.0`.
3. Publish the GitHub Release.

The [`Publish npm Package`](./.github/workflows/release-package.yml) workflow verifies the release tag matches the package version, rebuilds the parser wasm bundle, builds `@voight8/voight`, smoke-tests the packed tarball, and publishes to npm.

Stable releases publish to the npm `latest` dist-tag. GitHub prereleases publish to the npm `next` dist-tag.
