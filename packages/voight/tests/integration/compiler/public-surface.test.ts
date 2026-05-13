import { describe, expect, test } from "vitest";

import { compile, type CompileOptions, type CompileResult } from "../../../src/compiler";
import { InMemoryCatalog, createTableSchema } from "../../../src/catalog";
import { CompilerStage, DiagnosticCode, createDiagnostic } from "../../../src/core/diagnostics";
import {
    allowedFunctionsPolicy,
    maxLimitPolicy,
    type CompilerPolicy,
    tenantScopingPolicy,
} from "../../../src/policies";
import { createTestCatalog } from "../../../src/testing";

const catalog = createTestCatalog();

type StrictCompileOptions = Partial<CompileOptions> & {
    allowedFunctions?: ReadonlySet<string>;
    maxLimit?: number;
    defaultLimit?: number;
};

function compilePublic(sql: string, extra: StrictCompileOptions = {}): CompileResult {
    const policies: CompilerPolicy[] = [...(extra.policies ?? [])];
    if (extra.allowedFunctions) {
        policies.push(allowedFunctionsPolicy({ allowedFunctions: extra.allowedFunctions }));
    }
    if (typeof extra.maxLimit === "number") {
        policies.push(
            maxLimitPolicy({ maxLimit: extra.maxLimit, defaultLimit: extra.defaultLimit }),
        );
    }

    return compile(sql, {
        catalog: extra.catalog ?? catalog,
        policies,
        policyContext: extra.policyContext,
        rewriters: extra.rewriters,
        debug: extra.debug,
    });
}

function compileDebug(sql: string, extra: StrictCompileOptions = {}): CompileResult {
    return compilePublic(sql, { ...extra, debug: true });
}

