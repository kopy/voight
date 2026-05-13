# `@voight8/voight`

`@voight8/voight` is a TypeScript SQL compiler and policy engine for a restricted MySQL `SELECT` subset.

It is designed for untrusted SQL input: parse, rewrite, bind against a catalog, enforce policies, and emit canonical SQL plus parameter metadata.

## Install

```bash
npm install @voight8/voight
```

## Runtime

- Node.js `>=20`
- ESM-only package

## What It Supports

The current package focuses on a constrained `SELECT` surface:

- `WITH` and `SELECT`
- Derived tables, `CROSS JOIN`, `INNER JOIN`, and `LEFT JOIN`
- `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`, and `OFFSET`
- Scalar subqueries, `EXISTS`, `IN (...)`, and `IN (subquery)`
- Arithmetic and boolean expressions
- `CASE`, `CAST`, interval expressions, and `CURRENT_*`
- Positional parameters using `?`

Unsupported SQL is expected to fail with diagnostics rather than being passed through.

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

## Public API

The main exported entrypoints are:

- `compile(source, options)`
- `InMemoryCatalog`
- `AliasCatalog`
- `createTableSchema(...)`
- `createCatalogAlias(...)`
- `allowedFunctionsPolicy(...)`
- `maxLimitPolicy(...)`
- `supportedOperatorsPolicy()`
- `tenantScopingPolicy(...)`

`compile(...)` runs the query through `parse`, `rewrite`, `bind`, `enforce`, and `emit`.

By default, the result is sanitized for public use:

- Success returns emitted SQL and parameter ordering metadata.
- Failure returns public-safe diagnostics and hides internal compiler state.

If you pass `debug: true`, the result also includes the parsed AST, rewritten AST, bound query, per-stage outputs, and internal diagnostics.

For LLM-facing error text, keep the structured diagnostics from `compile(...)` and format them at the boundary:

```ts
import { compile, formatDiagnostics } from "@voight8/voight";

const result = compile("SELECT id FROM missing", { catalog });

if (!result.ok) {
    const errorMessage = formatDiagnostics(result);
    console.log(errorMessage);
}
```

## Catalogs

Catalogs are explicit and case-insensitive:

```ts
import { InMemoryCatalog, createTableSchema } from "@voight8/voight";

const catalog = new InMemoryCatalog([
    createTableSchema({
        path: ["users"],
        columns: [
            "id",
            "email",
            { name: "tenant_id", selectable: false },
        ],
    }),
]);
```

Non-selectable columns are preserved in the schema, excluded from wildcard expansion, and rejected when queried directly.

Use `AliasCatalog` and `createCatalogAlias(...)` if your public logical table names should resolve to different physical tables.

## Built-in Policies

- `tenantScopingPolicy(...)` injects tenant predicates during rewrite and verifies them during enforcement.
- `maxLimitPolicy(...)` caps the outer `LIMIT`, can cap the outer `OFFSET`, and can add a default outer `LIMIT`.
- `allowedFunctionsPolicy(...)` allowlists function calls and `CURRENT_*` keywords.
- `supportedOperatorsPolicy()` rejects operators outside the supported policy surface.

`maxLimitPolicy(...)` constrains the final result set by default, so nested selects are not
limited unless `recursive: true` is configured.

`tenantScopingPolicy(...)` requires `scopeValueType` on every scope rule and enforces that type
at runtime. Use `scopeValueType: "string"` for string scope columns, or configure the matching
numeric or boolean type, for example `scopeValueType: "bigint"` for a `BIGINT project_id`.

String tenant scopes require careful database configuration. MySQL in particular has many string
comparison gotchas around implicit casts, collations, charsets, padding, and case/accent
equivalence. Avoid string tenant identifiers unless those semantics are deliberate; if you use
them, choose binary or otherwise case-sensitive comparison semantics so values such as
`project-alpha` and `PROJECT-ALPHA` cannot share a scope unintentionally.

## Repository

The source repository lives at [github.com/lukaskratzel/voight](https://github.com/lukaskratzel/voight). The workspace README has more detail on the parser stack, development workflow, and release process.
