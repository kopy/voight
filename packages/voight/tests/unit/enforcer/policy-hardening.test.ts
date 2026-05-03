import { describe, expect, test } from "vitest";

import {
    AliasCatalog,
    InMemoryCatalog,
    createCatalogAlias,
    createTableSchema,
} from "../../../src/catalog";
import { compile } from "../../../src/compiler";
import { DiagnosticCode } from "../../../src/core/diagnostics";
import {
    allowedFunctionsPolicy,
    maxLimitPolicy,
    PolicyConfigurationError,
    supportedOperatorsPolicy,
    tenantScopingPolicy,
} from "../../../src/policies";
import { createTestCatalog } from "../../../src/testing";

function injectUnsupportedOperator<T>(query: T): T {
    const typedQuery = query as {
        body: {
            where?: {
                kind: string;
            };
        };
    };

    if (typedQuery.body.where?.kind !== "BinaryExpression") {
        return query;
    }

    return {
        ...typedQuery,
        body: {
            ...typedQuery.body,
            where: {
                ...typedQuery.body.where,
                operator: "ILIKE",
            },
        },
    } as unknown as T;
}

describe("allowedFunctionsPolicy hardening", () => {
    test("blocks disallowed functions inside nested subqueries", () => {
        // The allowlist must recurse into inner queries, otherwise attackers can hide
        // side-effecting or expensive calls behind a subquery boundary.
        const result = compile(
            "SELECT id FROM users WHERE id IN (SELECT user_id FROM orders WHERE SLEEP(1) = 0 LIMIT 1)",
            {
                catalog: createTestCatalog(),
                policies: [allowedFunctionsPolicy({ allowedFunctions: new Set(["count"]) })],
                debug: true,
            },
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
                DiagnosticCode.DisallowedFunction,
            );
        }
    });

    test("CURRENT_* keywords are enforced by the function allowlist", () => {
        // CURRENT_* now counts as function-like policy surface, so an empty allowlist
        // must block it just like any other callable construct.
        const result = compile("SELECT CURRENT_TIME", {
            catalog: createTestCatalog(),
            policies: [allowedFunctionsPolicy({ allowedFunctions: new Set() })],
            debug: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.DisallowedFunction);
        }
    });
});

describe("maxLimitPolicy abuse probes", () => {
    test("leaves OFFSET unbounded when maxOffset is not configured", () => {
        // maxOffset is intentionally optional. This boundary test documents that
        // callers only get OFFSET enforcement when they opt into it explicitly.
        const result = compile("SELECT id FROM users LIMIT 1 OFFSET 1000000000", {
            catalog: createTestCatalog(),
            policies: [maxLimitPolicy({ maxLimit: 100 })],
            debug: true,
        });

        // This currently passes: count is capped, but OFFSET is only checked for const-ness.
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe(
            "SELECT `users`.`id` FROM `users` LIMIT 1 OFFSET 1000000000",
        );
    });

    test("rejects nested OFFSET values above the configured maximum", () => {
        const result = compile(
            "SELECT id FROM users WHERE id IN (SELECT user_id FROM orders LIMIT 1 OFFSET 999999999) LIMIT 1",
            {
                catalog: createTestCatalog(),
                policies: [maxLimitPolicy({ maxLimit: 100, maxOffset: 1000 })],
                debug: true,
            },
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.LimitExceeded);
        }
    });

    test("rejects non-literal outer OFFSET expressions when maxOffset is configured", () => {
        const result = compile("SELECT id FROM users LIMIT 1 OFFSET 500 + 500", {
            catalog: createTestCatalog(),
            policies: [maxLimitPolicy({ maxLimit: 100, maxOffset: 1000 })],
            debug: true,
        });

        expect(result.ok).toBe(false);
    });

    test("rejects defaultLimit values above the configured maxLimit", () => {
        expect(() =>
            maxLimitPolicy({
                maxLimit: 100,
                defaultLimit: 101,
            }),
        ).toThrow(PolicyConfigurationError);
    });
});