describe("public compile surface", () => {
    test("surfaces unknown-table failures as public diagnostics", () => {
        const result = compilePublic("SELECT id FROM secret_admin_table");

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Compiler);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownTable);
        expect(result.diagnostics[0]?.message).toBe('Unknown table "secret_admin_table".');
    });

    test("surfaces unknown-column failures as public diagnostics", () => {
        const result = compilePublic("SELECT password_hash FROM users");

        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownColumn);
        expect(result.diagnostics[0]?.message).toBe('Unknown column "password_hash".');
    });

    test("redacts hidden-column diagnostics to the public unknown-column surface", () => {
        const hiddenCatalog = new InMemoryCatalog([
            createTableSchema({
                path: ["users"],
                columns: ["id", { name: "tenant_id", selectable: false }],
            }),
        ]);

        const result = compilePublic("SELECT tenant_id FROM users", {
            catalog: hiddenCatalog,
        });

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Compiler);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownColumn);
        expect(result.diagnostics[0]?.message).toBe(
            "Query references columns that are not available.",
        );
    });

    test("redacts hidden-only wildcard diagnostics to the public unknown-column surface", () => {
        const hiddenCatalog = new InMemoryCatalog([
            createTableSchema({
                path: ["audit_log"],
                columns: [{ name: "tenant_id", selectable: false }],
            }),
        ]);

        const result = compilePublic("SELECT * FROM audit_log", {
            catalog: hiddenCatalog,
        });

        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownColumn);
        expect(result.diagnostics[0]?.message).toBe(
            "Query references columns that are not available.",
        );
    });

    test("keeps public diagnostics but hides stage internals", () => {
        const result = compilePublic("SELECT id FROM users -- comment");

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Compiler);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnsupportedComment);
        expect(result.diagnostics[0]?.message).toBe("Comments are not supported.");
        expect(result.diagnostics[0]?.help).toBeUndefined();
        expect(result.diagnostics[0]?.stage).toBe(CompilerStage.Compiler);
        expect(result.diagnostics[0]?.primarySpan).toEqual({ start: 21, end: 31 });
    });

    test("does not expose ASTs, bound metadata, or stage internals on success", () => {
        const result = compilePublic("SELECT * FROM users");

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe(
            "SELECT `users`.`id`, `users`.`name`, `users`.`email`, `users`.`age`, `users`.`tenant_id`, `users`.`created_at` FROM `users`",
        );
        expect(result.ast).toBeUndefined();
        expect(result.rewrittenAst).toBeUndefined();
        expect(result.bound).toBeUndefined();
        expect(result.stages).toBeUndefined();
    });

    test("surfaces public policy diagnostics and disallowed function names", () => {
        const policyViolation = compilePublic("SELECT id FROM users", {
            policies: [
                {
                    name: "sensitive-policy",
                    enforce: (bound) => [
                        createDiagnostic({
                            code: DiagnosticCode.PolicyViolation,
                            stage: CompilerStage.Enforcer,
                            message: `Policy "sensitive-policy" requires users.tenant_id to be scoped.`,
                            primarySpan: bound.span,
                        }),
                    ],
                },
            ],
        });

        expect(policyViolation.ok).toBe(false);
        expect(policyViolation.diagnostics[0]?.code).toBe(DiagnosticCode.PolicyViolation);
        expect(policyViolation.diagnostics[0]?.message).toBe(
            'Policy "sensitive-policy" requires users.tenant_id to be scoped.',
        );

        const functionViolation = compilePublic("SELECT SLEEP(10) FROM users", {
            allowedFunctions: new Set(["count"]),
        });
        expect(functionViolation.ok).toBe(false);
        expect(functionViolation.diagnostics[0]?.code).toBe(DiagnosticCode.DisallowedFunction);
        expect(functionViolation.diagnostics[0]?.message).toBe('Function "sleep" is not allowed.');
    });

    test("redacts internal invariant failures from the public surface", () => {
        const result = compilePublic("SELECT 1", {
            rewriters: [
                {
                    rewrite: () => {
                        throw new Error("boom");
                    },
                },
            ],
        });

        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.InternalCompilerError);
        expect(result.diagnostics[0]?.message).toBe(
            "Query could not be compiled because of an internal compiler error.",
        );
    });

    test("redacts tenant scoping details while keeping the policy failure public", () => {
        const result = compilePublic(
            "WITH timeseries AS (SELECT id, name AS metric, 'tenant-A' AS tenant_id FROM users) SELECT metric FROM timeseries",
            {
                policies: [
                    tenantScopingPolicy({
                        tables: ["timeseries"],
                        scopeColumn: "tenant_id",
                        contextKey: "tenantId",
                        scopeValueType: "string",
                    }),
                ],
                policyContext: { tenantId: "tenant-A" },
            },
        );

        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.PolicyViolation);
        expect(result.diagnostics[0]?.message).toBe("Query violates tenant scoping requirements.");
    });
});

describe("debug compile surface", () => {
    test("preserves detailed diagnostics when explicitly requested", () => {
        const result = compileDebug("SELECT id FROM missing");

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Binder);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.UnknownTable);
        expect(result.diagnostics[0]?.message).toContain("missing");
    });

    test("preserves non-selectable details when explicitly requested", () => {
        const hiddenCatalog = new InMemoryCatalog([
            createTableSchema({
                path: ["users"],
                columns: ["id", { name: "tenant_id", selectable: false }],
            }),
        ]);

        const result = compileDebug("SELECT tenant_id FROM users", {
            catalog: hiddenCatalog,
        });

        expect(result.ok).toBe(false);
        expect(result.terminalStage).toBe(CompilerStage.Binder);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
        expect(result.diagnostics[0]?.message).toBe('Column "tenant_id" is not selectable.');
    });

    test("preserves internal artifacts when explicitly requested", () => {
        const result = compileDebug("SELECT id, email FROM users");

        expect(result.ok).toBe(true);
        expect(result.bound?.body.from?.table.name).toBe("users");
        expect(result.ast?.kind).toBe("Query");
        expect(result.stages?.bind?.stage).toBe(CompilerStage.Binder);
    });
});
