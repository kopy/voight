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

describe("emitter literal escaping", () => {
    test("doubles single quotes inside string literals", () => {
        const result = compileStrict("SELECT id FROM users WHERE name = 'O''Brien'");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("'O''Brien'");
    });

    test("escapes backslashes for MySQL-safe output", () => {
        const result = compileStrict("SELECT 'a\\b'");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toBe("SELECT 'a\\\\b'");
    });

    test("escapes trailing backslashes so they cannot consume the closing quote", () => {
        const result = compileStrict("SELECT 'abc\\'");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toBe("SELECT 'abc\\\\'");
    });

    test("keeps comment markers safe when they appear inside string literals", () => {
        const result = compileStrict("SELECT 'test */ -- #'");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toBe("SELECT 'test */ -- #'");
    });

    test("escapes tenant scope values before emitting injected predicates", () => {
        const quoted = compileTenantScoped("SELECT metric FROM timeseries", "tenant'123");
        expect(quoted.ok).toBe(true);
        if (quoted.ok) {
            expect(quoted.emitted?.sql).toContain("'tenant''123'");
        }

        const escaped = compileTenantScoped("SELECT metric FROM timeseries", "tenant\\");
        expect(escaped.ok).toBe(true);
        if (escaped.ok) {
            expect(escaped.emitted?.sql).toContain("'tenant\\\\'");
        }
    });
});

describe("emitter identifier escaping", () => {
    test("re-escapes embedded backticks in aliases", () => {
        const result = compileStrict("SELECT id AS `col``name` FROM users");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("`col``name`");
    });

    test("keeps reserved words quoted when used as aliases", () => {
        for (const word of ["select", "from", "where", "order"]) {
            const result = compileStrict(`SELECT id AS \`${word}\` FROM users`);
            expect(result.ok, `Failed for reserved word: ${word}`).toBe(true);
            if (result.ok) {
                expect(result.emitted?.sql).toContain(`\`${word}\``);
            }
        }
    });

    test("contains semicolons and SQL keywords inside quoted identifiers", () => {
        const result = compileStrict("SELECT id AS `col;DROP TABLE users` FROM users");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("`col;drop table users`");
        expect(result.emitted?.sql).not.toMatch(/`col;`/);
    });

    test("contains line comment markers inside quoted identifiers", () => {
        const result = compileStrict("SELECT id AS `alias -- comment` FROM users");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("`alias -- comment`");
    });
});