describe("supportedOperatorsPolicy hardening", () => {
    test("blocks unsupported operators when the policy is configured explicitly", () => {
        // Hostile rewriters are now rejected before bind/enforce, so malformed operators
        // fail at rewrite time instead of reaching the operator policy.
        const result = compile("SELECT id FROM users WHERE id = 1", {
            catalog: createTestCatalog(),
            policies: [supportedOperatorsPolicy()],
            rewriters: [
                {
                    rewrite: injectUnsupportedOperator,
                },
            ],
            debug: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.RewriteInvariantViolation);
        }
    });

    test("unsupported operators are rejected even without an explicit operator policy", () => {
        // Rewrite validation is now the first boundary for malformed operator injection.
        const result = compile("SELECT id FROM users WHERE id = 1", {
            catalog: createTestCatalog(),
            rewriters: [
                {
                    rewrite: injectUnsupportedOperator,
                },
            ],
            debug: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.RewriteInvariantViolation);
        }
    });
});

describe("tenantScopingPolicy boundaries", () => {
    const policy = tenantScopingPolicy({
        tables: ["timeseries"],
        scopeColumn: "tenant_id",
        contextKey: "tenantId",
    });

    test("enforcement rejects semantically equivalent but non-canonical tenant predicates", () => {
        // Enforcement is intentionally syntactic. This query is logically scoped, but
        // only the rewrite-injected canonical predicate should satisfy the policy.
        const result = compile(
            "SELECT metric FROM timeseries WHERE NOT (tenant_id != 'tenant-123')",
            {
                catalog: createTestCatalog(),
                policies: [policy],
                policyContext: { tenantId: "tenant-123" },
                debug: true,
            },
        );

        // Boundary: enforcement is syntactic and only recognizes direct = / IS NULL predicates.
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain(
            "WHERE NOT (`timeseries`.`tenant_id` != 'tenant-123') AND `timeseries`.`tenant_id` = 'tenant-123'",
        );
    });

    test("direct enforcement of the same predicate fails closed", () => {
        // The same predicate should fail when rewrite is removed from the path. This
        // makes the enforcement boundary explicit instead of relying on inference.
        const result = compile(
            "SELECT metric FROM timeseries WHERE NOT (tenant_id != 'tenant-123')",
            {
                catalog: createTestCatalog(),
                debug: true,
            },
        );

        expect(result.ok).toBe(true);
        if (!result.ok || !result.bound) {
            return;
        }

        const enforced = tenantScopingPolicy({
            tables: ["timeseries"],
            scopeColumn: "tenant_id",
            contextKey: "tenantId",
        }).enforce?.(result.bound, {
            context: { tenantId: "tenant-123" },
        });

        expect(enforced?.[0]?.code).toBe(DiagnosticCode.PolicyViolation);
    });

    test("null scoping also uses a narrow canonical boundary", () => {
        // Null scoping has the same syntactic boundary: only a direct IS NULL guard is
        // recognized, so rewrite must inject the canonical form.
        const result = compile("SELECT metric FROM timeseries WHERE NOT (tenant_id IS NOT NULL)", {
            catalog: createTestCatalog(),
            policies: [policy],
            policyContext: { tenantId: null },
            debug: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toContain(
            "WHERE NOT (`timeseries`.`tenant_id` IS NOT NULL) AND `timeseries`.`tenant_id` IS NULL",
        );
    });

    test("rejects duplicate table assignments across explicit scope rules", () => {
        expect(() =>
            tenantScopingPolicy({
                scopes: [
                    {
                        tables: ["users"],
                        scopeColumn: "tenant_id",
                        contextKey: "tenantId",
                    },
                    {
                        tables: ["users"],
                        scopeColumn: "workspace_id",
                        contextKey: "workspaceId",
                    },
                ],
            }),
        ).toThrow(PolicyConfigurationError);
    });

    test("rejects quoted table names that would silently disable scoping", () => {
        expect(() =>
            tenantScopingPolicy({
                tables: ["`users`"],
                scopeColumn: "tenant_id",
                contextKey: "tenantId",
            }),
        ).toThrow(PolicyConfigurationError);
    });

    test("rejects invalid tenant scope column identifiers", () => {
        expect(() =>
            tenantScopingPolicy({
                tables: ["users"],
                scopeColumn: "tenant-id",
                contextKey: "tenantId",
            }),
        ).toThrow(PolicyConfigurationError);
    });

    test("fails closed when one table matches more than one scope rule via schema aliases", () => {
        const catalog = new InMemoryCatalog([
            createTableSchema({
                path: ["analytics", "users"],
                columns: ["id", "tenant_id", "workspace_id"],
            }),
        ]);

        const result = compile("SELECT id FROM analytics.users", {
            catalog,
            policies: [
                tenantScopingPolicy({
                    scopes: [
                        {
                            tables: ["users"],
                            scopeColumn: "tenant_id",
                            contextKey: "tenantId",
                        },
                        {
                            tables: ["analytics.users"],
                            scopeColumn: "workspace_id",
                            contextKey: "workspaceId",
                        },
                    ],
                }),
            ],
            policyContext: {
                tenantId: "tenant-123",
                workspaceId: "workspace-123",
            },
            debug: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.InvalidPolicyConfiguration);
        }
    });

    test("fails closed when alias and physical names overlap across scope rules", () => {
        const catalog = new AliasCatalog(
            new InMemoryCatalog([
                createTableSchema({
                    path: ["internal_projects"],
                    columns: ["id", "tenant_id", "workspace_id"],
                }),
            ]),
            [
                createCatalogAlias({
                    from: ["projects"],
                    to: ["internal_projects"],
                }),
            ],
        );

        const result = compile("SELECT id FROM projects", {
            catalog,
            policies: [
                tenantScopingPolicy({
                    scopes: [
                        {
                            tables: ["projects"],
                            scopeColumn: "tenant_id",
                            contextKey: "tenantId",
                        },
                        {
                            tables: ["internal_projects"],
                            scopeColumn: "workspace_id",
                            contextKey: "workspaceId",
                        },
                    ],
                }),
            ],
            policyContext: {
                tenantId: "tenant-123",
                workspaceId: "workspace-123",
            },
            debug: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.InvalidPolicyConfiguration);
        }
    });

    test("rejects bigint tenant values at zero", () => {
        const result = compile("SELECT metric FROM timeseries", {
            catalog: createTestCatalog(),
            policies: [policy],
            policyContext: { tenantId: 0n },
            debug: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.PolicyExecutionError);
            expect(result.diagnostics[0]?.message).toContain("positive integers within uint64");
        }
    });

    test("rejects negative bigint tenant values", () => {
        const result = compile("SELECT metric FROM timeseries", {
            catalog: createTestCatalog(),
            policies: [policy],
            policyContext: { tenantId: -1n },
            debug: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.PolicyExecutionError);
            expect(result.diagnostics[0]?.message).toContain("positive integers within uint64");
        }
    });

    test("rejects bigint tenant values above uint64", () => {
        const result = compile("SELECT metric FROM timeseries", {
            catalog: createTestCatalog(),
            policies: [policy],
            policyContext: { tenantId: 18446744073709551616n },
            debug: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.PolicyExecutionError);
            expect(result.diagnostics[0]?.message).toContain("positive integers within uint64");
        }
    });

    test("rejects unsafe integer number tenant values that should be bigint", () => {
        const result = compile("SELECT metric FROM timeseries", {
            catalog: createTestCatalog(),
            policies: [policy],
            policyContext: { tenantId: Number.MAX_SAFE_INTEGER + 1 },
            debug: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.PolicyExecutionError);
            expect(result.diagnostics[0]?.message).toContain("passed as bigint");
        }
    });

    test("rejects non-finite numeric tenant values", () => {
        const cases = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

        for (const tenantId of cases) {
            const result = compile("SELECT metric FROM timeseries", {
                catalog: createTestCatalog(),
                policies: [policy],
                policyContext: { tenantId },
                debug: true,
            });

            expect(result.ok, `Unexpected success for ${String(tenantId)}`).toBe(false);
            if (!result.ok) {
                expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.PolicyExecutionError);
                expect(result.diagnostics[0]?.message).toContain("to be finite");
            }
        }
    });
});
