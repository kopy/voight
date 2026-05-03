import {
    createConnection,
    type Connection,
    type ConnectionOptions,
    type RowDataPacket,
} from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { InMemoryCatalog, createTableSchema } from "../../../src/catalog";
import { compile } from "../../../src/compiler";
import { maxLimitPolicy, tenantScopingPolicy, type CompilerPolicy } from "../../../src/policies";

const ATTACKER_PROJECT_ID = "project-alpha";
const VICTIM_PROJECT_ID = "project-bravo";
const MYSQL_CONFIG = getMysqlConfig();
const describeMysql84 = MYSQL_CONFIG ? describe : describe.skip;

const eventsCatalog = new InMemoryCatalog([
    createTableSchema({
        path: ["events"],
        columns: ["id", "project_id", "actor_id", "metric", "value"],
    }),
]);

const collationCatalog = new InMemoryCatalog([
    createTableSchema({
        path: ["collation_events"],
        columns: ["id", "project_id", "label"],
    }),
]);

const numericCatalog = new InMemoryCatalog([
    createTableSchema({
        path: ["numeric_events"],
        columns: ["id", "project_id", "metric"],
    }),
]);

const basePolicies: CompilerPolicy[] = [
    maxLimitPolicy({
        maxLimit: 100,
        defaultLimit: 25,
        maxOffset: 1_000,
    }),
];

const eventsPolicies: CompilerPolicy[] = [
    ...basePolicies,
    tenantScopingPolicy({
        tables: ["events"],
        scopeColumn: "project_id",
        contextKey: "projectId",
    }),
];

const collationPolicies: CompilerPolicy[] = [
    ...basePolicies,
    tenantScopingPolicy({
        tables: ["collation_events"],
        scopeColumn: "project_id",
        contextKey: "projectId",
    }),
];

const numericPolicies: CompilerPolicy[] = [
    ...basePolicies,
    tenantScopingPolicy({
        tables: ["numeric_events"],
        scopeColumn: "project_id",
        contextKey: "projectId",
        scopeValueType: "bigint",
    }),
];

let db: Connection;

type QueryRow = Record<string, unknown>;

function getMysqlConfig(): ConnectionOptions | string | undefined {
    const url = process.env.VOIGHT_MYSQL84_URL;
    if (url) {
        return url;
    }

    const port = process.env.VOIGHT_MYSQL84_PORT;
    if (!port) {
        return undefined;
    }

    return {
        host: process.env.VOIGHT_MYSQL84_HOST ?? "127.0.0.1",
        port: Number(port),
        user: process.env.VOIGHT_MYSQL84_USER ?? "root",
        password: process.env.VOIGHT_MYSQL84_PASSWORD ?? "voightpass",
        database: process.env.VOIGHT_MYSQL84_DATABASE ?? "voight",
    };
}

function compileScoped(
    sql: string,
    options: {
        catalog?: InMemoryCatalog;
        policies?: readonly CompilerPolicy[];
        projectId?: unknown;
    } = {},
) {
    return compile(sql, {
        catalog: options.catalog ?? eventsCatalog,
        policies: options.policies ?? eventsPolicies,
        policyContext: {
            projectId: Object.hasOwn(options, "projectId")
                ? options.projectId
                : ATTACKER_PROJECT_ID,
        },
        debug: true,
    });
}

