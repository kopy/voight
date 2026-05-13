import { describe, expect, test } from "vitest";

import { DiagnosticCode } from "../../../src/core/diagnostics";
import { enforce } from "../../../src/compiler/enforcer";
import { tenantScopingPolicy } from "../../../src/policies";
import { bindStatement } from "../../_support/bind";

describe("tenant scoping enforcement", () => {
    const policy = tenantScopingPolicy({
        tables: ["timeseries"],
        scopeColumn: "tenant_id",
        contextKey: "tenantId",
        scopeValueType: "string",
    });

    test("rejects OR-based bypasses during enforcement", () => {
        const bound = bindStatement(
            "SELECT metric FROM timeseries WHERE tenant_id = 'tenant-123' OR 1 = 1",
        );
        const result = enforce(bound, {
            policies: [policy],
            policyContext: { tenantId: "tenant-123" },
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
            DiagnosticCode.PolicyViolation,
        );
    });

    test("accepts additional filters when tenant scope is preserved with AND", () => {
        const bound = bindStatement(
            "SELECT metric FROM timeseries WHERE tenant_id = 'tenant-123' AND metric = 'cpu'",
        );
        const result = enforce(bound, {
            policies: [policy],
            policyContext: { tenantId: "tenant-123" },
        });

        expect(result.ok).toBe(true);
    });

    test("accepts tenant guards for every scoped table in a multi-join query", () => {
        const multiTablePolicy = tenantScopingPolicy({
            tables: ["users", "orders", "internal_projects"],
            scopeColumn: "tenant_id",
            contextKey: "tenantId",
            scopeValueType: "string",
        });
        const bound = bindStatement(
            "SELECT u.id, o.total, p.name FROM users AS u INNER JOIN orders AS o ON o.user_id = u.id AND o.tenant_id = 'tenant-123' LEFT JOIN internal_projects AS p ON p.id = o.id AND p.tenant_id = 'tenant-123' WHERE u.tenant_id = 'tenant-123' AND u.age > 18",
        );
        const result = enforce(bound, {
            policies: [multiTablePolicy],
            policyContext: { tenantId: "tenant-123" },
        });

        expect(result.ok).toBe(true);
    });

    test("rejects a multi-join query when one scoped join is missing its guard", () => {
        const multiTablePolicy = tenantScopingPolicy({
            tables: ["users", "orders", "internal_projects"],
            scopeColumn: "tenant_id",
            contextKey: "tenantId",
            scopeValueType: "string",
        });
        const bound = bindStatement(
            "SELECT u.id, o.total, p.name FROM users AS u INNER JOIN orders AS o ON o.user_id = u.id AND o.tenant_id = 'tenant-123' LEFT JOIN internal_projects AS p ON p.id = o.id WHERE u.tenant_id = 'tenant-123'",
        );
        const result = enforce(bound, {
            policies: [multiTablePolicy],
            policyContext: { tenantId: "tenant-123" },
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
            DiagnosticCode.PolicyViolation,
        );
        expect(
            result.diagnostics.some((diagnostic) => diagnostic.message.includes("p.tenant_id")),
        ).toBe(true);
    });
});
