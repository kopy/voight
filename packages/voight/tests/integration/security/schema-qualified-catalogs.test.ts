import { describe, expect, test } from "vitest";

import {
    AliasCatalog,
    InMemoryCatalog,
    createCatalogAlias,
    createTableSchema,
} from "../../../src/catalog";
import { DiagnosticCode } from "../../../src/core/diagnostics";
import { tenantScopingPolicy } from "../../../src/policies";
import { compileStrict } from "../../_support/compile";

const catalog = new InMemoryCatalog([
    createTableSchema({
        path: ["tracking", "time_series_stats"],
        columns: ["id", "tenant_id", "metric"],
    }),
]);

describe("schema-qualified catalogs", () => {
    test("rejects unqualified access to schema-qualified tables", () => {
        const result = compileStrict("SELECT id FROM time_series_stats", { catalog });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownTable);
        }
    });

    test("does not resolve a quoted dotted identifier as a schema-qualified path", () => {
        const result = compileStrict("SELECT metric FROM `tracking.time_series_stats`", {
            catalog,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownTable);
        }
    });

    test("emits schema-qualified tables and scopes them when the policy uses the full name", () => {
        const result = compileStrict("SELECT ts.metric FROM tracking.time_series_stats AS ts", {
            catalog,
            policies: [
                tenantScopingPolicy({
                    tables: ["tracking.time_series_stats"],
                    scopeColumn: "tenant_id",
                    contextKey: "tenantId",
                }),
            ],
            policyContext: {
                tenantId: "tenant-123",
            },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("FROM `tracking`.`time_series_stats` AS `ts`");
        expect(result.emitted?.sql).toContain("`ts`.`tenant_id` = 'tenant-123'");
    });

    test("fails closed when a schema-qualified table is scoped by short name only", () => {
        const result = compileStrict("SELECT ts.metric FROM tracking.time_series_stats AS ts", {
            catalog,
            policies: [
                tenantScopingPolicy({
                    tables: ["time_series_stats"],
                    scopeColumn: "tenant_id",
                    contextKey: "tenantId",
                }),
            ],
            policyContext: {
                tenantId: "tenant-123",
            },
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(
                result.diagnostics.some(
                    (diagnostic) =>
                        diagnostic.code === DiagnosticCode.InvalidPolicyConfiguration &&
                        diagnostic.message.includes("tracking.time_series_stats"),
                ),
            ).toBe(true);
        }
    });

    test("fails closed when a logical alias targets a schema-qualified table scoped by short physical name", () => {
        const aliasCatalog = new AliasCatalog(catalog, [
            createCatalogAlias({
                from: ["public_stats"],
                to: ["tracking", "time_series_stats"],
            }),
        ]);

        const result = compileStrict("SELECT metric FROM public_stats", {
            catalog: aliasCatalog,
            policies: [
                tenantScopingPolicy({
                    tables: ["time_series_stats"],
                    scopeColumn: "tenant_id",
                    contextKey: "tenantId",
                }),
            ],
            policyContext: {
                tenantId: "tenant-123",
            },
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(
                result.diagnostics.some(
                    (diagnostic) =>
                        diagnostic.code === DiagnosticCode.InvalidPolicyConfiguration &&
                        diagnostic.message.includes("tracking.time_series_stats"),
                ),
            ).toBe(true);
        }
    });

    test("scopes a logical alias to a schema-qualified table when the logical alias is configured", () => {
        const aliasCatalog = new AliasCatalog(catalog, [
            createCatalogAlias({
                from: ["public_stats"],
                to: ["tracking", "time_series_stats"],
            }),
        ]);

        const result = compileStrict("SELECT metric FROM public_stats", {
            catalog: aliasCatalog,
            policies: [
                tenantScopingPolicy({
                    tables: ["public_stats"],
                    scopeColumn: "tenant_id",
                    contextKey: "tenantId",
                }),
            ],
            policyContext: {
                tenantId: "tenant-123",
            },
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.emitted?.sql).toContain(
                "FROM `tracking`.`time_series_stats` AS `public_stats`",
            );
            expect(result.emitted?.sql).toContain("`public_stats`.`tenant_id` = 'tenant-123'");
        }
    });

    test("scopes direct physical access when the schema-qualified table is protected by logical alias", () => {
        const aliasCatalog = new AliasCatalog(catalog, [
            createCatalogAlias({
                from: ["public_stats"],
                to: ["tracking", "time_series_stats"],
            }),
        ]);

        const result = compileStrict(
            "SELECT metric FROM tracking.time_series_stats WHERE tenant_id = 'tenant-999'",
            {
                catalog: aliasCatalog,
                policies: [
                    tenantScopingPolicy({
                        tables: ["public_stats"],
                        scopeColumn: "tenant_id",
                        contextKey: "tenantId",
                    }),
                ],
                policyContext: {
                    tenantId: "tenant-123",
                },
            },
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.emitted?.sql).toContain("FROM `tracking`.`time_series_stats` WHERE");
            expect(result.emitted?.sql).toContain("`time_series_stats`.`tenant_id` = 'tenant-123'");
        }
    });
});
