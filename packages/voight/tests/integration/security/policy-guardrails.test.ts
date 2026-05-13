import { describe, expect, test } from "vitest";

import { DiagnosticCode } from "../../../src/core/diagnostics";
import { tenantScopingPolicy } from "../../../src/policies";
import { compileStrict, compileWithAllowedFunctions } from "../../_support/compile";

const tenantPolicy = tenantScopingPolicy({
    tables: ["timeseries"],
    scopeColumn: "tenant_id",
    contextKey: "tenantId",
    scopeValueType: "string",
});

function compileTenantScoped(sql: string, tenantId = "tenant-123") {
    return compileStrict(sql, {
        policies: [tenantPolicy],
        policyContext: { tenantId },
    });
}

describe("policy guardrails", () => {
    test("neutralizes OR-based tenant bypass attempts by injecting the canonical guard", () => {
        const result = compileTenantScoped(
            "SELECT metric FROM timeseries WHERE tenant_id = 'tenant-123' OR 1 = 1",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("AND `timeseries`.`tenant_id` = 'tenant-123'");
    });

    test("scopes each alias independently when the same table is joined twice", () => {
        const result = compileTenantScoped(
            "SELECT t1.metric FROM timeseries AS t1 INNER JOIN timeseries AS t2 ON t1.id = t2.id",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("`t1`.`tenant_id` = 'tenant-123'");
        expect(result.emitted?.sql).toContain("`t2`.`tenant_id` = 'tenant-123'");
    });

    test("enforces configured max-limit boundaries", () => {
        const result = compileStrict("SELECT id FROM users LIMIT 200", { maxLimit: 100 });
        expect(result.ok).toBe(false);
        expect(
            result.diagnostics.some(
                (diagnostic) => diagnostic.code === DiagnosticCode.LimitExceeded,
            ),
        ).toBe(true);
    });

    test("blocks functions outside the allowlist while permitting allowed ones", () => {
        const blocked = compileWithAllowedFunctions(
            "SELECT SLEEP(10) FROM users",
            new Set(["count"]),
        );
        expect(blocked.ok).toBe(false);
        expect(
            blocked.diagnostics.some(
                (diagnostic) => diagnostic.code === DiagnosticCode.DisallowedFunction,
            ),
        ).toBe(true);

        expect(
            compileWithAllowedFunctions("SELECT COUNT(id) FROM users", new Set(["count"])).ok,
        ).toBe(true);
    });
});
