import { describe, expect, test } from "vitest";

import { InMemoryCatalog, createTableSchema } from "../../../src/catalog";
import { compile } from "../../../src/compiler";
import { DiagnosticCode } from "../../../src/core/diagnostics";
import { allowedFunctionsPolicy, tenantScopingPolicy } from "../../../src/policies";

const catalog = new InMemoryCatalog([
    createTableSchema({
        path: ["users"],
        columns: ["id", "name", { name: "tenant_id", selectable: false }],
    }),
    createTableSchema({
        path: ["orders"],
        columns: ["id", "user_id", "total", { name: "tenant_id", selectable: false }],
    }),
    createTableSchema({
        path: ["audit_log"],
        columns: [{ name: "tenant_id", selectable: false }],
    }),
]);

const tenantPolicy = tenantScopingPolicy({
    tables: ["users", "orders"],
    scopeColumn: "tenant_id",
    contextKey: "tenantId",
    scopeValueType: "string",
});

function compileScoped(sql: string) {
    return compile(sql, {
        catalog,
        policies: [tenantPolicy],
        policyContext: { tenantId: "123" },
        debug: true,
    });
}

describe("FIXED: wildcard projection respects catalog selectability", () => {
    test("unqualified wildcard expands to selectable catalog columns before tenant scoping", () => {
        const result = compileScoped("SELECT * FROM users");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe(
            "SELECT `users`.`id`, `users`.`name` FROM `users` WHERE `users`.`tenant_id` = '123'",
        );
    });

    test("qualified wildcard expands to selectable catalog columns before tenant scoping", () => {
        const result = compileScoped("SELECT u.* FROM users AS u");
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe(
            "SELECT `u`.`id`, `u`.`name` FROM `users` AS `u` WHERE `u`.`tenant_id` = '123'",
        );
    });

    test("joined wildcards never reintroduce hidden tenant columns into the projection", () => {
        const result = compileScoped(
            "SELECT u.*, o.* FROM users AS u INNER JOIN orders AS o ON o.user_id = u.id",
        );
        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe(
            "SELECT `u`.`id`, `u`.`name`, `o`.`id`, `o`.`user_id`, `o`.`total` FROM `users` AS `u` INNER JOIN `orders` AS `o` ON `o`.`user_id` = `u`.`id` AND `o`.`tenant_id` = '123' WHERE `u`.`tenant_id` = '123'",
        );
    });

    test("direct projection of a hidden tenant column fails closed", () => {
        const result = compileScoped("SELECT tenant_id FROM users");
        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
    });

    test("expression projection that references a hidden tenant column fails closed", () => {
        const result = compileScoped("SELECT COALESCE(tenant_id, 'missing') FROM users");
        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
    });

    test("hidden columns are rejected in WHERE clauses too", () => {
        const result = compileScoped("SELECT id FROM users WHERE tenant_id = '123'");
        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
    });

    test("hidden columns are rejected in REGEXP predicates", () => {
        const operand = compileScoped("SELECT id FROM users WHERE tenant_id REGEXP '^123$'");
        expect(operand.ok).toBe(false);
        expect(operand.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);

        const pattern = compileScoped("SELECT id FROM users WHERE name REGEXP tenant_id");
        expect(pattern.ok).toBe(false);
        expect(pattern.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
    });

    test("hidden columns are rejected in BETWEEN predicates", () => {
        const operand = compileScoped("SELECT id FROM users WHERE tenant_id BETWEEN 'a' AND 'z'");
        expect(operand.ok).toBe(false);
        expect(operand.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);

        const lower = compileScoped("SELECT id FROM users WHERE id BETWEEN tenant_id AND 'z'");
        expect(lower.ok).toBe(false);
        expect(lower.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);

        const upper = compileScoped("SELECT id FROM users WHERE id BETWEEN 'a' AND tenant_id");
        expect(upper.ok).toBe(false);
        expect(upper.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
    });

    test("hidden columns are rejected in ORDER BY clauses too", () => {
        const result = compileScoped("SELECT id FROM users ORDER BY tenant_id");
        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
    });

    test("hidden columns are rejected in GROUP BY and HAVING clauses too", () => {
        const result = compileScoped(
            "SELECT id FROM users GROUP BY tenant_id HAVING tenant_id = '123'",
        );
        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
    });

    test("hidden columns are rejected in JOIN predicates too", () => {
        const result = compileScoped(
            "SELECT u.id FROM users AS u INNER JOIN orders AS o ON o.tenant_id = u.tenant_id",
        );
        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
    });

    test("wildcards fail closed when a table exposes no selectable columns", () => {
        const result = compile("SELECT * FROM audit_log", {
            catalog,
            debug: true,
        });

        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.NonSelectableColumn);
    });

    test("hidden-only tables still permit COUNT(*) because no hidden columns are projected", () => {
        const result = compile("SELECT COUNT(*) AS row_count FROM audit_log", {
            catalog,
            policies: [allowedFunctionsPolicy({ allowedFunctions: new Set(["count"]) })],
            debug: true,
        });

        expect(result.ok).toBe(true);
        expect(result.emitted?.sql).toBe("SELECT count(*) AS `row_count` FROM `audit_log`");
    });
});
