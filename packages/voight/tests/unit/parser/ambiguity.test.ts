import { describe, expect, test } from "vitest";

import { compileStrict, compileWithAllowedFunctions } from "../../_support/compile";

describe("parser ambiguity boundaries", () => {
    test("treats a trailing identifier as an implicit alias", () => {
        const result = compileStrict("SELECT id name FROM users");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("AS `name`");
    });

    test("distinguishes bare identifiers from function calls", () => {
        expect(compileStrict("SELECT count FROM users").ok).toBe(false);
        expect(
            compileWithAllowedFunctions("SELECT count() FROM users", new Set(["count"])).ok,
        ).toBe(true);
    });

    test("keeps qualified references distinct from aliases", () => {
        const result = compileStrict("SELECT u.id FROM users AS u");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("`u`.`id`");
    });

    test("does not consume keywords as implicit aliases", () => {
        expect(compileStrict("SELECT id order FROM users").ok).toBe(false);
        expect(compileStrict("SELECT id FROM users").ok).toBe(true);
    });

    test("allows interval-unit keywords as identifiers and implicit aliases", () => {
        const implicitAlias = compileStrict("SELECT created_at day FROM orders");
        expect(implicitAlias.ok).toBe(true);
        if (implicitAlias.ok) {
            expect(implicitAlias.emitted?.sql).toContain("AS `day`");
        }

        const downstreamReference = compileStrict(
            "WITH daily AS (SELECT created_at AS day FROM orders) SELECT day FROM daily ORDER BY day",
        );
        expect(downstreamReference.ok).toBe(true);
        if (downstreamReference.ok) {
            expect(downstreamReference.emitted?.sql).toContain("SELECT `daily`.`day` FROM `daily`");
            expect(downstreamReference.emitted?.sql).toContain("ORDER BY `daily`.`day` ASC");
        }
    });

    test("distinguishes wildcard projection from multiplication", () => {
        expect(compileStrict("SELECT 1 * 2").ok).toBe(true);
        expect(compileStrict("SELECT * FROM users").ok).toBe(true);
        expect(compileStrict("SELECT 1, * FROM users").ok).toBe(true);
        expect(compileStrict("SELECT id * FROM users").ok).toBe(false);
    });

    test("allows parameters in expression positions but not as table names", () => {
        expect(compileStrict("SELECT ? FROM users").ok).toBe(true);
        expect(compileStrict("SELECT id FROM users LIMIT ? OFFSET ?").ok).toBe(true);
        expect(compileStrict("SELECT id FROM ?").ok).toBe(false);
    });

    test("treats trailing identifiers after projection-only queries as aliases", () => {
        const result = compileStrict("SELECT 1 garbage");
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.emitted?.sql).toContain("AS `garbage`");
    });
});