async function executeScoped(
    sql: string,
    options: {
        catalog?: InMemoryCatalog;
        policies?: readonly CompilerPolicy[];
        projectId?: unknown;
    } = {},
) {
    const result = compileScoped(sql, options);
    expect(result.ok, JSON.stringify(result.diagnostics, null, 2)).toBe(true);
    if (!result.ok) {
        throw new Error("Compilation unexpectedly failed.");
    }

    const [rows] = await db.query<RowDataPacket[]>(result.emitted!.sql);
    return {
        result,
        rows: rows as QueryRow[],
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

describeMysql84("MySQL 8.4 project_id isolation against mixed-project rows", () => {
    beforeAll(async () => {
        db =
            typeof MYSQL_CONFIG === "string"
                ? await createConnection(MYSQL_CONFIG)
                : await createConnection(MYSQL_CONFIG!);

        await db.query("DROP TABLE IF EXISTS events");
        await db.query("DROP TABLE IF EXISTS collation_events");
        await db.query("DROP TABLE IF EXISTS numeric_events");
        await db.query(`CREATE TABLE events (
            id BIGINT PRIMARY KEY,
            project_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
            actor_id BIGINT NOT NULL,
            metric VARCHAR(64) NOT NULL,
            value BIGINT NOT NULL
        )`);
        await db.query(`CREATE TABLE collation_events (
            id BIGINT PRIMARY KEY,
            project_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
            label VARCHAR(64) NOT NULL
        )`);
        await db.query(`CREATE TABLE numeric_events (
            id BIGINT PRIMARY KEY,
            project_id BIGINT NOT NULL,
            metric VARCHAR(64) NOT NULL
        )`);
        await db.query("INSERT INTO events (id, project_id, actor_id, metric, value) VALUES ?", [
            [
                [1, ATTACKER_PROJECT_ID, 10, "login", 5],
                [2, ATTACKER_PROJECT_ID, 11, "export", 2],
                [3, ATTACKER_PROJECT_ID, 12, "login", 8],
                [4, VICTIM_PROJECT_ID, 20, "login", 999],
                [5, VICTIM_PROJECT_ID, 21, "export", 777],
                [6, VICTIM_PROJECT_ID, 22, "billing", 555],
            ],
        ]);
        await db.query("INSERT INTO collation_events (id, project_id, label) VALUES ?", [
            [
                [1, ATTACKER_PROJECT_ID, "lowercase-project"],
                [2, ATTACKER_PROJECT_ID.toUpperCase(), "uppercase-project"],
                [3, VICTIM_PROJECT_ID, "different-project"],
            ],
        ]);
        await db.query("INSERT INTO numeric_events (id, project_id, metric) VALUES ?", [
            [
                [1, 1, "alpha-login"],
                [2, 1, "alpha-export"],
                [3, 2, "bravo-secret"],
            ],
        ]);
    });

    afterAll(async () => {
        await db?.end();
    });

    test("OR predicates and direct victim filters cannot widen past the project guard", async () => {
        const { result, rows } = await executeScoped(
            `SELECT id, project_id
             FROM events
             WHERE project_id = '${VICTIM_PROJECT_ID}' OR 1 = 1
             ORDER BY id
             LIMIT 10`,
        );

        expect(result.emitted?.sql).toContain("AND `events`.`project_id` = 'project-alpha'");
        expect(rows).toEqual([
            { id: 1, project_id: ATTACKER_PROJECT_ID },
            { id: 2, project_id: ATTACKER_PROJECT_ID },
            { id: 3, project_id: ATTACKER_PROJECT_ID },
        ]);
        expectNoVictimProjectIds(rows);
    });

    test("LEFT JOIN predicates cannot pull victim-side rows", async () => {
        const { result, rows } = await executeScoped(
            `SELECT e.project_id, other.project_id AS other_project_id
             FROM events AS e
             LEFT JOIN events AS other
               ON other.project_id = '${VICTIM_PROJECT_ID}' OR 1 = 1
             ORDER BY e.id, other.id
             LIMIT 10`,
        );

        expect(result.emitted?.sql).toContain("`e`.`project_id` = 'project-alpha'");
        expect(result.emitted?.sql).toContain("`other`.`project_id` = 'project-alpha'");
        expectNoVictimProjectIds(rows);
    });

    test("scalar, EXISTS, and correlated aggregate subqueries do not expose victim data", async () => {
        const { rows } = await executeScoped(
            `SELECT COALESCE((
                    SELECT victim.project_id
                    FROM events AS victim
                    WHERE victim.project_id = '${VICTIM_PROJECT_ID}'
                    LIMIT 1
                ), 'none') AS leaked_project_id,
                EXISTS (
                    SELECT 1
                    FROM events AS victim
                    WHERE victim.project_id = '${VICTIM_PROJECT_ID}'
                ) AS has_victim_project,
                (
                    SELECT COUNT(victim.id)
                    FROM events AS victim
                    WHERE victim.project_id = '${VICTIM_PROJECT_ID}'
                      AND victim.metric = e.metric
                ) AS victim_metric_count
             FROM events AS e
             ORDER BY e.id
             LIMIT 1`,
        );

        expect(rows).toEqual([
            {
                leaked_project_id: "none",
                has_victim_project: 0,
                victim_metric_count: 0,
            },
        ]);
        expectNoVictimProjectIds(rows);
    });

    test("documents why project_id needs a binary or case-sensitive MySQL collation", async () => {
        const { result, rows } = await executeScoped(
            `SELECT id, project_id
             FROM collation_events
             ORDER BY id
             LIMIT 10`,
            {
                catalog: collationCatalog,
                policies: collationPolicies,
            },
        );

        expect(result.emitted?.sql).toContain(
            "WHERE `collation_events`.`project_id` = 'project-alpha'",
        );
        expect(projectIds(rows)).toEqual([ATTACKER_PROJECT_ID, ATTACKER_PROJECT_ID.toUpperCase()]);
    });

    test("rejects numeric and boolean context values for string project_id guards", () => {
        for (const projectId of [0, false]) {
            const result = compileScoped("SELECT id, project_id FROM events", { projectId });

            expect(result.ok, `Unexpected success for ${String(projectId)}`).toBe(false);
            if (!result.ok) {
                expect(result.diagnostics[0]?.message).toContain("requires string tenant values");
            }
        }
    });

    test("numeric project ids are isolated only through explicit numeric scope typing", async () => {
        const { result, rows } = await executeScoped(
            `SELECT id, project_id, metric
             FROM numeric_events
             WHERE project_id = 2 OR 1 = 1
             ORDER BY id
             LIMIT 10`,
            {
                catalog: numericCatalog,
                policies: numericPolicies,
                projectId: 1n,
            },
        );

        expect(result.emitted?.sql).toContain("`numeric_events`.`project_id` = 1");
        expect(projectIds(rows)).toEqual(["1", "1"]);
    });
});
