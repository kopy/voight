import { describe, expect, test } from "vitest";

import { tenantScopingPolicy } from "../../../src/policies";
import { compileStrict } from "../../_support/compile";

const tenantPolicy = tenantScopingPolicy({
    tables: ["timeseries", "orders"],
    scopeColumn: "tenant_id",
    contextKey: "tenantId",
});

const bigintTenantPolicy = tenantScopingPolicy({
    tables: ["timeseries", "orders"],
    scopeColumn: "tenant_id",
    contextKey: "tenantId",
    scopeValueType: "bigint",
});

const numberTenantPolicy = tenantScopingPolicy({
    tables: ["timeseries", "orders"],
    scopeColumn: "tenant_id",
    contextKey: "tenantId",
    scopeValueType: "number",
});

const booleanTenantPolicy = tenantScopingPolicy({
    tables: ["timeseries", "orders"],
    scopeColumn: "tenant_id",
    contextKey: "tenantId",
    scopeValueType: "boolean",
});

function compileTenantScoped(sql: string, tenantId: unknown = "tenant-123") {
    return compileStrict(sql, {
        policies: [tenantPolicy],
        policyContext: { tenantId },
    });
}

function compileWithPolicy(sql: string, policy = tenantPolicy, tenantId: unknown = "tenant-123") {
    return compileStrict(sql, {
        policies: [policy],
        policyContext: { tenantId },
    });
}

describe("emitter tenant scoping output", () => {
    test("emits bigint tenant predicates as exact integer literals", () => {
        const result = compileWithPolicy("SELECT metric FROM timeseries", bigintTenantPolicy, 42n);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("`timeseries`.`tenant_id` = 42");
    });

    test("emits the largest supported uint64 tenant value without precision loss", () => {
        const result = compileWithPolicy(
            "SELECT metric FROM timeseries",
            bigintTenantPolicy,
            18446744073709551615n,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("`timeseries`.`tenant_id` = 18446744073709551615");
    });

    test("emits tenant predicates inside scalar subqueries", () => {
        const result = compileTenantScoped(
            "SELECT id, (SELECT metric FROM timeseries LIMIT 1) FROM users",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("`timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("emits tenant predicates for both outer and correlated inner scopes", () => {
        const result = compileTenantScoped(
            "SELECT timeseries.metric FROM timeseries WHERE timeseries.value > (SELECT COUNT(t2.id) FROM timeseries AS t2 WHERE t2.metric = timeseries.metric)",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect((result.emitted?.sql.match(/tenant-123/g) ?? []).length).toBe(2);
    });

    test("keeps scoped LEFT JOIN predicates in the ON clause", () => {
        const result = compileTenantScoped(
            "SELECT u.id FROM users AS u LEFT JOIN orders AS o ON u.id = o.user_id",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("LEFT JOIN `orders` AS `o` ON");
        expect(result.emitted?.sql).toContain("`o`.`tenant_id` = 'tenant-123'");
    });

    test("renders tenant scope values according to their literal kind", () => {
        const cases = [
            { policy: tenantPolicy, tenantId: "my-tenant", fragment: "'my-tenant'" },
            { policy: numberTenantPolicy, tenantId: 42, fragment: "= 42" },
            { policy: booleanTenantPolicy, tenantId: true, fragment: "= TRUE" },
            { policy: tenantPolicy, tenantId: null, fragment: "IS NULL" },
        ] as const;

        for (const { policy, tenantId, fragment } of cases) {
            const result = compileWithPolicy("SELECT metric FROM timeseries", policy, tenantId);
            expect(result.ok, `Failed for tenant value ${String(tenantId)}`).toBe(true);
            if (result.ok) {
                expect(result.emitted?.sql).toContain(fragment);
            }
        }
    });

    test("rejects numeric and boolean values for default string tenant guards", () => {
        for (const tenantId of [42, 42n, true, false]) {
            const result = compileTenantScoped("SELECT metric FROM timeseries", tenantId);

            expect(result.ok, `Unexpected success for ${String(tenantId)}`).toBe(false);
            if (!result.ok) {
                expect(result.diagnostics[0]?.message).toContain("requires string tenant values");
            }
        }
    });
});
