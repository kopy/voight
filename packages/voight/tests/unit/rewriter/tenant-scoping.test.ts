import { describe, expect, test } from "vitest";

import { compile } from "../../../src/compiler";
import { InMemoryCatalog, createTableSchema } from "../../../src/catalog";
import { allowedFunctionsPolicy, tenantScopingPolicy } from "../../../src/policies";
import { createTestCatalog } from "../../../src/testing";

describe("tenant scoping rewrite", () => {
    const policy = tenantScopingPolicy({
        tables: ["timeseries"],
        scopeColumn: "tenant_id",
        contextKey: "tenantId",
        scopeValueType: "string",
    });

    test("rewrites aliased table scans", () => {
        const result = compile("SELECT t.metric FROM timeseries AS t", {
            catalog: createTestCatalog(),
            policies: [policy],
            policyContext: { tenantId: "tenant-123" },
            debug: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe(
            "SELECT `t`.`metric` FROM `timeseries` AS `t` WHERE `t`.`tenant_id` = 'tenant-123'",
        );
    });

    test("rewrites scans inside CTEs", () => {
        const result = compile(
            "WITH scoped AS (SELECT metric FROM timeseries) SELECT metric FROM scoped",
            {
                catalog: createTestCatalog(),
                policies: [policy],
                policyContext: { tenantId: "tenant-123" },
                debug: true,
            },
        );

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain(
            "WITH `scoped` AS (SELECT `timeseries`.`metric` FROM `timeseries` WHERE `timeseries`.`tenant_id` = 'tenant-123')",
        );
    });

    test("rewrites scans inside derived tables", () => {
        const result = compile("SELECT d.metric FROM (SELECT metric FROM timeseries) AS d", {
            catalog: createTestCatalog(),
            policies: [policy],
            policyContext: { tenantId: "tenant-123" },
            debug: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain(
            "(SELECT `timeseries`.`metric` FROM `timeseries` WHERE `timeseries`.`tenant_id` = 'tenant-123') AS `d`",
        );
    });

    test("rewrites null tenant scope values with IS NULL", () => {
        const result = compile("SELECT metric FROM timeseries", {
            catalog: createTestCatalog(),
            policies: [policy],
            policyContext: { tenantId: null },
            debug: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe(
            "SELECT `timeseries`.`metric` FROM `timeseries` WHERE `timeseries`.`tenant_id` IS NULL",
        );
    });

    test("rewrites tenant-scoped references inside INTERVAL expressions", () => {
        const scopedUsersPolicy = tenantScopingPolicy({
            tables: ["users"],
            scopeColumn: "tenant_id",
            contextKey: "tenantId",
            scopeValueType: "string",
        });

        const result = compile("SELECT DATE_ADD(created_at, INTERVAL tenant_id DAY) FROM users", {
            catalog: createTestCatalog(),
            policies: [
                scopedUsersPolicy,
                allowedFunctionsPolicy({ allowedFunctions: new Set(["date_add"]) }),
            ],
            policyContext: { tenantId: "tenant-123" },
            debug: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain(
            "date_add(`users`.`created_at`, INTERVAL `users`.`tenant_id` DAY)",
        );
        expect(result.emitted?.sql).toContain("WHERE `users`.`tenant_id` = 'tenant-123'");
    });

    test("injects scoped predicates for joined tables into JOIN ON", () => {
        const result = compile(
            "SELECT users.id FROM users LEFT JOIN timeseries AS ts ON ts.id = users.id WHERE users.tenant_id = ?",
            {
                catalog: createTestCatalog(),
                policies: [policy],
                policyContext: { tenantId: "tenant-123" },
                debug: true,
            },
        );

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain(
            "LEFT JOIN `timeseries` AS `ts` ON `ts`.`id` = `users`.`id` AND `ts`.`tenant_id` = 'tenant-123'",
        );
        expect(result.emitted?.sql).not.toContain(
            "WHERE `users`.`tenant_id` = ? AND `ts`.`tenant_id` = 'tenant-123'",
        );
    });

    test("rewrites unsafe join predicates without changing tenant scope semantics", () => {
        const result = compile(
            "SELECT users.id FROM users LEFT JOIN timeseries AS ts ON ts.id = users.id OR 1 = 1",
            {
                catalog: createTestCatalog(),
                policies: [policy],
                policyContext: { tenantId: "tenant-123" },
                debug: true,
            },
        );

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain(
            "LEFT JOIN `timeseries` AS `ts` ON (`ts`.`id` = `users`.`id` OR 1 = 1) AND `ts`.`tenant_id` = 'tenant-123'",
        );
    });

    test("scopes every configured table across a multi-join query", () => {
        const result = compile(
            "SELECT u.id, o.total, p.name, pr.display_name FROM users AS u INNER JOIN orders AS o ON o.user_id = u.id LEFT JOIN internal_projects AS p ON p.id = o.id LEFT JOIN profiles AS pr ON pr.user_id = u.id WHERE u.age > 18",
            {
                catalog: createTestCatalog(),
                policies: [
                    tenantScopingPolicy({
                        tables: ["users", "orders", "internal_projects"],
                        scopeColumn: "tenant_id",
                        contextKey: "tenantId",
                        scopeValueType: "string",
                    }),
                ],
                policyContext: { tenantId: "tenant-123" },
                debug: true,
            },
        );

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain(
            "INNER JOIN `orders` AS `o` ON `o`.`user_id` = `u`.`id` AND `o`.`tenant_id` = 'tenant-123'",
        );
        expect(result.emitted?.sql).toContain(
            "LEFT JOIN `internal_projects` AS `p` ON `p`.`id` = `o`.`id` AND `p`.`tenant_id` = 'tenant-123'",
        );
        expect(result.emitted?.sql).toContain(
            "LEFT JOIN `profiles` AS `pr` ON `pr`.`user_id` = `u`.`id`",
        );
        expect(result.emitted?.sql).toContain(
            "WHERE `u`.`age` > 18 AND `u`.`tenant_id` = 'tenant-123'",
        );
        expect(result.emitted?.sql).not.toContain("`pr`.`tenant_id`");
    });

    test("scopes each alias when the same table is joined twice", () => {
        const result = compile(
            "SELECT manager.id, report.id FROM users AS manager LEFT JOIN users AS report ON report.id = manager.id",
            {
                catalog: createTestCatalog(),
                policies: [
                    tenantScopingPolicy({
                        tables: ["users"],
                        scopeColumn: "tenant_id",
                        contextKey: "tenantId",
                        scopeValueType: "string",
                    }),
                ],
                policyContext: { tenantId: "tenant-123" },
                debug: true,
            },
        );

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain(
            "LEFT JOIN `users` AS `report` ON `report`.`id` = `manager`.`id` AND `report`.`tenant_id` = 'tenant-123'",
        );
        expect(result.emitted?.sql).toContain("WHERE `manager`.`tenant_id` = 'tenant-123'");
    });

    test("composes explicit scope rules for different tenant columns", () => {
        const catalog = new InMemoryCatalog([
            createTableSchema({
                path: ["users"],
                columns: ["id", "tenant_id"],
            }),
            createTableSchema({
                path: ["subscriptions"],
                columns: ["id", "user_id", "account_id"],
            }),
        ]);
        const result = compile(
            "SELECT u.id, s.id FROM users AS u INNER JOIN subscriptions AS s ON s.user_id = u.id",
            {
                catalog,
                policies: [
                    tenantScopingPolicy({
                        scopes: [
                            {
                                tables: ["users"],
                                scopeColumn: "tenant_id",
                                contextKey: "tenantId",
                                scopeValueType: "string",
                            },
                            {
                                tables: ["subscriptions"],
                                scopeColumn: "account_id",
                                contextKey: "tenantId",
                                scopeValueType: "string",
                            },
                        ],
                    }),
                ],
                policyContext: { tenantId: "tenant-123" },
                debug: true,
            },
        );

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain(
            "INNER JOIN `subscriptions` AS `s` ON `s`.`user_id` = `u`.`id` AND `s`.`account_id` = 'tenant-123'",
        );
        expect(result.emitted?.sql).toContain("WHERE `u`.`tenant_id` = 'tenant-123'");
    });
});
