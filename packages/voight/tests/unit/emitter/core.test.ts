import { describe, expect, test } from "vitest";

import { emit } from "../../../src/emitter";
import { bindStatement } from "../../_support/bind";

describe("emit", () => {
    test("emits canonical SQL from a bound statement", () => {
        const bound = bindStatement(
            "SELECT u.id, o.total AS amount FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE u.tenant_id = ? ORDER BY o.total DESC LIMIT 5",
        );

        const result = emit(bound);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.sql).toBe(
            "SELECT `u`.`id`, `o`.`total` AS `amount` FROM `users` AS `u` LEFT JOIN `orders` AS `o` ON `u`.`id` = `o`.`user_id` WHERE `u`.`tenant_id` = ? ORDER BY `o`.`total` DESC LIMIT 5",
        );
        expect(result.value.parameters).toHaveLength(1);
    });

    test("emits comma-style input as canonical limit offset syntax", () => {
        const bound = bindStatement("SELECT * FROM users LIMIT 2, 5");

        const result = emit(bound);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.sql).toBe(
            "SELECT `users`.`id`, `users`.`name`, `users`.`email`, `users`.`age`, `users`.`tenant_id`, `users`.`created_at` FROM `users` LIMIT 5 OFFSET 2",
        );
    });

    test("emits quoted identifiers for quoted input names", () => {
        const bound = bindStatement(
            "SELECT `u`.`name` FROM `users` AS `u` ORDER BY `u`.`name` ASC",
        );

        const result = emit(bound);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.sql).toBe(
            "SELECT `u`.`name` FROM `users` AS `u` ORDER BY `u`.`name` ASC",
        );
    });

    test("emits SELECT DISTINCT and COUNT(DISTINCT ...)", () => {
        const result = emit(
            bindStatement("SELECT DISTINCT COUNT(DISTINCT id) AS unique_users FROM users"),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.sql).toBe(
            "SELECT DISTINCT count(DISTINCT `users`.`id`) AS `unique_users` FROM `users`",
        );
    });

    test("emits window functions canonically", () => {
        const result = emit(
            bindStatement(
                "SELECT SUM(total) OVER (PARTITION BY user_id ORDER BY created_at DESC) AS running_total, COUNT(*) OVER () AS total_rows FROM orders",
            ),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.sql).toBe(
            "SELECT sum(`orders`.`total`) OVER (PARTITION BY `orders`.`user_id` ORDER BY `orders`.`created_at` DESC) AS `running_total`, count(*) OVER () AS `total_rows` FROM `orders`",
        );
    });

    test("escapes trailing backslashes in string literals for MySQL-safe output", () => {
        const result = emit(bindStatement("SELECT 'abc\\'"));
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.sql).toBe("SELECT 'abc\\\\'");
    });

    test("emits projection-only selects and current keyword expressions", () => {
        const nowEmitted = emit(bindStatement("SELECT now()"));
        expect(nowEmitted.ok).toBe(true);
        if (nowEmitted.ok) {
            expect(nowEmitted.value.sql).toBe("SELECT now()");
        }

        const currentEmitted = emit(bindStatement("SELECT CURRENT_TIME"));
        expect(currentEmitted.ok).toBe(true);
        if (currentEmitted.ok) {
            expect(currentEmitted.value.sql).toBe("SELECT CURRENT_TIME");
        }
    });

    test("emits LIKE predicates with safely escaped patterns", () => {
        const result = emit(bindStatement("SELECT id FROM users WHERE name LIKE 'O''Brien%'"));
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.sql).toBe(
            "SELECT `users`.`id` FROM `users` WHERE `users`.`name` LIKE 'O''Brien%'",
        );
    });

    test("emits REGEXP and RLIKE predicates canonically", () => {
        const result = emit(
            bindStatement(
                "SELECT id FROM users WHERE email REGEXP '^[^@]+@example\\\\.com$' OR name RLIKE 'admin'",
            ),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.sql).toBe(
            "SELECT `users`.`id` FROM `users` WHERE `users`.`email` REGEXP '^[^@]+@example\\\\\\\\.com$' OR `users`.`name` RLIKE 'admin'",
        );
    });

    test("emits BETWEEN predicates canonically", () => {
        const result = emit(
            bindStatement(
                "SELECT id FROM users WHERE age NOT BETWEEN 18 AND 65 ORDER BY created_at BETWEEN '2024-01-01' AND '2024-12-31' DESC",
            ),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.value.sql).toBe(
            "SELECT `users`.`id` FROM `users` WHERE `users`.`age` NOT BETWEEN 18 AND 65 ORDER BY `users`.`created_at` BETWEEN '2024-01-01' AND '2024-12-31' DESC",
        );
    });

    test("preserves non-associative select-alias expressions with parentheses", () => {
        const subtraction = emit(bindStatement("SELECT age - 1 AS x FROM users ORDER BY 1 - x"));
        expect(subtraction.ok).toBe(true);
        if (subtraction.ok) {
            expect(subtraction.value.sql).toContain("ORDER BY 1 - (`users`.`age` - 1) ASC");
        }

        const division = emit(bindStatement("SELECT age / 2 AS x FROM users ORDER BY 1 / x"));
        expect(division.ok).toBe(true);
        if (division.ok) {
            expect(division.value.sql).toContain("ORDER BY 1 / (`users`.`age` / 2) ASC");
        }

        const comparison = emit(bindStatement("SELECT age = 1 AS x FROM users ORDER BY id = x"));
        expect(comparison.ok).toBe(true);
        if (comparison.ok) {
            expect(comparison.value.sql).toContain(
                "ORDER BY `users`.`id` = (`users`.`age` = 1) ASC",
            );
        }
    });
});
