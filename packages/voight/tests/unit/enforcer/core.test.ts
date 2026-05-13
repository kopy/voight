import { describe, expect, test } from "vitest";

import { DiagnosticCode } from "../../../src/core/diagnostics";
import { enforce } from "../../../src/compiler/enforcer";
import { allowedFunctionsPolicy, maxLimitPolicy } from "../../../src/policies";
import { bindStatement } from "../../_support/bind";

describe("enforce", () => {
    test("denies functions by default when no function policy is configured", () => {
        const bound = bindStatement("SELECT SLEEP(10) FROM users");
        const result = enforce(bound);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.DisallowedFunction);
        }
    });

    test("allows function-free queries with no configured policies", () => {
        const bound = bindStatement("SELECT id FROM users");
        const result = enforce(bound);

        expect(result.ok).toBe(true);
    });

    test("rejects disallowed functions", () => {
        const bound = bindStatement("SELECT SUM(total) FROM orders");
        const result = enforce(bound, {
            policies: [allowedFunctionsPolicy({ allowedFunctions: new Set(["count"]) })],
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.DisallowedFunction);
    });

    test("rejects excessive limits", () => {
        const bound = bindStatement("SELECT id FROM users LIMIT 999");
        const result = enforce(bound, {
            policies: [maxLimitPolicy({ maxLimit: 100 })],
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.LimitExceeded);
    });

    test("requires a constant LIMIT clause when maxLimit is configured", () => {
        const bound = bindStatement("SELECT id FROM users");
        const result = enforce(bound, {
            policies: [maxLimitPolicy({ maxLimit: 100 })],
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }

        expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.LimitExceeded);
        expect(result.diagnostics[0]?.message).toContain("constant LIMIT clause is required");
    });

    test("accepts bare integer LIMIT literals", () => {
        const accepted = enforce(bindStatement("SELECT id FROM users LIMIT 100"), {
            policies: [maxLimitPolicy({ maxLimit: 100 })],
        });
        expect(accepted.ok).toBe(true);
    });

    test("rejects non-literal LIMIT expressions even when constant", () => {
        const arithmetic = enforce(bindStatement("SELECT id FROM users LIMIT 50 + 50"), {
            policies: [maxLimitPolicy({ maxLimit: 100 })],
        });
        expect(arithmetic.ok).toBe(false);

        const grouped = enforce(bindStatement("SELECT id FROM users LIMIT (100)"), {
            policies: [maxLimitPolicy({ maxLimit: 100 })],
        });
        expect(grouped.ok).toBe(false);
    });

    test("accepts bare integer OFFSET literals", () => {
        const accepted = enforce(bindStatement("SELECT id FROM users LIMIT 10 OFFSET 100"), {
            policies: [maxLimitPolicy({ maxLimit: 100, maxOffset: 100 })],
        });
        expect(accepted.ok).toBe(true);
    });

    test("rejects non-literal OFFSET expressions even when constant", () => {
        const arithmetic = enforce(bindStatement("SELECT id FROM users LIMIT 10 OFFSET 50 + 50"), {
            policies: [maxLimitPolicy({ maxLimit: 100, maxOffset: 100 })],
        });
        expect(arithmetic.ok).toBe(false);

        const grouped = enforce(bindStatement("SELECT id FROM users LIMIT 10 OFFSET (100)"), {
            policies: [maxLimitPolicy({ maxLimit: 100, maxOffset: 100 })],
        });
        expect(grouped.ok).toBe(false);
    });

    test("rejects dynamic or non-constant LIMIT expressions", () => {
        const parameterLimit = enforce(bindStatement("SELECT id FROM users LIMIT ?"), {
            policies: [maxLimitPolicy({ maxLimit: 100 })],
        });
        expect(parameterLimit.ok).toBe(false);

        const functionLimit = enforce(bindStatement("SELECT id FROM users LIMIT ABS(-200)"), {
            policies: [
                allowedFunctionsPolicy({ allowedFunctions: new Set(["abs"]) }),
                maxLimitPolicy({ maxLimit: 100 }),
            ],
        });
        expect(functionLimit.ok).toBe(false);
    });

    test("rejects negative LIMIT and OFFSET expressions", () => {
        const negativeLimit = enforce(bindStatement("SELECT id FROM users LIMIT -1"), {
            policies: [maxLimitPolicy({ maxLimit: 100 })],
        });
        expect(negativeLimit.ok).toBe(false);

        const negativeOffset = enforce(bindStatement("SELECT id FROM users LIMIT 1 OFFSET -1"), {
            policies: [maxLimitPolicy({ maxLimit: 100, maxOffset: 100 })],
        });
        expect(negativeOffset.ok).toBe(false);
    });

    test("enforces comma-form LIMIT count and offset positions", () => {
        const excessiveOffset = enforce(bindStatement("SELECT id FROM users LIMIT 1000, 1"), {
            policies: [maxLimitPolicy({ maxLimit: 100, maxOffset: 100 })],
        });
        expect(excessiveOffset.ok).toBe(false);

        const excessiveCount = enforce(bindStatement("SELECT id FROM users LIMIT 1, 1000"), {
            policies: [maxLimitPolicy({ maxLimit: 100, maxOffset: 100 })],
        });
        expect(excessiveCount.ok).toBe(false);
    });

    test("does not require nested subqueries to carry their own limit by default", () => {
        const bound = bindStatement(
            "SELECT users.id FROM users WHERE users.id IN (SELECT orders.id FROM orders) LIMIT 10",
        );
        const result = enforce(bound, {
            policies: [maxLimitPolicy({ maxLimit: 100 })],
        });

        expect(result.ok).toBe(true);
    });

    test("requires limits across scalar, exists, not exists, and in subqueries when recursive", () => {
        for (const sql of [
            "SELECT id FROM users WHERE id = (SELECT user_id FROM orders) LIMIT 10",
            "SELECT id FROM users WHERE EXISTS (SELECT user_id FROM orders) LIMIT 10",
            "SELECT id FROM users WHERE NOT EXISTS (SELECT user_id FROM orders) LIMIT 10",
            "SELECT id FROM users WHERE id IN (SELECT user_id FROM orders) LIMIT 10",
        ]) {
            const result = enforce(bindStatement(sql), {
                policies: [maxLimitPolicy({ maxLimit: 100, recursive: true })],
            });

            expect(result.ok, `Expected nested limit rejection for ${sql}`).toBe(false);
        }
    });

    test("ignores nested subquery limit sizes by default", () => {
        const bound = bindStatement(
            "SELECT users.id FROM users WHERE users.id IN (SELECT orders.id FROM orders LIMIT 999999) LIMIT 10",
        );
        const result = enforce(bound, {
            policies: [maxLimitPolicy({ maxLimit: 100 })],
        });

        expect(result.ok).toBe(true);
    });

    test("rejects nested subquery limit sizes above the configured maximum when recursive", () => {
        const bound = bindStatement(
            "SELECT users.id FROM users WHERE users.id IN (SELECT orders.id FROM orders LIMIT 999999) LIMIT 10",
        );
        const result = enforce(bound, {
            policies: [maxLimitPolicy({ maxLimit: 100, recursive: true })],
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics[0]?.code).toBe(DiagnosticCode.LimitExceeded);
        }
    });

    test("allows approved functions and nested expressions", () => {
        const bound = bindStatement("SELECT SUM(total) FROM orders WHERE NOT (tenant_id = ?)");
        const result = enforce(bound, {
            policies: [allowedFunctionsPolicy({ allowedFunctions: new Set(["sum"]) })],
        });

        expect(result.ok).toBe(true);
    });

    test("does not treat CAST or CASE as allowlisted functions, but still enforces ROUND and NULLIF", () => {
        const syntaxOnly = enforce(
            bindStatement(
                "SELECT CAST(total AS DECIMAL(10, 2)), CASE WHEN total > 10 THEN 'large' ELSE 'small' END FROM orders",
            ),
            {
                policies: [allowedFunctionsPolicy({ allowedFunctions: new Set() })],
            },
        );
        expect(syntaxOnly.ok).toBe(true);

        const genericFunctions = enforce(
            bindStatement("SELECT ROUND(total, 2), NULLIF(status, 'cancelled') FROM orders"),
            {
                policies: [
                    allowedFunctionsPolicy({ allowedFunctions: new Set(["round", "nullif"]) }),
                ],
            },
        );
        expect(genericFunctions.ok).toBe(true);
    });

    test("enforces allowed-functions for date arithmetic functions while allowing INTERVAL syntax", () => {
        const accepted = enforce(
            bindStatement("SELECT DATE_ADD(created_at, INTERVAL ? DAY) FROM orders"),
            {
                policies: [allowedFunctionsPolicy({ allowedFunctions: new Set(["date_add"]) })],
            },
        );
        expect(accepted.ok).toBe(true);

        const rejected = enforce(
            bindStatement("SELECT DATE_SUB(created_at, INTERVAL 1 DAY) FROM orders"),
            {
                policies: [allowedFunctionsPolicy({ allowedFunctions: new Set(["date_add"]) })],
            },
        );
        expect(rejected.ok).toBe(false);
        if (!rejected.ok) {
            expect(rejected.diagnostics[0]?.code).toBe(DiagnosticCode.DisallowedFunction);
        }
    });
});
