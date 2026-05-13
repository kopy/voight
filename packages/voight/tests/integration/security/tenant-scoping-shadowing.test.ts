import { describe, expect, test } from "vitest";

import { AliasCatalog, createCatalogAlias } from "../../../src/catalog";
import { compile } from "../../../src/compiler";
import { DiagnosticCode } from "../../../src/core/diagnostics";
import { tenantScopingPolicy } from "../../../src/policies";
import { createTestCatalog } from "../../../src/testing";

describe("tenant scoping security probes", () => {
    test("scopes catalog aliases when the logical table name is configured", () => {
        const aliasCatalog = new AliasCatalog(createTestCatalog(), [
            createCatalogAlias({
                from: ["projects"],
                to: ["internal_projects"],
            }),
        ]);

        const result = compile("SELECT id, name FROM projects", {
            catalog: aliasCatalog,
            policies: [
                tenantScopingPolicy({
                    tables: ["projects"],
                    scopeColumn: "tenant_id",
                    contextKey: "tenantId",
                    scopeValueType: "string",
                }),
            ],
            policyContext: { tenantId: "tenant-123" },
            debug: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe(
            "SELECT `projects`.`id`, `projects`.`name` FROM `internal_projects` AS `projects` WHERE `projects`.`tenant_id` = 'tenant-123'",
        );
    });

    test("scopes catalog aliases when only the physical table name is configured", () => {
        const aliasCatalog = new AliasCatalog(createTestCatalog(), [
            createCatalogAlias({
                from: ["projects"],
                to: ["internal_projects"],
            }),
        ]);

        const result = compile("SELECT id, name FROM projects", {
            catalog: aliasCatalog,
            policies: [
                tenantScopingPolicy({
                    tables: ["internal_projects"],
                    scopeColumn: "tenant_id",
                    contextKey: "tenantId",
                    scopeValueType: "string",
                }),
            ],
            policyContext: { tenantId: "tenant-123" },
            debug: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe(
            "SELECT `projects`.`id`, `projects`.`name` FROM `internal_projects` AS `projects` WHERE `projects`.`tenant_id` = 'tenant-123'",
        );
    });

    test("scopes direct physical access when the logical alias is configured", () => {
        const aliasCatalog = new AliasCatalog(createTestCatalog(), [
            createCatalogAlias({
                from: ["projects"],
                to: ["internal_projects"],
            }),
        ]);

        const result = compile(
            "SELECT id, name FROM internal_projects WHERE tenant_id = 'tenant-999'",
            {
                catalog: aliasCatalog,
                policies: [
                    tenantScopingPolicy({
                        tables: ["projects"],
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
        expect(result.emitted?.sql).toBe(
            "SELECT `internal_projects`.`id`, `internal_projects`.`name` FROM `internal_projects` WHERE `internal_projects`.`tenant_id` = 'tenant-999' AND `internal_projects`.`tenant_id` = 'tenant-123'",
        );
    });

    test("fails closed for derived-table shadowing of a scoped table name", () => {
        const result = compile(
            "SELECT metric FROM (SELECT id, name AS metric, 'tenant-123' AS tenant_id FROM users) AS timeseries",
            {
                catalog: createTestCatalog(),
                policies: [
                    tenantScopingPolicy({
                        tables: ["timeseries"],
                        scopeColumn: "tenant_id",
                        contextKey: "tenantId",
                        scopeValueType: "string",
                    }),
                ],
                policyContext: { tenantId: "tenant-123" },
                debug: true,
            },
        );

        expect(result.ok).toBe(false);
    });

    test("does not treat an unrelated table alias as the scoped table identity", () => {
        const result = compile("SELECT id FROM orders AS users", {
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
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe("SELECT `users`.`id` FROM `orders` AS `users`");
    });
});

describe("tenant scoping vulnerability probes", () => {
    test("rejects CTE shadowing of a scoped table name before SQL is emitted", () => {
        // CTEs can spoof both schema and tenant columns, so the compiler must fail
        // closed before SQL emission even though the failure now surfaces as a diagnostic.
        const result = compile(
            "WITH timeseries AS (SELECT id, name AS metric, 'tenant-A' AS tenant_id FROM users) SELECT metric FROM timeseries",
            {
                catalog: createTestCatalog(),
                policies: [
                    tenantScopingPolicy({
                        tables: ["timeseries"],
                        scopeColumn: "tenant_id",
                        contextKey: "tenantId",
                        scopeValueType: "string",
                    }),
                ],
                policyContext: { tenantId: "tenant-A" },
                debug: true,
            },
        );

        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.PolicyViolation);
    });

    test("rejects CTE reference aliases that shadow a scoped table name", () => {
        const result = compile(
            "WITH planted AS (SELECT id, name AS metric, 'tenant-A' AS tenant_id FROM users) SELECT metric FROM planted AS timeseries",
            {
                catalog: createTestCatalog(),
                policies: [
                    tenantScopingPolicy({
                        tables: ["timeseries"],
                        scopeColumn: "tenant_id",
                        contextKey: "tenantId",
                        scopeValueType: "string",
                    }),
                ],
                policyContext: { tenantId: "tenant-A" },
                debug: true,
            },
        );

        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.PolicyViolation);
    });
});
