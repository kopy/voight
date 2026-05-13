import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { InMemoryCatalog, createTableSchema } from "../../../src/catalog";
import { compile } from "../../../src/compiler";
import { maxLimitPolicy, tenantScopingPolicy } from "../../../src/policies";

const ATTACKER_WORKSPACE_ID = "workspace-alpha";
const VICTIM_WORKSPACE_ID = "workspace-bravo";

const catalog = new InMemoryCatalog([
    createTableSchema({
        path: ["analytics", "event_rollups"],
        columns: [
            "id",
            "workspace_id",
            "series_name",
            "bucket_start",
            "dimension_os",
            "client_id",
            "metric_value",
        ],
    }),
    createTableSchema({
        path: ["iam", "api_clients"],
        columns: ["id", "workspace_id", "display_name", "client_kind"],
    }),
]);

const policies = [
    maxLimitPolicy({
        maxLimit: 250,
        defaultLimit: 25,
        maxOffset: 10_000,
    }),
    tenantScopingPolicy({
        tables: ["analytics.event_rollups", "iam.api_clients"],
        scopeColumn: "workspace_id",
        contextKey: "workspaceId",
        scopeValueType: "string",
    }),
];

let db: DatabaseSync;

type QueryRow = Record<string, unknown>;

function compileScoped(sql: string) {
    return compile(sql, {
        catalog,
        policies,
        policyContext: {
            workspaceId: ATTACKER_WORKSPACE_ID,
        },
        debug: true,
    });
}

function executeScoped(sql: string) {
    const result = compileScoped(sql);
    expect(result.ok, JSON.stringify(result.diagnostics, null, 2)).toBe(true);
    if (!result.ok) {
        throw new Error("Compilation unexpectedly failed.");
    }

    return {
        result,
        rows: db.prepare(result.emitted!.sql).all() as QueryRow[],
    };
}

function workspaceIdValues(rows: readonly QueryRow[]): string[] {
    return rows
        .flatMap((row) => Object.entries(row))
        .filter(([key, value]) => key.toLowerCase().includes("workspace_id") && value !== null)
        .map(([, value]) => String(value));
}

beforeAll(() => {
    db = new DatabaseSync(":memory:");
    db.exec("ATTACH DATABASE ':memory:' AS analytics");
    db.exec("ATTACH DATABASE ':memory:' AS iam");

    db.exec(`CREATE TABLE analytics.event_rollups (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        series_name TEXT NOT NULL,
        bucket_start TEXT NOT NULL,
        dimension_os TEXT NOT NULL,
        client_id INTEGER NOT NULL,
        metric_value REAL NOT NULL
    )`);
    db.exec(`CREATE TABLE iam.api_clients (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        client_kind TEXT NOT NULL
    )`);

    db.exec(`INSERT INTO analytics.event_rollups VALUES
        (1, '${ATTACKER_WORKSPACE_ID}', 'signups', '2026-01-01T00:00:00Z', 'ios', 10, 42.5),
        (2, '${ATTACKER_WORKSPACE_ID}', 'retention', '2026-01-02T00:00:00Z', 'web', 10, 12.0),
        (3, '${VICTIM_WORKSPACE_ID}', 'signups', '2026-01-01T00:00:00Z', 'ios', 20, 999.0),
        (4, '${VICTIM_WORKSPACE_ID}', 'revenue', '2026-01-02T00:00:00Z', 'android', 20, 1234.0)
    `);
    db.exec(`INSERT INTO iam.api_clients VALUES
        (10, '${ATTACKER_WORKSPACE_ID}', 'alpha-dashboard', 'server'),
        (20, '${VICTIM_WORKSPACE_ID}', 'bravo-dashboard', 'server')
    `);
});

afterAll(() => {
    db.close();
});

