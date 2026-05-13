import { describe, expect, test } from "vitest";

import { compileStrict, compileWithAllowedFunctions } from "../../_support/compile";

describe("parser structural boundaries", () => {
    test("rejects empty clause bodies", () => {
        for (const sql of [
            "SELECT FROM users",
            "SELECT id FROM users WHERE",
            "SELECT id FROM users INNER JOIN orders ON",
            "SELECT id FROM users GROUP BY",
            "SELECT id FROM users ORDER BY",
            "SELECT id FROM users LIMIT",
            "SELECT id FROM users LIMIT 10 OFFSET",
            "SELECT id FROM users WHERE id IN ()",
            "WITH cte AS () SELECT 1",
            "SELECT () FROM users",
            "SELECT",
            "WITH",
        ]) {
            expect(compileStrict(sql).ok, `Expected rejection for ${sql}`).toBe(false);
        }
    });

    test("handles LIMIT and OFFSET grammar consistently", () => {
        expect(compileStrict("SELECT id FROM users OFFSET 10").ok).toBe(false);
        expect(compileStrict("SELECT id FROM users LIMIT 10 OFFSET 5").ok).toBe(true);
        expect(compileStrict("SELECT id FROM users LIMIT 5, 10").ok).toBe(true);
        expect(compileStrict("SELECT id FROM users LIMIT 10 OFFSET -5").ok).toBe(true);
    });

    test("rejects unsupported FROM and derived-table forms", () => {
        expect(compileStrict("SELECT id FROM users FROM orders").ok).toBe(false);
        expect(compileStrict("SELECT id FROM users, orders").ok).toBe(false);
        expect(compileStrict("SELECT * FROM (SELECT 1)").ok).toBe(false);
        expect(compileStrict("SELECT * FROM (SELECT 1) AS").ok).toBe(false);
        expect(
            compileStrict("SELECT id FROM users WHERE id IN (SELECT orders.id FROM orders)").ok,
        ).toBe(true);
    });

    test("rejects invalid clause keywords and incomplete predicates", () => {
        for (const sql of [
            "SELECT id FROM users INNER JOIN orders",
            "SELECT id FROM users LEFT orders ON 1 = 1",
            "SELECT id FROM users GROUP id",
            "SELECT id FROM users ORDER id",
            "SELECT id FROM users WHERE id NOT 1",
            "SELECT id FROM users WHERE id IS 1",
            "SELECT id FROM users WHERE id IS NOT 1",
            "SELECT id FROM users WHERE EXISTS SELECT 1",
            "SELECT id FROM users WHERE NOT EXISTS 1",
            "WITH a AS (SELECT 1) WITH b AS (SELECT 2) SELECT 1",
        ]) {
            expect(compileStrict(sql).ok, `Expected rejection for ${sql}`).toBe(false);
        }
    });

    test("fails unsupported SQL constructs outside the grammar subset", () => {
        expect(
            compileStrict(
                "SELECT SUM(id) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM users",
            ).ok,
        ).toBe(false);
    });

    test("accepts window functions with OVER, PARTITION BY, and ORDER BY", () => {
        expect(compileWithAllowedFunctions("SELECT COUNT(*) OVER () FROM users").ok).toBe(true);
        expect(
            compileWithAllowedFunctions(
                "SELECT SUM(id) OVER (PARTITION BY age ORDER BY created_at DESC) FROM users",
            ).ok,
        ).toBe(true);
    });

    test("accepts LIKE predicates", () => {
        expect(compileStrict("SELECT id FROM users WHERE name LIKE '%test%'").ok).toBe(true);
    });

    test("accepts CASE and CAST forms now covered by the grammar", () => {
        expect(
            compileStrict("SELECT CASE WHEN age > 18 THEN 'adult' ELSE 'minor' END FROM users").ok,
        ).toBe(true);
        expect(
            compileStrict("SELECT CASE age WHEN 18 THEN 'adult' ELSE 'minor' END FROM users").ok,
        ).toBe(true);
        expect(compileStrict("SELECT CAST(age AS DECIMAL(10, 2)) FROM users").ok).toBe(true);
    });

    test("rejects trailing garbage after otherwise valid queries", () => {
        for (const sql of [
            "SELECT 1 FROM users WHERE id = 1 SELECT",
            "SELECT 1; garbage",
            "SELECT 1 +",
            "SELECT (1 + 2",
            "SELECT (1 + 2))",
        ]) {
            expect(compileStrict(sql).ok, `Expected rejection for ${sql}`).toBe(false);
        }
    });
});
