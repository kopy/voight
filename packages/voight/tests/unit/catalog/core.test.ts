import { describe, expect, test } from "vitest";

import {
    AliasCatalog,
    createCatalogAlias,
    createIdentifierPath,
    createTableSchema,
    InMemoryCatalog,
} from "../../../src/catalog";

describe("catalog", () => {
    test("resolves tables and columns case-insensitively", () => {
        const catalog = new InMemoryCatalog([
            createTableSchema({
                path: ["Users"],
                columns: ["ID", "Email"],
            }),
        ]);

        const table = catalog.getTable(createIdentifierPath("USERS"));
        expect(table?.name).toBe("users");
        expect(catalog.resolveColumn(table!, "EMAIL")?.name).toBe("email");
    });

    test("maps logical table aliases to physical tables", () => {
        const physical = createTableSchema({
            path: ["internal_projects"],
            columns: ["id", "name"],
        });
        const catalog = new AliasCatalog(new InMemoryCatalog([physical]), [
            createCatalogAlias({
                from: ["projects"],
                to: ["internal_projects"],
            }),
        ]);

        const table = catalog.getTable(createIdentifierPath("projects"));
        expect(table?.id).toBe("internal_projects");
        expect(catalog.resolveColumn(table!, "NAME")?.name).toBe("name");
    });

    test("returns null for unknown logical aliases", () => {
        const catalog = new AliasCatalog(new InMemoryCatalog([]), [
            createCatalogAlias({
                from: ["projects"],
                to: ["internal_projects"],
            }),
        ]);

        expect(catalog.getTable(createIdentifierPath("missing"))).toBeNull();
    });

    test("preserves non-selectable column metadata", () => {
        const catalog = new InMemoryCatalog([
            createTableSchema({
                path: ["users"],
                columns: ["id", { name: "tenant_id", selectable: false }],
            }),
        ]);

        const table = catalog.getTable(createIdentifierPath("users"));
        expect(catalog.resolveColumn(table!, "id")?.selectable).toBe(true);
        expect(catalog.resolveColumn(table!, "tenant_id")?.selectable).toBe(false);
    });

    test("derives canonical ids from the normalized table path", () => {
        const table = createTableSchema({
            path: ["Analytics", "Users"],
            columns: ["id"],
        });

        expect(table.id).toBe("analytics.users");
        expect(table.name).toBe("users");
    });

    test("rejects dotted catalog path segments", () => {
        expect(() =>
            createTableSchema({
                path: ["analytics.users"],
                columns: ["id"],
            }),
        ).toThrow("cannot be empty or contain dots");

        expect(() =>
            createCatalogAlias({
                from: ["analytics.users"],
                to: ["analytics", "users"],
            }),
        ).toThrow("cannot be empty or contain dots");
    });
});