describe("schema-qualified tenant scoping probes", () => {
    test("scoping survives quoted aliases with comment-looking payloads", () => {
        const { result, rows } = executeScoped(
            "SELECT `r --`.`workspace_id` FROM `analytics`.`event_rollups` AS `r --` ORDER BY `r --`.`id` LIMIT 2",
        );

        expect(result.emitted?.sql).toContain("WHERE `r --`.`workspace_id` = 'workspace-alpha'");
        expect(workspaceIdValues(rows)).toEqual([ATTACKER_WORKSPACE_ID, ATTACKER_WORKSPACE_ID]);
    });

    test("derived-table wildcard expansion does not resurrect victim rows", () => {
        const { result, rows } = executeScoped(
            `SELECT d.*
             FROM (
               SELECT r.workspace_id, r.series_name
               FROM analytics.event_rollups AS r
               WHERE r.workspace_id = '${VICTIM_WORKSPACE_ID}'
               LIMIT 3
             ) AS d
             LIMIT 3`,
        );

        expect(result.emitted?.sql).not.toContain("SELECT `d`.*");
        expect(result.emitted?.sql).toContain("AND `r`.`workspace_id` = 'workspace-alpha'");
        expect(rows).toEqual([]);
    });

    test("multi-CTE nesting with an explicit victim predicate returns no rows", () => {
        const { rows } = executeScoped(
            `WITH c1 AS (
               SELECT r.workspace_id
               FROM analytics.event_rollups AS r
               WHERE r.workspace_id = '${VICTIM_WORKSPACE_ID}'
               LIMIT 5
             ),
             c2 AS (
               SELECT c1.workspace_id
               FROM c1
             )
             SELECT c2.workspace_id
             FROM c2
             LIMIT 5`,
        );

        expect(rows).toEqual([]);
    });

    test("a short-name CTE does not inherit the scoped schema-qualified table identity", () => {
        // The policy scopes analytics.event_rollups, not an unrelated CTE named event_rollups.
        // This proves the compiler distinguishes attacker-controlled CTEs from real catalog data.
        const { result, rows } = executeScoped(
            `WITH event_rollups AS (
               SELECT '${VICTIM_WORKSPACE_ID}' AS workspace_id, 'planted-row' AS series_name
             )
             SELECT series_name
             FROM event_rollups`,
        );

        expect(result.emitted?.sql).not.toContain("workspace-alpha");
        expect(rows).toEqual([{ series_name: "planted-row" }]);
    });

    test("a short-name CTE does not shadow an explicit schema-qualified catalog table", () => {
        const { result, rows } = executeScoped(
            `WITH event_rollups AS (
               SELECT '${VICTIM_WORKSPACE_ID}' AS workspace_id, 'planted-row' AS series_name
             )
             SELECT r.workspace_id
             FROM analytics.event_rollups AS r
             ORDER BY r.id
             LIMIT 1`,
        );

        expect(result.emitted?.sql).toContain("FROM `analytics`.`event_rollups` AS `r`");
        expect(result.emitted?.sql).toContain("`r`.`workspace_id` = 'workspace-alpha'");
        expect(rows).toEqual([{ workspace_id: ATTACKER_WORKSPACE_ID }]);
    });

    test("CASE-wrapped scalar subqueries cannot exfiltrate a victim workspace id", () => {
        const { rows } = executeScoped(
            `SELECT CASE
                WHEN c.id IS NOT NULL THEN (
                    SELECT r.workspace_id
                    FROM analytics.event_rollups AS r
                    WHERE r.workspace_id = '${VICTIM_WORKSPACE_ID}'
                    LIMIT 1
                )
                ELSE NULL
             END AS leaked
             FROM iam.api_clients AS c
             ORDER BY c.id
             LIMIT 1`,
        );

        expect(rows).toEqual([{ leaked: null }]);
    });

    test("correlated scalar subqueries targeting a victim workspace resolve to null", () => {
        const { rows } = executeScoped(
            `SELECT (
                SELECT inner_r.workspace_id
                FROM analytics.event_rollups AS inner_r
                WHERE inner_r.series_name = outer_r.series_name
                  AND inner_r.workspace_id = '${VICTIM_WORKSPACE_ID}'
                LIMIT 1
             ) AS leaked
             FROM analytics.event_rollups AS outer_r
             ORDER BY outer_r.id
             LIMIT 1`,
        );

        expect(rows).toEqual([{ leaked: null }]);
    });
});
