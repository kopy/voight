import { describe, expect, test } from "vitest";

import { compile } from "../../../src/compiler";
import { allowedFunctionsPolicy, tenantScopingPolicy } from "../../../src/policies";
import { createTestCatalog } from "../../../src/testing";

/**
 * Post-fix verification: expression subqueries are now tenant-scoped.
 *
 * Previously, the rewrite and enforce phases did not traverse subqueries
 * inside expressions (EXISTS, IN, scalar). After the fix, all paths
 * correctly inject tenant predicates.
 */

const catalog = createTestCatalog();
const tenantPolicy = tenantScopingPolicy({
    tables: ["timeseries"],
    scopeColumn: "tenant_id",
    contextKey: "tenantId",
    scopeValueType: "string",
});
const allowedFunctionPolicy = allowedFunctionsPolicy({
    allowedFunctions: new Set(["count", "min", "max"]),
});

function compileTenantScoped(sql: string) {
    return compile(sql, {
        catalog,
        policies: [tenantPolicy, allowedFunctionPolicy],
        policyContext: { tenantId: "tenant-123" },
        debug: true,
    });
}

describe("FIXED: expression subqueries are now tenant-scoped", () => {
    test("EXISTS — tenant predicate injected into inner query", () => {
        const result = compileTenantScoped(
            "SELECT id FROM users WHERE EXISTS (SELECT 1 FROM timeseries WHERE timeseries.id = users.id)",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("scalar subquery in SELECT — tenant predicate injected", () => {
        const result = compileTenantScoped(
            "SELECT id, (SELECT metric FROM timeseries LIMIT 1) FROM users",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("scalar subquery in WHERE — tenant predicate injected", () => {
        const result = compileTenantScoped(
            "SELECT id FROM users WHERE name = (SELECT metric FROM timeseries LIMIT 1)",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("REGEXP predicate — scoped table still receives tenant predicate", () => {
        const result = compileTenantScoped(
            "SELECT metric FROM timeseries WHERE metric REGEXP '^login'",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
        expect(result.emitted!.sql).toContain("`timeseries`.`metric` REGEXP '^login'");
    });

    test("IN subquery — tenant predicate injected", () => {
        const result = compileTenantScoped(
            "SELECT id FROM users WHERE id IN (SELECT timeseries.id FROM timeseries)",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("BETWEEN scalar subquery operand — tenant predicate injected", () => {
        const result = compileTenantScoped(
            "SELECT id FROM users WHERE (SELECT COUNT(timeseries.id) FROM timeseries) BETWEEN 1 AND 10",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("BETWEEN scalar subquery bounds — tenant predicates injected", () => {
        const result = compileTenantScoped(
            "SELECT id FROM users WHERE age BETWEEN (SELECT MIN(value) FROM timeseries) AND (SELECT MAX(value) FROM timeseries)",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql.match(/tenant-123/g) ?? []).toHaveLength(2);
    });

    test("NOT IN subquery — tenant predicate injected", () => {
        const result = compileTenantScoped(
            "SELECT id FROM users WHERE id NOT IN (SELECT timeseries.id FROM timeseries)",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("HAVING subquery — both outer and inner scoped", () => {
        const result = compileTenantScoped(
            "SELECT tenant_id, COUNT(id) FROM timeseries GROUP BY tenant_id HAVING COUNT(id) > (SELECT COUNT(id) FROM timeseries)",
        );
        expect(result.ok).toBe(true);
        const matches = result.emitted!.sql.match(/tenant-123/g) ?? [];
        expect(matches.length).toBe(2); // Both outer and inner now scoped
    });

    test("correlated scalar subquery — both outer and inner timeseries scopes are injected", () => {
        const result = compileTenantScoped(
            "SELECT timeseries.metric FROM timeseries WHERE timeseries.value > (SELECT COUNT(t2.id) FROM timeseries AS t2 WHERE t2.metric = timeseries.metric)",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted!.sql.match(/tenant-123/g) ?? []).toHaveLength(2);
    });

    test("derived table in FROM — still works (regression check)", () => {
        const result = compileTenantScoped(
            "SELECT d.metric FROM (SELECT metric FROM timeseries) AS d",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("CTE body — still works (regression check)", () => {
        const result = compileTenantScoped(
            "WITH ts AS (SELECT metric FROM timeseries) SELECT metric FROM ts",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("scalar subqueries inside window PARTITION BY are tenant-scoped", () => {
        const result = compileTenantScoped(
            "SELECT id, COUNT(id) OVER (PARTITION BY (SELECT metric FROM timeseries LIMIT 1)) FROM users",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted!.sql).toContain("PARTITION BY (SELECT `timeseries`.`metric`");
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("scalar subqueries inside window ORDER BY are tenant-scoped", () => {
        const result = compileTenantScoped(
            "SELECT id, COUNT(id) OVER (ORDER BY (SELECT COUNT(timeseries.id) FROM timeseries)) FROM users",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted!.sql).toContain("ORDER BY (SELECT count(`timeseries`.`id`)");
        expect(result.emitted!.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });
});
