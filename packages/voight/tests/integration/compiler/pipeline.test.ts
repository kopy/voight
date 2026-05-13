import { describe, expect, test } from "vitest";

import { AliasCatalog, createCatalogAlias } from "../../../src/catalog";
import { compile } from "../../../src/compiler";
import { CompilerStage, DiagnosticCode, formatDiagnostics } from "../../../src/core/diagnostics";
import { allowedFunctionsPolicy, maxLimitPolicy, tenantScopingPolicy } from "../../../src/policies";
import { createTestCatalog } from "../../../src/testing";

describe("compile", () => {
    test("returns a sanitized public error surface by default", () => {
        const result = compile("SELECT id FROM missing", {
            catalog: createTestCatalog(),
        });

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Compiler);
        expect(result.diagnostics[0]?.message).toBe('Unknown table "missing".');
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownTable);
        expect(result.diagnostics[0]?.help).toBeUndefined();
        expect(result.ast).toBeUndefined();
        expect(result.bound).toBeUndefined();
        expect(result.stages).toBeUndefined();
    });

    test("hides internal compiler artifacts on successful public results", () => {
        const result = compile("SELECT id FROM users", {
            catalog: createTestCatalog(),
        });

        expect(result.ok).toBe(true);
        expect(result.terminalStage).toBe(CompilerStage.Compiler);
        expect(result.emitted?.sql).toBe("SELECT `users`.`id` FROM `users`");
        expect(result.ast).toBeUndefined();
        expect(result.bound).toBeUndefined();
        expect(result.stages).toBeUndefined();
    });

    test("exposes detailed internals only in debug mode", () => {
        const result = compile("SELECT id FROM missing", {
            catalog: createTestCatalog(),
            debug: true,
        });

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Binder);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownTable);
        expect(result.diagnostics[0]?.message).toContain("missing");
    });

    test("runs the full pipeline for a valid query", () => {
        const result = compile(
            "SELECT id, name FROM users WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10",
            {
                catalog: createTestCatalog(),
                policies: [allowedFunctionsPolicy({ allowedFunctions: new Set(["sum", "count"]) })],
                debug: true,
            },
        );

        expect(result.ok).toBe(true);
        expect(result.terminalStage).toBe(CompilerStage.Emitter);
        expect(result.stages?.rewrite?.stage).toBe(CompilerStage.Rewriter);
        expect(result.stages?.enforce?.stage).toBe(CompilerStage.Enforcer);
        expect(result.emitted?.sql).toBe(
            "SELECT `users`.`id`, `users`.`name` FROM `users` WHERE `users`.`tenant_id` = ? ORDER BY `users`.`created_at` DESC LIMIT 10",
        );
    });

    test("short-circuits on parse failure", () => {
        const result = compile("UPDATE users SET name = 'x'", {
            catalog: createTestCatalog(),
            debug: true,
        });

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Parser);
        expect(result.stages?.bind).toBeUndefined();
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnsupportedStatement);
    });

    test("rejects source-level null bytes before the native parser truncates input", () => {
        const result = compile("SELECT id FROM users\0", {
            catalog: createTestCatalog(),
            debug: true,
        });

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Parser);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnexpectedCharacter);
    });

    test("supports CTEs and subqueries in the full pipeline", () => {
        const result = compile(
            "WITH recent_orders AS (SELECT user_id FROM orders WHERE status = 'paid') SELECT id FROM users WHERE id IN (SELECT user_id FROM recent_orders)",
            {
                catalog: createTestCatalog(),
                debug: true,
            },
        );

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("WITH `recent_orders` AS");
        expect(result.emitted?.sql).toContain(
            "IN (SELECT `recent_orders`.`user_id` FROM `recent_orders`)",
        );
    });

    test("renders descriptive diagnostics with source locations", () => {
        const result = compile("SELECT id FROM missing", {
            catalog: createTestCatalog(),
            debug: true,
        });

        expect(result.ok).toBe(false);
        const diagnostic = result.diagnostics[0];
        expect(diagnostic?.code).toBe(DiagnosticCode.UnknownTable);
        expect(diagnostic?.primarySpan).toEqual({ start: 15, end: 22 });

        const formatted = formatDiagnostics({
            source: "SELECT id FROM missing",
            diagnostics: [diagnostic!],
        });
        expect(formatted).toContain("binder/unknown-table");
        expect(formatted).toContain("1:16-1:23");
        expect(formatted).toContain('near "...FROM missing"');
    });

    test("formats compile failures into one external string", () => {
        const result = compile("SELECT id FROM missing", {
            catalog: createTestCatalog(),
            debug: true,
        });

        expect(result.ok).toBe(false);

        const formatted = formatDiagnostics(result);
        expect(formatted).toContain('Unknown table "missing".');
        expect(formatted).toContain("binder/unknown-table");
        expect(formatted).toContain("1:16-1:23");
        expect(formatted).toContain('near "...FROM missing"');
    });

    test("short-circuits on native frontend failure before binding", () => {
        const result = compile("SELECT id FROM users @", {
            catalog: createTestCatalog(),
            debug: true,
        });

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Parser);
        expect(result.stages?.parse?.stage).toBe(CompilerStage.Parser);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnexpectedToken);
    });

    test("short-circuits on enforcement failure before emit", () => {
        const result = compile("SELECT SUM(total) FROM orders LIMIT 1000", {
            catalog: createTestCatalog(),
            policies: [
                allowedFunctionsPolicy({ allowedFunctions: new Set(["count"]) }),
                maxLimitPolicy({ maxLimit: 100 }),
            ],
            debug: true,
        });

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Enforcer);
        expect(result.stages?.emit).toBeUndefined();
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
            DiagnosticCode.DisallowedFunction,
        );
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
            DiagnosticCode.LimitExceeded,
        );
    });

    test("injects the configured default limit only on the outermost select", () => {
        const result = compile(
            "WITH recent_orders AS (SELECT user_id FROM orders) SELECT id FROM users WHERE id IN (SELECT user_id FROM recent_orders)",
            {
                catalog: createTestCatalog(),
                policies: [maxLimitPolicy({ maxLimit: 100, defaultLimit: 25 })],
                debug: true,
            },
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toBe(
            "WITH `recent_orders` AS (SELECT `orders`.`user_id` FROM `orders`) SELECT `users`.`id` FROM `users` WHERE `users`.`id` IN (SELECT `recent_orders`.`user_id` FROM `recent_orders`) LIMIT 25",
        );
        expect(result.rewrittenAst?.body.limit?.count.kind).toBe("Literal");
        if (result.rewrittenAst?.body.limit?.count.kind === "Literal") {
            expect(result.rewrittenAst.body.limit.count.value).toBe("25");
        }
        expect(result.rewrittenAst?.with?.ctes[0]?.query.body.limit).toBeUndefined();
    });

    test("injects the configured default limit into nested selects when recursive", () => {
        const result = compile(
            "WITH recent_orders AS (SELECT user_id FROM orders) SELECT id FROM users WHERE id IN (SELECT user_id FROM recent_orders)",
            {
                catalog: createTestCatalog(),
                policies: [maxLimitPolicy({ maxLimit: 100, defaultLimit: 25, recursive: true })],
                debug: true,
            },
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toBe(
            "WITH `recent_orders` AS (SELECT `orders`.`user_id` FROM `orders` LIMIT 25) SELECT `users`.`id` FROM `users` WHERE `users`.`id` IN (SELECT `recent_orders`.`user_id` FROM `recent_orders` LIMIT 25) LIMIT 25",
        );
        expect(result.rewrittenAst?.with?.ctes[0]?.query.body.limit?.count.kind).toBe("Literal");
    });

    test("denies functions unless allowed-functions is configured", () => {
        const result = compile("SELECT SLEEP(10) FROM users", {
            catalog: createTestCatalog(),
            debug: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.DisallowedFunction);
        }
    });

    test("rejects dangerous functions when allowed-functions is configured explicitly", () => {
        const result = compile("SELECT SLEEP(10) FROM users", {
            catalog: createTestCatalog(),
            policies: [allowedFunctionsPolicy({ allowedFunctions: new Set(["count"]) })],
            debug: true,
        });

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Enforcer);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.DisallowedFunction);
    });

    test("preserves bound artifacts on enforcement failure", () => {
        const result = compile("SELECT SUM(total) FROM orders", {
            catalog: createTestCatalog(),
            policies: [allowedFunctionsPolicy({ allowedFunctions: new Set(["count"]) })],
            debug: true,
        });

        expect(result.ok).toBe(false);
        expect(result.ast?.kind).toBe("Query");
        expect(result.bound?.kind).toBe("BoundQuery");
        expect(result.emitted).toBeUndefined();
    });

    test("supports virtualized table aliases through the catalog", () => {
        const catalog = new AliasCatalog(createTestCatalog(), [
            createCatalogAlias({
                from: ["projects"],
                to: ["internal_projects"],
            }),
        ]);

        const result = compile("SELECT id, name FROM projects WHERE tenant_id = ?", {
            catalog,
            debug: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe(
            "SELECT `projects`.`id`, `projects`.`name` FROM `internal_projects` AS `projects` WHERE `projects`.`tenant_id` = ?",
        );
    });

    test("rewrites tenant-scoped queries automatically", () => {
        const result = compile("SELECT metric FROM timeseries", {
            catalog: createTestCatalog(),
            policies: [
                tenantScopingPolicy({
                    tables: ["timeseries"],
                    scopeColumn: "tenant_id",
                    contextKey: "tenantId",
                    scopeValueType: "string",
                }),
            ],
            policyContext: {
                tenantId: "tenant-123",
            },
            debug: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe(
            "SELECT `timeseries`.`metric` FROM `timeseries` WHERE `timeseries`.`tenant_id` = 'tenant-123'",
        );
    });

    test("surfaces missing tenant scoping policy context as an internal debug diagnostic", () => {
        const result = compile("SELECT metric FROM timeseries", {
            catalog: createTestCatalog(),
            policies: [
                tenantScopingPolicy({
                    tables: ["timeseries"],
                    scopeColumn: "tenant_id",
                    contextKey: "tenantId",
                    scopeValueType: "string",
                }),
            ],
            debug: true,
        });

        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.PolicyExecutionError);
        expect(result.diagnostics[0]?.message).toContain("requires policyContext.tenantId");
    });

    test("redacts missing tenant scoping policy context from the public surface", () => {
        const result = compile("SELECT metric FROM timeseries", {
            catalog: createTestCatalog(),
            policies: [
                tenantScopingPolicy({
                    tables: ["timeseries"],
                    scopeColumn: "tenant_id",
                    contextKey: "tenantId",
                    scopeValueType: "string",
                }),
            ],
        });

        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.InternalCompilerError);
    });

    test("supports projection-only and current temporal selects", () => {
        const inputs = [
            ["SELECT 1", "SELECT 1"],
            ["SELECT 1;", "SELECT 1"],
        ] as const;

        for (const [sql, expected] of inputs) {
            const result = compile(sql, {
                catalog: createTestCatalog(),
                debug: true,
            });

            expect(result.ok).toBe(true);
            expect(result.emitted?.sql).toBe(expected);
        }
    });

    test("supports current temporal expressions when explicitly allowed", () => {
        const inputs = [
            ["SELECT now()", "SELECT now()"],
            ["SELECT (CURRENT_TIMESTAMP)", "SELECT (CURRENT_TIMESTAMP)"],
            ["SELECT (CURRENT_DATE)", "SELECT (CURRENT_DATE)"],
            ["SELECT (CURRENT_TIME)", "SELECT (CURRENT_TIME)"],
            ["SELECT CURRENT_TIME", "SELECT CURRENT_TIME"],
        ] as const;

        for (const [sql, expected] of inputs) {
            const result = compile(sql, {
                catalog: createTestCatalog(),
                policies: [
                    allowedFunctionsPolicy({
                        allowedFunctions: new Set([
                            "now",
                            "current_timestamp",
                            "current_date",
                            "current_time",
                        ]),
                    }),
                ],
                debug: true,
            });

            expect(result.ok).toBe(true);
            expect(result.emitted?.sql).toBe(expected);
        }
    });

    test("preserves large numeric literals as exact strings", () => {
        const sql = "SELECT 9007199254740993123456789";
        const result = compile(sql, {
            catalog: createTestCatalog(),
            debug: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe(sql);
    });

    test("supports CAST, ROUND, COALESCE, NULLIF, and both CASE forms end-to-end", () => {
        const result = compile(
            `SELECT
  CAST(total AS DECIMAL(10, 2)) AS rounded_total,
  ROUND(total, 2) AS rounded_value,
  COALESCE(status, 'none') AS status_or_default,
  NULLIF(status, 'cancelled') AS active_status,
  CASE WHEN total > 100 THEN 'large' ELSE 'small' END AS size_bucket,
  CASE status WHEN 'paid' THEN 1 WHEN 'shipped' THEN 2 ELSE 0 END AS status_rank
FROM orders`,
            {
                catalog: createTestCatalog(),
                policies: [
                    allowedFunctionsPolicy({
                        allowedFunctions: new Set(["round", "coalesce", "nullif"]),
                    }),
                ],
                debug: true,
            },
        );

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("CAST(`orders`.`total` AS DECIMAL(10, 2))");
        expect(result.emitted?.sql).toContain("round(`orders`.`total`, 2)");
        expect(result.emitted?.sql).toContain("coalesce(`orders`.`status`, 'none')");
        expect(result.emitted?.sql).toContain("nullif(`orders`.`status`, 'cancelled')");
        expect(result.emitted?.sql).toContain(
            "CASE WHEN `orders`.`total` > 100 THEN 'large' ELSE 'small' END",
        );
        expect(result.emitted?.sql).toContain(
            "CASE `orders`.`status` WHEN 'paid' THEN 1 WHEN 'shipped' THEN 2 ELSE 0 END",
        );
    });

    test("supports INTERVAL-based MySQL date arithmetic functions end-to-end", () => {
        const sql = `SELECT
  DATE_ADD(created_at, INTERVAL 1 DAY) AS plus_day,
  DATE_SUB(created_at, INTERVAL ? MONTH) AS minus_month,
  ADDDATE(created_at, INTERVAL 2 YEAR) AS plus_years,
  SUBDATE(created_at, INTERVAL 3 HOUR) AS minus_hours
FROM orders`;
        const result = compile(sql, {
            catalog: createTestCatalog(),
            policies: [
                allowedFunctionsPolicy({
                    allowedFunctions: new Set(["date_add", "date_sub", "adddate", "subdate"]),
                }),
            ],
            debug: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain(
            "date_add(`orders`.`created_at`, INTERVAL 1 DAY) AS `plus_day`",
        );
        expect(result.emitted?.sql).toContain(
            "date_sub(`orders`.`created_at`, INTERVAL ? MONTH) AS `minus_month`",
        );
        expect(result.emitted?.sql).toContain(
            "adddate(`orders`.`created_at`, INTERVAL 2 YEAR) AS `plus_years`",
        );
        expect(result.emitted?.sql).toContain(
            "subdate(`orders`.`created_at`, INTERVAL 3 HOUR) AS `minus_hours`",
        );
        expect(result.emitted?.parameters).toEqual([sql.indexOf("?")]);
    });

    test("rejects non-whitespace content after a trailing semicolon", () => {
        const result = compile("SELECT 1; SELECT 2", {
            catalog: createTestCatalog(),
            debug: true,
        });

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Parser);
    });

    test("supports a complex query with a derived table, IN list, and alias ordering", () => {
        const sql = `SELECT
  u.id,
  u.email,
  COALESCE(p.display_name, u.email) AS name,
  COUNT(o.id) AS order_count,
  SUM(o.total_cents) / 100.0 AS revenue
FROM users AS u
LEFT JOIN profiles p ON p.user_id = u.id AND p.deleted_at IS NULL
INNER JOIN (
  SELECT user_id, id, total_cents, created_at
  FROM orders
  WHERE status IN ('paid', 'shipped')
    AND created_at >= '2024-01-01'
) AS o ON o.user_id = u.id
WHERE u.age > 18
GROUP BY u.id, u.email, p.display_name
HAVING COUNT(o.id) >= 0
ORDER BY revenue ASC
LIMIT 100 OFFSET 20`;

        const result = compile(sql, {
            catalog: createTestCatalog(),
            policies: [
                allowedFunctionsPolicy({
                    allowedFunctions: new Set(["coalesce", "count", "sum"]),
                }),
            ],
            debug: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain("ORDER BY sum(`o`.`total_cents`) / 100.0 ASC");
        expect(result.emitted?.sql).toContain(
            "WHERE `orders`.`status` IN ('paid', 'shipped') AND `orders`.`created_at` >= '2024-01-01'",
        );
        expect(result.emitted?.sql).toContain(
            "INNER JOIN (SELECT `orders`.`user_id`, `orders`.`id`, `orders`.`total_cents`, `orders`.`created_at` FROM `orders`",
        );
    });

    test("rejects a trailing comma in the select list", () => {
        const result = compile("SELECT u.id, FROM users AS u", {
            catalog: createTestCatalog(),
            debug: true,
        });

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Parser);
    });
});
