import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { InMemoryCatalog, createTableSchema } from "../../../src/catalog";
import { compile } from "../../../src/compiler";
import { maxLimitPolicy, tenantScopingPolicy } from "../../../src/policies";

const ATTACKER_PROJECT_ID = "project-alpha";
const VICTIM_PROJECT_ID = "project-bravo";

const catalog = new InMemoryCatalog([
    createTableSchema({
        path: ["events"],
        columns: ["id", "project_id", "actor_id", "metric", "value"],
    }),
]);

const policies = [
    maxLimitPolicy({
        maxLimit: 100,
        defaultLimit: 25,
        maxOffset: 1_000,
    }),
    tenantScopingPolicy({
        tables: ["events"],
        scopeColumn: "project_id",
        contextKey: "projectId",
    }),
];

let db: DatabaseSync;

type QueryRow = Record<string, unknown>;

function compileScoped(sql: string) {
    return compile(sql, {
        catalog,
        policies,
        policyContext: {
            projectId: ATTACKER_PROJECT_ID,
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

function projectIds(rows: readonly QueryRow[]): string[] {
    return rows
        .flatMap((row) => Object.entries(row))
        .filter(([key, value]) => key.toLowerCase().includes("project_id") && value !== null)
        .map(([, value]) => String(value));
}

function expectNoVictimProjectIds(rows: readonly QueryRow[]): void {
    expect(projectIds(rows)).not.toContain(VICTIM_PROJECT_ID);
}

beforeAll(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        project_id TEXT NOT NULL,
        actor_id INTEGER NOT NULL,
        metric TEXT NOT NULL,
        value INTEGER NOT NULL
    )`);

    db.exec(`INSERT INTO events VALUES
        (1, '${ATTACKER_PROJECT_ID}', 10, 'login', 5),
        (2, '${ATTACKER_PROJECT_ID}', 11, 'export', 2),
        (3, '${ATTACKER_PROJECT_ID}', 12, 'login', 8),
        (4, '${VICTIM_PROJECT_ID}', 20, 'login', 999),
        (5, '${VICTIM_PROJECT_ID}', 21, 'export', 777),
        (6, '${VICTIM_PROJECT_ID}', 22, 'billing', 555)
    `);
});

afterAll(() => {
    db.close();
});

describe("project_id isolation against mixed-project rows", () => {
    test("base table reads return only the configured project", () => {
        const { result, rows } = executeScoped(
            "SELECT id, project_id, metric, value FROM events ORDER BY id LIMIT 10",
        );

        expect(result.emitted?.sql).toContain("WHERE `events`.`project_id` = 'project-alpha'");
        expect(projectIds(rows)).toEqual([
            ATTACKER_PROJECT_ID,
            ATTACKER_PROJECT_ID,
            ATTACKER_PROJECT_ID,
        ]);
        expectNoVictimProjectIds(rows);
    });

    test("an explicit victim project predicate returns no rows", () => {
        const { result, rows } = executeScoped(
            `SELECT id, project_id, metric
             FROM events
             WHERE project_id = '${VICTIM_PROJECT_ID}'
             ORDER BY id
             LIMIT 10`,
        );

        expect(result.emitted?.sql).toContain("`events`.`project_id` = 'project-alpha'");
        expect(rows).toEqual([]);
        expectNoVictimProjectIds(rows);
    });

    test("derived tables with victim predicates cannot resurrect victim rows", () => {
        const { rows } = executeScoped(
            `SELECT d.project_id, d.metric
             FROM (
               SELECT project_id, metric
               FROM events
               WHERE project_id = '${VICTIM_PROJECT_ID}'
               LIMIT 10
             ) AS d
             LIMIT 10`,
        );

        expect(rows).toEqual([]);
        expectNoVictimProjectIds(rows);
    });

    test("CTEs with victim predicates cannot resurrect victim rows", () => {
        const { rows } = executeScoped(
            `WITH victim_events AS (
               SELECT project_id, metric
               FROM events
               WHERE project_id = '${VICTIM_PROJECT_ID}'
               LIMIT 10
             )
             SELECT project_id, metric
             FROM victim_events
             LIMIT 10`,
        );

        expect(rows).toEqual([]);
        expectNoVictimProjectIds(rows);
    });

    test("scalar subqueries cannot leak a victim project id", () => {
        const { rows } = executeScoped(
            `SELECT (
                SELECT project_id
                FROM events
                WHERE project_id = '${VICTIM_PROJECT_ID}'
                LIMIT 1
             ) AS leaked_project_id
             FROM events
             ORDER BY id
             LIMIT 1`,
        );

        expect(rows).toEqual([{ leaked_project_id: null }]);
        expectNoVictimProjectIds(rows);
    });

    test("default limits are injected into NOT EXISTS subqueries", () => {
        const { result, rows } = executeScoped(
            `SELECT e.id
             FROM events AS e
             WHERE NOT EXISTS (
               SELECT 1
               FROM events AS victim
               WHERE victim.project_id = '${VICTIM_PROJECT_ID}'
                 AND victim.metric = e.metric
             )
             ORDER BY e.id`,
        );

        expect(result.emitted?.sql).toContain("NOT EXISTS (SELECT 1 FROM `events` AS `victim`");
        expect(result.emitted?.sql).toContain("`victim`.`project_id` = 'project-alpha'");
        expect(result.emitted?.sql).toContain("LIMIT 25");
        expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
        expectNoVictimProjectIds(rows);
    });

    test("CASE scalar subqueries get tenant guards and default limits", () => {
        const { result, rows } = executeScoped(
            `SELECT CASE
                WHEN e.id > 0 THEN (
                    SELECT victim.project_id
                    FROM events AS victim
                    WHERE victim.project_id = '${VICTIM_PROJECT_ID}'
                    LIMIT 1
                )
                ELSE NULL
             END AS leaked_project_id
             FROM events AS e
             ORDER BY e.id`,
        );

        expect(result.emitted?.sql).toContain("`victim`.`project_id` = 'project-alpha'");
        expect(result.emitted?.sql).toContain("LIMIT 25");
        expect(rows[0]).toEqual({ leaked_project_id: null });
        expectNoVictimProjectIds(rows);
    });

    test("function-argument scalar subqueries cannot leak victim project ids", () => {
        const { rows } = executeScoped(
            `SELECT COALESCE((
                SELECT victim.project_id
                FROM events AS victim
                WHERE victim.project_id = '${VICTIM_PROJECT_ID}'
                LIMIT 1
             ), 'none') AS leaked_project_id
             FROM events AS e
             ORDER BY e.id
             LIMIT 1`,
        );

        expect(rows).toEqual([{ leaked_project_id: "none" }]);
        expectNoVictimProjectIds(rows);
    });

    test("EXISTS projection subqueries cannot reveal victim project existence", () => {
        const { rows } = executeScoped(
            `SELECT EXISTS (
                SELECT 1
                FROM events AS victim
                WHERE victim.project_id = '${VICTIM_PROJECT_ID}'
             ) AS has_victim_project
             FROM events AS e
             ORDER BY e.id
             LIMIT 1`,
        );

        expect(rows).toEqual([{ has_victim_project: 0 }]);
        expectNoVictimProjectIds(rows);
    });

    test("correlated aggregate subqueries cannot reveal victim metric distribution", () => {
        const { rows } = executeScoped(
            `SELECT e.metric,
                    (
                        SELECT COUNT(victim.id)
                        FROM events AS victim
                        WHERE victim.project_id = '${VICTIM_PROJECT_ID}'
                          AND victim.metric = e.metric
                    ) AS victim_metric_count
             FROM events AS e
             ORDER BY e.id
             LIMIT 3`,
        );

        expect(rows).toEqual([
            { metric: "login", victim_metric_count: 0 },
            { metric: "export", victim_metric_count: 0 },
            { metric: "login", victim_metric_count: 0 },
        ]);
        expectNoVictimProjectIds(rows);
    });

    test("HAVING subqueries cannot reveal victim project existence", () => {
        const { rows } = executeScoped(
            `SELECT metric, COUNT(id) AS event_count
             FROM events
             GROUP BY metric
             HAVING (
                SELECT COUNT(victim.id)
                FROM events AS victim
                WHERE victim.project_id = '${VICTIM_PROJECT_ID}'
             ) > 0
             ORDER BY metric`,
        );

        expect(rows).toEqual([]);
        expectNoVictimProjectIds(rows);
    });

    test("self joins scope every table touch independently", () => {
        const { result, rows } = executeScoped(
            `SELECT e.id, other.id AS other_id
             FROM events AS e
             INNER JOIN events AS other
               ON other.metric = e.metric
              AND other.project_id = '${VICTIM_PROJECT_ID}'
             ORDER BY e.id
             LIMIT 10`,
        );

        expect(result.emitted?.sql).toContain("`e`.`project_id` = 'project-alpha'");
        expect(result.emitted?.sql).toContain("`other`.`project_id` = 'project-alpha'");
        expect(rows).toEqual([]);
        expectNoVictimProjectIds(rows);
    });

    test("cross joins scope the joined table even without an original ON clause", () => {
        const { result, rows } = executeScoped(
            `SELECT e.project_id, other.project_id AS other_project_id
             FROM events AS e
             CROSS JOIN events AS other
             WHERE other.project_id = '${VICTIM_PROJECT_ID}' OR 1 = 1
             ORDER BY e.id, other.id
             LIMIT 10`,
        );

        expect(result.emitted?.sql).toContain("INNER JOIN `events` AS `other` ON TRUE");
        expect(result.emitted?.sql).toContain("`other`.`project_id` = 'project-alpha'");
        expect(result.emitted?.sql).toContain("`e`.`project_id` = 'project-alpha'");
        expectNoVictimProjectIds(rows);
    });

    test("OR predicates cannot widen past the injected project guard", () => {
        const { result, rows } = executeScoped(
            `SELECT id, project_id
             FROM events
             WHERE project_id = '${VICTIM_PROJECT_ID}' OR 1 = 1
             ORDER BY id
             LIMIT 10`,
        );

        expect(result.emitted?.sql).toContain("OR 1 = 1");
        expect(result.emitted?.sql).toContain("AND `events`.`project_id` = 'project-alpha'");
        expect(rows).toEqual([
            { id: 1, project_id: ATTACKER_PROJECT_ID },
            { id: 2, project_id: ATTACKER_PROJECT_ID },
            { id: 3, project_id: ATTACKER_PROJECT_ID },
        ]);
        expectNoVictimProjectIds(rows);
    });

    test("left joins with always-true join predicates cannot pull victim rows", () => {
        const { result, rows } = executeScoped(
            `SELECT e.project_id, other.project_id AS other_project_id
             FROM events AS e
             LEFT JOIN events AS other
               ON other.project_id = '${VICTIM_PROJECT_ID}' OR 1 = 1
             ORDER BY e.id, other.id
             LIMIT 10`,
        );

        expect(result.emitted?.sql).toContain("`other`.`project_id` = 'project-alpha'");
        expect(result.emitted?.sql).toContain("`e`.`project_id` = 'project-alpha'");
        expectNoVictimProjectIds(rows);
    });

    test("IN-list scalar subqueries cannot smuggle victim ids", () => {
        const { rows } = executeScoped(
            `SELECT id, project_id
             FROM events
             WHERE id IN (
                (SELECT id FROM events WHERE project_id = '${VICTIM_PROJECT_ID}' LIMIT 1),
                1
             )
             ORDER BY id
             LIMIT 10`,
        );

        expect(rows).toEqual([{ id: 1, project_id: ATTACKER_PROJECT_ID }]);
        expectNoVictimProjectIds(rows);
    });

    test("window expression subqueries cannot read victim project ids", () => {
        const { rows } = executeScoped(
            `SELECT project_id,
                    COUNT(id) OVER (
                        PARTITION BY (
                            SELECT project_id
                            FROM events
                            WHERE project_id = '${VICTIM_PROJECT_ID}'
                            LIMIT 1
                        )
                    ) AS grouped_count
             FROM events
             ORDER BY id
             LIMIT 10`,
        );

        expect(rows).toEqual([
            { project_id: ATTACKER_PROJECT_ID, grouped_count: 3 },
            { project_id: ATTACKER_PROJECT_ID, grouped_count: 3 },
            { project_id: ATTACKER_PROJECT_ID, grouped_count: 3 },
        ]);
        expectNoVictimProjectIds(rows);
    });

    test("quoted aliases containing SQL syntax do not break out of project guards", () => {
        const { result, rows } = executeScoped(
            "SELECT `e --`.`project_id` FROM events AS `e --` WHERE `e --`.`project_id` = 'project-bravo' OR 1 = 1 ORDER BY `e --`.`id` LIMIT 10",
        );

        expect(result.emitted?.sql).toContain("`e --`.`project_id` = 'project-alpha'");
        expect(projectIds(rows)).toEqual([
            ATTACKER_PROJECT_ID,
            ATTACKER_PROJECT_ID,
            ATTACKER_PROJECT_ID,
        ]);
        expectNoVictimProjectIds(rows);
    });
});
