import { describe, expect, test } from "vitest";

import { DiagnosticCode } from "../../../src/core/diagnostics";
import { compileStrict } from "../../_support/compile";

function expectBlocked(sql: string) {
    const result = compileStrict(sql);
    expect(result.ok, `Expected rejection but query compiled: ${sql}`).toBe(false);
    return result;
}

describe("compile hardening", () => {
    test("rejects mutation and multi-statement inputs", () => {
        for (const sql of [
            "INSERT INTO users (id) VALUES (1)",
            "UPDATE users SET name = 'x'",
            "DELETE FROM users",
            "SELECT 1; DROP TABLE users",
            "SELECT 1; SELECT 2",
            "SET @a = 1",
            "SELECT id FROM users UNION SELECT id FROM orders",
            "SELECT id FROM users INTERSECT SELECT user_id FROM orders",
            "SELECT id FROM users EXCEPT SELECT user_id FROM orders",
        ]) {
            expectBlocked(sql);
        }
    });

    test("rejects quoted callable and cast-type injection surfaces", () => {
        for (const sql of [
            "SELECT `SLEEP(1); DROP TABLE users; -- `(0)",
            "SELECT `GET_LOCK('voight', 10); DROP TABLE users; -- `(0)",
            "SELECT CAST(name AS `CHAR); DROP TABLE users; -- `) FROM users",
            "SELECT CAST(name AS `CHAR CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`) FROM users",
        ]) {
            expectBlocked(sql);
        }
    });

    test("rejects advanced SQL forms outside the supported SELECT subset", () => {
        for (const sql of [
            "WITH RECURSIVE r(n) AS (SELECT 1) SELECT n FROM r",
            "SELECT * FROM LATERAL (SELECT id FROM users) AS x",
            "SELECT * FROM JSON_TABLE('[1]', '$[*]' COLUMNS(n INT PATH '$')) AS jt",
            "TABLE users",
            "VALUES ROW(1), ROW(2)",
            "SELECT * FROM (VALUES ROW(1)) AS v(id)",
            "SELECT id INTO OUTFILE '/tmp/x' FROM users",
            "SELECT id FROM users FOR UPDATE",
            "SELECT id FROM users LOCK IN SHARE MODE",
            "SELECT id FROM users USE INDEX (idx_users_tenant)",
            "SELECT name COLLATE utf8mb4_bin FROM users",
            "SELECT id FROM users WHERE profile->'$.tenant_id' = 'x'",
            "SELECT id FROM users WHERE profile->>'$.tenant_id' = 'x'",
            "SELECT id FROM users WHERE (id, tenant_id) IN ((1, 't'))",
            "SELECT id FROM users WHERE id > ALL (SELECT user_id FROM orders)",
            "SELECT id FROM users WHERE id = ANY (SELECT user_id FROM orders)",
            "SELECT SUM(total) OVER (ORDER BY created_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM orders",
            "SELECT SUM(total) OVER w FROM orders WINDOW w AS (PARTITION BY user_id)",
            "SELECT metric, SUM(value) FROM timeseries GROUP BY metric WITH ROLLUP",
        ]) {
            expectBlocked(sql);
        }
    });

    test("rejects comment-based and exotic-token bypass attempts", () => {
        for (const sql of [
            "SELECT id FROM users -- where 1=1",
            "SELECT id FROM users # comment",
            "SELECT id FROM users /* comment */",
            "SELECT /*!80408 SQL_NO_CACHE */ id FROM users",
            "SELECT /*+ MAX_EXECUTION_TIME(1) */ id FROM users",
            "SELECT id FROM users\uFF1B",
        ]) {
            expectBlocked(sql);
        }
    });

    test("rejects catalog escape attempts against system and cross-database tables", () => {
        const unknownTable = expectBlocked("SELECT * FROM information_schema.tables");
        expect(
            unknownTable.diagnostics.some(
                (diagnostic) => diagnostic.code === DiagnosticCode.UnknownTable,
            ),
        ).toBe(true);

        expectBlocked("SELECT user FROM mysql.user");
        expectBlocked("SELECT id FROM other_db.users");
        expectBlocked("SELECT * FROM performance_schema.threads");
    });
});
