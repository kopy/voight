export interface IdentifierPath {
    readonly parts: readonly string[];
}

export interface ColumnSchema {
    readonly id: string;
    readonly name: string;
    readonly selectable?: boolean;
}

export interface TableSchema {
    readonly id: string;
    readonly name: string;
    readonly path: IdentifierPath;
    readonly columns: ReadonlyMap<string, ColumnSchema>;
}

export interface Catalog {
    getTable(name: IdentifierPath): TableSchema | null;
    resolveColumn(table: TableSchema, columnName: string): ColumnSchema | null;
}

export interface CatalogTableAlias {
    readonly from: IdentifierPath;
    readonly to: IdentifierPath;
}

export class InMemoryCatalog implements Catalog {
    readonly #tables: Map<string, TableSchema>;

    constructor(tables: readonly TableSchema[]) {
        this.#tables = new Map(tables.map((table) => [normalizeIdentifierPath(table.path), table]));
    }

    getTable(name: IdentifierPath): TableSchema | null {
        return this.#tables.get(normalizeIdentifierPath(name)) ?? null;
    }

    resolveColumn(table: TableSchema, columnName: string): ColumnSchema | null {
        return table.columns.get(normalizeIdentifier(columnName)) ?? null;
    }
}

export function createIdentifierPath(...parts: string[]): IdentifierPath {
    return {
        parts: parts.map((part) => normalizeIdentifierPathSegment(part)),
    };
}

export function createTableSchema(input: {
    path: readonly string[];
    columns: readonly (
        | string
        | {
              readonly name: string;
              readonly selectable?: boolean;
          }
    )[];
}): TableSchema {
    const normalizedPath = input.path.map((part) => normalizeIdentifierPathSegment(part));
    if (normalizedPath.length === 0 || normalizedPath.some((part) => part.length === 0)) {
        throw new Error("createTableSchema requires a non-empty path.");
    }

    const canonicalId = normalizedPath.join(".");

    return {
        id: canonicalId,
        name: normalizedPath[normalizedPath.length - 1] ?? canonicalId,
        path: createIdentifierPath(...normalizedPath),
        columns: new Map(
            input.columns.map((column) => {
                const definition =
                    typeof column === "string"
                        ? {
                              name: column,
                          }
                        : column;
                const normalizedName = normalizeIdentifier(definition.name);

                return [
                    normalizedName,
                    {
                        id: `${canonicalId}.${normalizedName}`,
                        name: normalizedName,
                        selectable: definition.selectable ?? true,
                    },
                ] satisfies [string, ColumnSchema];
            }),
        ),
    };
}

export function normalizeIdentifier(value: string): string {
    return value.toLowerCase();
}

function normalizeIdentifierPathSegment(value: string): string {
    const normalized = normalizeIdentifier(value);
    if (!normalized || normalized.includes(".")) {
        throw new Error("Catalog identifier path segments cannot be empty or contain dots.");
    }

    return normalized;
}

function normalizeIdentifierPath(path: IdentifierPath): string {
    return JSON.stringify(path.parts.map(normalizeIdentifier));
}

export class AliasCatalog implements Catalog {
    readonly #catalog: Catalog;
    readonly #aliases: Map<string, IdentifierPath>;

    constructor(catalog: Catalog, aliases: readonly CatalogTableAlias[]) {
        this.#catalog = catalog;
        this.#aliases = new Map(
            aliases.map((alias) => [
                normalizeIdentifierPath(alias.from),
                createIdentifierPath(...alias.to.parts),
            ]),
        );
    }

    getTable(name: IdentifierPath): TableSchema | null {
        const aliased = this.#aliases.get(normalizeIdentifierPath(name));
        return this.#catalog.getTable(aliased ?? name);
    }

    resolveColumn(table: TableSchema, columnName: string): ColumnSchema | null {
        return this.#catalog.resolveColumn(table, columnName);
    }
}

export function createCatalogAlias(input: {
    from: readonly string[];
    to: readonly string[];
}): CatalogTableAlias {
    return {
        from: createIdentifierPath(...input.from),
        to: createIdentifierPath(...input.to),
    };
}
