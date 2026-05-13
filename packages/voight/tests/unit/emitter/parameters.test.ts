import { describe, expect, test } from "vitest";

import { tenantScopingPolicy } from "../../../src/policies";
import { compileStrict } from "../../_support/compile";

const tenantPolicy = tenantScopingPolicy({
    tables: ["timeseries"],
    scopeColumn: "tenant_id",
    contextKey: "tenantId",
    scopeValueType: "string",
});

function compileTenantScoped(sql: string, tenantId: unknown = "tenant-123") {
    return compileStrict(sql, {
        policies: [tenantPolicy],
        policyContext: { tenantId },
    });
}

describe("emitter parameter ordering", () => {
    test("preserves parameter order across a single query", () => {
        const result = compileStrict(
            "SELECT id FROM users WHERE name = ? AND age > ? AND email = ?",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.parameters).toHaveLength(3);
        expect(result.emitted?.parameters[0]! < result.emitted?.parameters[1]!).toBe(true);
        expect(result.emitted?.parameters[1]! < result.emitted?.parameters[2]!).toBe(true);
    });

    test("keeps outer parameters ahead of subquery parameters", () => {
        const result = compileStrict(
            "SELECT id FROM users WHERE name = ? AND id IN (SELECT user_id FROM orders WHERE total > ?)",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.parameters).toHaveLength(2);
        expect(result.emitted?.parameters[0]! < result.emitted?.parameters[1]!).toBe(true);
    });

    test("preserves source order across CTE and outer query parameters", () => {
        const result = compileStrict(
            "WITH filtered AS (SELECT id FROM users WHERE age > ?) SELECT id FROM filtered WHERE id = ?",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.parameters).toHaveLength(2);
        expect(result.emitted?.parameters[0]! < result.emitted?.parameters[1]!).toBe(true);
    });

    test("does not shift user parameter indices when tenant scoping injects literals", () => {
        const result = compileTenantScoped("SELECT metric FROM timeseries WHERE value > ?");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.parameters).toHaveLength(1);
    });
});
