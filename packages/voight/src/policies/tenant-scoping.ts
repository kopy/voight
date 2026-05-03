import type {
    BoundExpression,
    BoundQuery,
    BoundSelectStatement,
    BoundTableReference,
    ExpressionNode,
    IdentifierNode,
    IsNullExpressionNode,
    LiteralNode,
    NamedTableReferenceNode,
    QualifiedReferenceNode,
    QueryAst,
    SelectStatementAst,
    TableReferenceNode,
} from "../ast";
import { collectBoundPolicyDiagnostics } from "../ast/bound-policy-traversal";
import { normalizeIdentifier, type Catalog } from "../catalog";
import {
    CompilerStage,
    DiagnosticCode,
    DiagnosticVisibility,
    createDiagnostic,
    type Diagnostic,
} from "../core/diagnostics";
import { markTrustedAstNode } from "../compiler/trusted-ast";
import { mergeSpans, type SourceSpan } from "../core/source";
import {
    PolicyConfigurationError,
    PolicyDiagnosticError,
    PolicyUsageError,
    type CompilerPolicy,
    type PolicyEnforcementContext,
    type PolicyRewriteContext,
} from "./shared";

const TENANT_SCOPING_POLICY_NAME = "tenant-scoping";
const MAX_UINT64 = (1n << 64n) - 1n;
const MIN_POSITIVE_UINT64 = 1n;

export interface TenantScopingScopeOptions {
    readonly tables: readonly string[];
    readonly scopeColumn: string;
    readonly contextKey: string;
}

export type TenantScopingPolicyOptions =
    | TenantScopingScopeOptions
    | {
          readonly scopes: readonly TenantScopingScopeOptions[];
      };

export function tenantScopingPolicy(options: TenantScopingPolicyOptions): CompilerPolicy {
    return new TenantScopingPolicy(options);
}

interface TenantScopeRule {
    readonly tables: ReadonlySet<string>;
    readonly scopeColumn: string;
    readonly contextKey: string;
}

interface TenantScopeMatch {
    readonly exactRules: readonly TenantScopeRule[];
    readonly shortRules: readonly TenantScopeRule[];
    readonly names: readonly string[];
    readonly canonicalName: string;
    readonly schemaQualified: boolean;
}

const POLICY_IDENTIFIER_SEGMENT_PATTERN = /^[a-z_][a-z0-9_$]*$/;

class TenantScopingPolicy implements CompilerPolicy {
    readonly name = TENANT_SCOPING_POLICY_NAME;
    readonly #scopeRules: readonly TenantScopeRule[];

    constructor(options: TenantScopingPolicyOptions) {
        this.#scopeRules = validateTenantScopeRules(options, this.name);
    }

    rewrite(query: QueryAst, context: PolicyRewriteContext): QueryAst {
        if (!context.catalog) {
            throw new PolicyUsageError(
                `Policy "${TENANT_SCOPING_POLICY_NAME}" requires a catalog to rewrite tenant predicates.`,
                { policyName: TENANT_SCOPING_POLICY_NAME },
            );
        }

        return this.#rewriteQuery(
            query,
            resolveTenantScopeContextValues(this.#scopeRules, context.context, "rewrite"),
            new Set(),
            context.catalog,
        );
    }

    enforce(bound: BoundQuery, context: PolicyEnforcementContext): readonly Diagnostic[] {
        return collectBoundPolicyDiagnostics(bound, {
            select: (select) =>
                this.#enforceSelect(
                    select,
                    resolveTenantScopeContextValues(this.#scopeRules, context.context, "enforce"),
                ),
        });
    }

    #rewriteQuery(
        query: QueryAst,
        contextValues: ReadonlyMap<string, unknown>,
        visibleCtes: ReadonlySet<string>,
        catalog: Catalog,
    ): QueryAst {
        const nextVisibleCtes = new Set(visibleCtes);
        const withClause = query.with
            ? {
                  ...query.with,
                  ctes: query.with.ctes.map((cte) => {
                      const rewritten = {
                          ...cte,
                          query: this.#rewriteQuery(
                              cte.query,
                              contextValues,
                              nextVisibleCtes,
                              catalog,
                          ),
                      };
                      nextVisibleCtes.add(normalizeIdentifier(cte.name.name));
                      return rewritten;
                  }),
              }
            : undefined;

        return {
            ...query,
            with: withClause,
            body: this.#rewriteSelect(query.body, contextValues, nextVisibleCtes, catalog),
        };
    }

    #rewriteSelect(
        select: SelectStatementAst,
        contextValues: ReadonlyMap<string, unknown>,
        visibleCtes: ReadonlySet<string>,
        catalog: Catalog,
    ): SelectStatementAst {
        const rewritten: SelectStatementAst = {
            ...select,
            selectItems: select.selectItems.map((item) =>
                item.kind === "SelectExpressionItem"
                    ? {
                          ...item,
                          expression: this.#rewriteExpression(
                              item.expression,
                              contextValues,
                              visibleCtes,
                              catalog,
                          ),
                      }
                    : item,
            ),
            from: select.from
                ? this.#rewriteTableReference(select.from, contextValues, visibleCtes, catalog)
                : undefined,
            joins: select.joins.map((join) => ({
                ...join,
                table: this.#rewriteTableReference(join.table, contextValues, visibleCtes, catalog),
                on: this.#rewriteExpression(join.on, contextValues, visibleCtes, catalog),
            })),
            where: select.where
                ? this.#rewriteExpression(select.where, contextValues, visibleCtes, catalog)
                : undefined,
            groupBy: select.groupBy.map((expression) =>
                this.#rewriteExpression(expression, contextValues, visibleCtes, catalog),
            ),
            having: select.having
                ? this.#rewriteExpression(select.having, contextValues, visibleCtes, catalog)
                : undefined,
            orderBy: select.orderBy.map((item) => ({
                ...item,
                expression: this.#rewriteExpression(
                    item.expression,
                    contextValues,
                    visibleCtes,
                    catalog,
                ),
            })),
            limit: select.limit
                ? {
                      ...select.limit,
                      count: this.#rewriteExpression(
                          select.limit.count,
                          contextValues,
                          visibleCtes,
                          catalog,
                      ),
                      offset: select.limit.offset
                          ? this.#rewriteExpression(
                                select.limit.offset,
                                contextValues,
                                visibleCtes,
                                catalog,
                            )
                          : undefined,
                  }
                : undefined,
        };

        const fromScope = rewritten.from
            ? this.#resolveScopedTableAlias(rewritten.from, visibleCtes, catalog)
            : undefined;
        const joins = rewritten.joins.map((join) => {
            const scope = this.#resolveScopedTableAlias(join.table, visibleCtes, catalog);
            if (!scope) {
                return join;
            }

            const predicate = createTenantPredicate(
                scope.alias,
                scope.rule.scopeColumn,
                getTenantScopeContextValue(contextValues, scope.rule.contextKey),
                scope.span,
            );
            return {
                ...join,
                on: combinePredicates([join.on, predicate]),
                span: mergeSpans(join.span, predicate.span),
            };
        });

        const where = fromScope
            ? rewritten.where
                ? combinePredicates([
                      rewritten.where,
                      createTenantPredicate(
                          fromScope.alias,
                          fromScope.rule.scopeColumn,
                          getTenantScopeContextValue(contextValues, fromScope.rule.contextKey),
                          fromScope.span,
                      ),
                  ])
                : createTenantPredicate(
                      fromScope.alias,
                      fromScope.rule.scopeColumn,
                      getTenantScopeContextValue(contextValues, fromScope.rule.contextKey),
                      fromScope.span,
                  )
            : rewritten.where;

        return {
            ...rewritten,
            joins,
            where,
            span: where ? mergeSpans(rewritten.span, where.span) : rewritten.span,
        };
    }

    #enforceSelect(
        select: BoundSelectStatement,
        contextValues: ReadonlyMap<string, unknown>,
    ): readonly Diagnostic[] {
        const diagnostics: Diagnostic[] = [];

        for (const table of select.scope.tables.values()) {
            const classification = this.#classifyBoundTable(table);
            if (!classification.matched) {
                continue;
            }

            if (classification.ambiguous) {
                diagnostics.push(
                    createDiagnostic({
                        code: DiagnosticCode.InvalidPolicyConfiguration,
                        stage: CompilerStage.Enforcer,
                        message: `Policy "${this.name}" matched ${classification.ambiguous.join(", ")} against more than one tenant scope rule.`,
                        primarySpan: table.span,
                    }),
                );
                continue;
            }

            if (classification.requiresQualifiedName && classification.name) {
                diagnostics.push(
                    createDiagnostic({
                        code: DiagnosticCode.InvalidPolicyConfiguration,
                        stage: CompilerStage.Enforcer,
                        message: `Policy "${this.name}" requires schema-qualified table "${classification.name}" to be configured using its full name.`,
                        primarySpan: table.span,
                    }),
                );
                continue;
            }

            if (classification.shadowed) {
                diagnostics.push(
                    createDiagnostic({
                        code: DiagnosticCode.PolicyViolation,
                        stage: CompilerStage.Enforcer,
                        message: `Policy "${this.name}" rejects shadowing of scoped table "${classification.name}".`,
                        primarySpan: table.span,
                        visibility: DiagnosticVisibility.PublicRedacted,
                        publicMessage: "Query violates tenant scoping requirements.",
                    }),
                );
                continue;
            }

            if (!classification.rule) {
                continue;
            }

            const expectedLiteral = normalizePolicyValue(
                getTenantScopeContextValue(contextValues, classification.rule.contextKey),
            );

            const guardExpression =
                select.from?.alias === table.alias
                    ? select.where
                    : select.joins.find((join) => join.table.alias === table.alias)?.on;

            if (
                hasRequiredTenantScope(
                    guardExpression,
                    table.alias,
                    classification.rule.scopeColumn,
                    expectedLiteral,
                )
            ) {
                continue;
            }

            diagnostics.push(
                createDiagnostic({
                    code: DiagnosticCode.PolicyViolation,
                    stage: CompilerStage.Enforcer,
                    message: `Policy "${this.name}" requires ${table.alias}.${classification.rule.scopeColumn} to be scoped.`,
                    primarySpan: table.span,
                    visibility: DiagnosticVisibility.PublicRedacted,
                    publicMessage: "Query violates tenant scoping requirements.",
                }),
            );
        }

        return diagnostics;
    }

    #rewriteExpression(
        expression: NonNullable<SelectStatementAst["where"]>,
        contextValues: ReadonlyMap<string, unknown>,
        visibleCtes: ReadonlySet<string>,
        catalog: Catalog,
    ): ExpressionNode {
        switch (expression.kind) {
            case "BinaryExpression":
                return {
                    ...expression,
                    left: this.#rewriteExpression(
                        expression.left,
                        contextValues,
                        visibleCtes,
                        catalog,
                    ),
                    right: this.#rewriteExpression(
                        expression.right,
                        contextValues,
                        visibleCtes,
                        catalog,
                    ),
                };
            case "UnaryExpression":
                return {
                    ...expression,
                    operand: this.#rewriteExpression(
                        expression.operand,
                        contextValues,
                        visibleCtes,
                        catalog,
                    ),
                };
            case "GroupingExpression":
                return {
                    ...expression,
                    expression: this.#rewriteExpression(
                        expression.expression,
                        contextValues,
                        visibleCtes,
                        catalog,
                    ),
                };
            case "IsNullExpression":
                return {
                    ...expression,
                    operand: this.#rewriteExpression(
                        expression.operand,
                        contextValues,
                        visibleCtes,
                        catalog,
                    ),
                };
            case "InListExpression":
                return {
                    ...expression,
                    operand: this.#rewriteExpression(
                        expression.operand,
                        contextValues,
                        visibleCtes,
                        catalog,
                    ),
                    values: expression.values.map((entry) =>
                        this.#rewriteExpression(entry, contextValues, visibleCtes, catalog),
                    ),
                };
            case "BetweenExpression":
                return {
                    ...expression,
                    operand: this.#rewriteExpression(
                        expression.operand,
                        contextValues,
                        visibleCtes,
                        catalog,
                    ),
                    lower: this.#rewriteExpression(
                        expression.lower,
                        contextValues,
                        visibleCtes,
                        catalog,
                    ),
                    upper: this.#rewriteExpression(
                        expression.upper,
                        contextValues,
                        visibleCtes,
                        catalog,
                    ),
                };
            case "InSubqueryExpression":
                return {
                    ...expression,
                    operand: this.#rewriteExpression(
                        expression.operand,
                        contextValues,
                        visibleCtes,
                        catalog,
                    ),
                    query: this.#rewriteQuery(
                        expression.query,
                        contextValues,
                        visibleCtes,
                        catalog,
                    ),
                };
            case "ExistsExpression":
                return {
                    ...expression,
                    query: this.#rewriteQuery(
                        expression.query,
                        contextValues,
                        visibleCtes,
                        catalog,
                    ),
                };
            case "ScalarSubqueryExpression":
                return {
                    ...expression,
                    query: this.#rewriteQuery(
                        expression.query,
                        contextValues,
                        visibleCtes,
                        catalog,
                    ),
                };
            case "FunctionCall":
                return {
                    ...expression,
                    arguments: expression.arguments.map((arg) =>
                        this.#rewriteExpression(arg, contextValues, visibleCtes, catalog),
                    ),
                    over: expression.over
                        ? {
                              ...expression.over,
                              partitionBy: expression.over.partitionBy.map((value) =>
                                  this.#rewriteExpression(
                                      value,
                                      contextValues,
                                      visibleCtes,
                                      catalog,
                                  ),
                              ),
                              orderBy: expression.over.orderBy.map((item) => ({
                                  ...item,
                                  expression: this.#rewriteExpression(
                                      item.expression,
                                      contextValues,
                                      visibleCtes,
                                      catalog,
                                  ),
                              })),
                          }
                        : undefined,
                };
            case "CastExpression":
                return {
                    ...expression,
                    expression: this.#rewriteExpression(
                        expression.expression,
                        contextValues,
                        visibleCtes,
                        catalog,
                    ),
                };
            case "CaseExpression":
                return {
                    ...expression,
                    operand: expression.operand
                        ? this.#rewriteExpression(
                              expression.operand,
                              contextValues,
                              visibleCtes,
                              catalog,
                          )
                        : undefined,
                    whenClauses: expression.whenClauses.map((clause) => ({
                        ...clause,
                        when: this.#rewriteExpression(
                            clause.when,
                            contextValues,
                            visibleCtes,
                            catalog,
                        ),
                        then: this.#rewriteExpression(
                            clause.then,
                            contextValues,
                            visibleCtes,
                            catalog,
                        ),
                    })),
                    elseExpression: expression.elseExpression
                        ? this.#rewriteExpression(
                              expression.elseExpression,
                              contextValues,
                              visibleCtes,
                              catalog,
                          )
                        : undefined,
                };
            case "IntervalExpression":
                return {
                    ...expression,
                    value: this.#rewriteExpression(
                        expression.value,
                        contextValues,
                        visibleCtes,
                        catalog,
                    ),
                };
            case "Literal":
            case "Parameter":
            case "IdentifierExpression":
            case "QualifiedReference":
            case "WildcardExpression":
            case "CurrentKeywordExpression":
                return expression;
        }
    }

    #rewriteTableReference(
        table: TableReferenceNode,
        contextValues: ReadonlyMap<string, unknown>,
        visibleCtes: ReadonlySet<string>,
        catalog: Catalog,
    ): TableReferenceNode {
        if (table.kind !== "DerivedTableReference") {
            return table;
        }

        return {
            ...table,
            subquery: this.#rewriteQuery(table.subquery, contextValues, visibleCtes, catalog),
        };
    }

    #resolveScopedTableAlias(
        table: TableReferenceNode,
        visibleCtes: ReadonlySet<string>,
        catalog: Catalog,
    ): { alias: string; span: SourceSpan; rule: TenantScopeRule } | undefined {
        if (table.kind !== "TableReference") {
            return undefined;
        }

        const originalPath = table.name.parts.map((part) => normalizeIdentifier(part.name));
        const originalName = normalizeIdentifier(
            table.name.parts[table.name.parts.length - 1]?.name ?? "",
        );
        const match = collectTenantScopeMatchFromAst(table, catalog, this.#scopeRules);
        const matchedRules = dedupeTenantScopeRules([...match.exactRules, ...match.shortRules]);
        const matchedRule = match.exactRules[0];
        if (!matchedRule) {
            if (match.schemaQualified && match.shortRules.length > 0) {
                throw new PolicyDiagnosticError(
                    createDiagnostic({
                        code: DiagnosticCode.InvalidPolicyConfiguration,
                        stage: CompilerStage.Rewriter,
                        message: `Policy "${this.name}" requires schema-qualified table "${match.canonicalName}" to be configured using its full name.`,
                        primarySpan: table.span,
                    }),
                    { policyName: this.name },
                );
            }
            return undefined;
        }

        this.#assertUnambiguousScopeMatch(matchedRules, table.span, match.names);

        if (originalPath.length === 1 && visibleCtes.has(originalName)) {
            throw new PolicyDiagnosticError(
                createDiagnostic({
                    code: DiagnosticCode.PolicyViolation,
                    stage: CompilerStage.Rewriter,
                    message: `Policy "${this.name}" rejects CTE shadowing for scoped table "${originalName}".`,
                    primarySpan: table.span,
                    visibility: DiagnosticVisibility.PublicRedacted,
                    publicMessage: "Query violates tenant scoping requirements.",
                }),
                { policyName: this.name },
            );
        }

        return {
            alias: normalizeIdentifier(table.alias?.name ?? originalName),
            span: table.span,
            rule: matchedRule,
        };
    }

    #classifyBoundTable(table: BoundTableReference):
        | { matched: false; shadowed: false }
        | {
              matched: true;
              shadowed: boolean;
              name?: string;
              rule?: TenantScopeRule;
              ambiguous?: readonly string[];
              requiresQualifiedName?: boolean;
          } {
        const match = collectTenantScopeMatchFromBound(table, this.#scopeRules);
        const matchedRules = dedupeTenantScopeRules([...match.exactRules, ...match.shortRules]);
        const matchedRule = match.exactRules[0];
        if (!matchedRule) {
            if (match.schemaQualified && match.shortRules.length > 0) {
                return {
                    matched: true,
                    shadowed: false,
                    name: match.canonicalName,
                    requiresQualifiedName: true,
                };
            }
            return {
                matched: false,
                shadowed: false,
            };
        }

        if (matchedRules.length > 1) {
            return {
                matched: true,
                shadowed: false,
                ambiguous: match.names,
            };
        }

        const matchedName = match.names.find((name) => matchedRule.tables.has(name));

        return {
            matched: true,
            shadowed: table.source !== "catalog",
            name: matchedName,
            rule: matchedRule,
        };
    }

    #assertUnambiguousScopeMatch(
        matchedRules: readonly TenantScopeRule[],
        span: SourceSpan,
        names: readonly string[],
    ): void {
        if (matchedRules.length <= 1) {
            return;
        }

        throw new PolicyDiagnosticError(
            createDiagnostic({
                code: DiagnosticCode.InvalidPolicyConfiguration,
                stage: CompilerStage.Rewriter,
                message: `Policy "${this.name}" matched ${names.join(", ")} against more than one tenant scope rule.`,
                primarySpan: span,
            }),
            { policyName: this.name },
        );
    }
}

function createTenantPredicate(
    alias: string,
    column: string,
    value: unknown,
    span: SourceSpan,
): ExpressionNode {
    const left = createQualifiedReference(alias, column, span);
    if (value === null) {
        return {
            kind: "IsNullExpression",
            span: left.span,
            operand: left,
            negated: false,
        } satisfies IsNullExpressionNode;
    }

    const right = createPolicyValueExpression(value, span);
    return {
        kind: "BinaryExpression",
        span: mergeSpans(left.span, right.span),
        operator: "=",
        left,
        right,
    };
}

function combinePredicates(
    expressions: readonly NonNullable<SelectStatementAst["where"]>[],
): NonNullable<SelectStatementAst["where"]> {
    const [first, ...rest] = expressions;
    if (!first) {
        throw new PolicyUsageError(
            'Policy "tenant-scoping" cannot combine an empty predicate list.',
            { policyName: "tenant-scoping" },
        );
    }

    return rest.reduce<NonNullable<SelectStatementAst["where"]>>(
        (left, right) => ({
            kind: "BinaryExpression",
            span: mergeSpans(left.span, right.span),
            operator: "AND",
            left,
            right,
        }),
        first,
    );
}

function createQualifiedReference(
    alias: string,
    column: string,
    span: SourceSpan,
): QualifiedReferenceNode {
    return {
        kind: "QualifiedReference",
        span,
        qualifier: createIdentifier(alias, span),
        column: createIdentifier(column, span),
    };
}

function createIdentifier(name: string, span: SourceSpan): IdentifierNode {
    return markTrustedAstNode({
        kind: "Identifier",
        span,
        name,
        quoted: false,
    } as IdentifierNode);
}

function createPolicyValueExpression(value: unknown, span: SourceSpan): LiteralNode {
    if (
        typeof value === "string" ||
        typeof value === "boolean" ||
        value === null ||
        typeof value === "number" ||
        typeof value === "bigint"
    ) {
        return createLiteral(value, span);
    }

    throw new PolicyUsageError(
        'Policy "tenant-scoping" only supports string, number, bigint, boolean, or null tenant values.',
        { policyName: "tenant-scoping" },
    );
}

function createLiteral(
    value: string | number | bigint | boolean | null,
    span: SourceSpan,
): LiteralNode {
    if (typeof value === "bigint") {
        assertPositiveUint64(value);
        return {
            kind: "Literal",
            span,
            literalType: "integer",
            value: value.toString(),
        };
    }

    if (typeof value === "number") {
        assertFiniteNumber(value);
        assertSafeIntegerLiteral(value);
        return {
            kind: "Literal",
            span,
            literalType: Number.isInteger(value) ? "integer" : "decimal",
            value: String(value),
        };
    }

    if (typeof value === "string") {
        return {
            kind: "Literal",
            span,
            literalType: "string",
            value,
        };
    }

    if (typeof value === "boolean") {
        return {
            kind: "Literal",
            span,
            literalType: "boolean",
            value,
        };
    }

    return {
        kind: "Literal",
        span,
        literalType: "null",
        value: null,
    };
}

function assertPositiveUint64(value: bigint): void {
    if (value < MIN_POSITIVE_UINT64 || value > MAX_UINT64) {
        throw new PolicyUsageError(
            `Policy "${TENANT_SCOPING_POLICY_NAME}" requires bigint tenant values to be positive integers within uint64 range.`,
            { policyName: TENANT_SCOPING_POLICY_NAME },
        );
    }
}

function assertFiniteNumber(value: number): void {
    if (!Number.isFinite(value)) {
        throw new PolicyUsageError(
            `Policy "${TENANT_SCOPING_POLICY_NAME}" requires number tenant values to be finite.`,
            { policyName: TENANT_SCOPING_POLICY_NAME },
        );
    }
}

function assertSafeIntegerLiteral(value: number): void {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new PolicyUsageError(
            `Policy "${TENANT_SCOPING_POLICY_NAME}" requires integer tenant values outside the safe JavaScript number range to be passed as bigint.`,
            { policyName: TENANT_SCOPING_POLICY_NAME },
        );
    }
}

function hasRequiredTenantScope(
    expression: BoundExpression | undefined,
    alias: string,
    column: string,
    expectedValue: string | boolean | null,
): boolean {
    if (!expression) {
        return false;
    }

    if (isTenantComparison(expression, alias, column, expectedValue)) {
        return true;
    }

    switch (expression.kind) {
        case "BoundBinaryExpression":
            if (expression.operator === "AND") {
                return (
                    hasRequiredTenantScope(expression.left, alias, column, expectedValue) ||
                    hasRequiredTenantScope(expression.right, alias, column, expectedValue)
                );
            }

            if (expression.operator === "OR") {
                return (
                    hasRequiredTenantScope(expression.left, alias, column, expectedValue) &&
                    hasRequiredTenantScope(expression.right, alias, column, expectedValue)
                );
            }

            return false;
        case "BoundGroupingExpression":
            return hasRequiredTenantScope(expression.expression, alias, column, expectedValue);
        default:
            return false;
    }
}

function isTenantComparison(
    expression: BoundExpression,
    alias: string,
    column: string,
    expectedValue: string | boolean | null,
): boolean {
    if (expectedValue === null) {
        return (
            expression.kind === "BoundIsNullExpression" &&
            !expression.negated &&
            isScopedColumnReference(expression.operand, alias, column)
        );
    }

    if (expression.kind !== "BoundBinaryExpression" || expression.operator !== "=") {
        return false;
    }

    return (
        (isScopedColumnReference(expression.left, alias, column) &&
            isExpectedLiteral(expression.right, expectedValue)) ||
        (isScopedColumnReference(expression.right, alias, column) &&
            isExpectedLiteral(expression.left, expectedValue))
    );
}

function isScopedColumnReference(
    expression: BoundExpression,
    alias: string,
    column: string,
): boolean {
    return (
        expression.kind === "BoundColumnReference" &&
        expression.table.alias === alias &&
        expression.column.name === column
    );
}

function isExpectedLiteral(
    expression: BoundExpression,
    expectedValue: string | boolean | null,
): boolean {
    return (
        expression.kind === "BoundLiteral" &&
        normalizePolicyValue(expression.value) === expectedValue
    );
}

function normalizePolicyValue(value: unknown): string | boolean | null {
    if (typeof value === "bigint") {
        assertPositiveUint64(value);
        return value.toString();
    }

    if (typeof value === "number") {
        assertFiniteNumber(value);
        assertSafeIntegerLiteral(value);
        return String(value);
    }

    if (typeof value === "string" || typeof value === "boolean" || value === null) {
        return value;
    }

    throw new PolicyUsageError(
        'Policy "tenant-scoping" only supports string, number, bigint, boolean, or null tenant values.',
        { policyName: TENANT_SCOPING_POLICY_NAME },
    );
}

function validateTenantScopeRules(
    options: TenantScopingPolicyOptions,
    policyName: string,
): readonly TenantScopeRule[] {
    const scopeOptions = normalizeTenantScopeOptions(options, policyName);
    const configuredTables = new Set<string>();

    return scopeOptions.map((scope, index) => {
        const tables = validateScopedTables(scope.tables);
        for (const table of tables) {
            if (configuredTables.has(table)) {
                throw new PolicyConfigurationError(
                    `Policy "${policyName}" does not allow table "${table}" to be configured in more than one scope rule.`,
                    { policyName },
                );
            }
            configuredTables.add(table);
        }

        return {
            tables,
            scopeColumn: validatePolicyIdentifier(
                scope.scopeColumn,
                `scopes[${index}].scopeColumn`,
                policyName,
                { allowQualified: false },
            ),
            contextKey: validateContextKey(scope.contextKey, policyName),
        };
    });
}

function normalizeTenantScopeOptions(
    options: TenantScopingPolicyOptions,
    policyName: string,
): readonly TenantScopingScopeOptions[] {
    if ("scopes" in options) {
        if (!Array.isArray(options.scopes) || options.scopes.length === 0) {
            throw new PolicyConfigurationError(
                `Policy "${policyName}" requires a non-empty scopes list.`,
                { policyName },
            );
        }

        return options.scopes;
    }

    return [options];
}

function validateScopedTables(tables: readonly string[]): ReadonlySet<string> {
    if (!Array.isArray(tables) || tables.length === 0) {
        throw new PolicyConfigurationError(
            'Policy "tenant-scoping" requires a non-empty tables list.',
            { policyName: TENANT_SCOPING_POLICY_NAME },
        );
    }

    return new Set(
        tables.map((table) =>
            validatePolicyIdentifier(table, "tables", TENANT_SCOPING_POLICY_NAME),
        ),
    );
}

function validatePolicyIdentifier(
    value: string,
    field: string,
    policyName: string,
    options: { allowQualified?: boolean } = {},
): string {
    if (typeof value !== "string") {
        throw new PolicyConfigurationError(
            `Policy "${policyName}" requires ${field} to be a string.`,
            { policyName },
        );
    }

    const normalized = normalizeIdentifier(value.trim());
    if (!normalized) {
        throw new PolicyConfigurationError(
            `Policy "${policyName}" does not accept an empty ${field} value.`,
            { policyName },
        );
    }

    const parts = normalized.split(".");
    if (
        parts.length === 0 ||
        !parts.every((part) => POLICY_IDENTIFIER_SEGMENT_PATTERN.test(part)) ||
        (options.allowQualified === false && parts.length !== 1)
    ) {
        throw new PolicyConfigurationError(
            `Policy "${policyName}" requires ${field} to contain only unquoted identifier segments.`,
            { policyName },
        );
    }

    return normalized;
}

function validateContextKey(value: string, policyName: string): string {
    if (typeof value !== "string") {
        throw new PolicyConfigurationError(
            `Policy "${policyName}" requires contextKey to be a string.`,
            { policyName },
        );
    }

    const trimmed = value.trim();
    if (!trimmed) {
        throw new PolicyConfigurationError(
            `Policy "${policyName}" does not accept an empty contextKey value.`,
            { policyName },
        );
    }

    return trimmed;
}

function resolveTenantScopeContextValues(
    rules: readonly TenantScopeRule[],
    context: Readonly<Record<string, unknown>>,
    stage: "rewrite" | "enforce",
): ReadonlyMap<string, unknown> {
    const values = new Map<string, unknown>();

    for (const rule of rules) {
        if (values.has(rule.contextKey)) {
            continue;
        }

        const value = context[rule.contextKey];
        if (typeof value === "undefined") {
            throw new PolicyUsageError(
                stage === "rewrite"
                    ? `Policy "${TENANT_SCOPING_POLICY_NAME}" requires policyContext.${rule.contextKey} to rewrite tenant predicates.`
                    : `Policy "${TENANT_SCOPING_POLICY_NAME}" requires policyContext.${rule.contextKey}.`,
                { policyName: TENANT_SCOPING_POLICY_NAME },
            );
        }

        values.set(rule.contextKey, value);
    }

    return values;
}

function getTenantScopeContextValue(
    contextValues: ReadonlyMap<string, unknown>,
    contextKey: string,
): unknown {
    const value = contextValues.get(contextKey);
    if (!contextValues.has(contextKey)) {
        throw new PolicyUsageError(
            `Policy "${TENANT_SCOPING_POLICY_NAME}" requires policyContext.${contextKey}.`,
            { policyName: TENANT_SCOPING_POLICY_NAME },
        );
    }

    return value;
}

function matchTenantScopeRules(
    rules: readonly TenantScopeRule[],
    names: readonly string[],
): readonly TenantScopeRule[] {
    return rules.filter((rule) => names.some((name) => rule.tables.has(name)));
}

function collectTenantScopeMatchFromAst(
    table: NamedTableReferenceNode,
    catalog: Catalog,
    rules: readonly TenantScopeRule[],
): TenantScopeMatch {
    const originalPath = table.name.parts.map((part) => normalizeIdentifier(part.name));
    const originalQualified = originalPath.join(".");
    const originalName = originalPath[originalPath.length - 1] ?? originalQualified;
    const resolved = catalog.getTable({ parts: originalPath });
    const canonicalPath = resolved?.path.parts ?? originalPath;
    const canonicalName = canonicalPath.join(".");
    const canonicalShortName = canonicalPath[canonicalPath.length - 1] ?? canonicalName;
    const schemaQualified = (resolved?.path.parts.length ?? originalPath.length) > 1;
    const exactNames = uniqueNames([originalQualified, canonicalName]);
    const shortNames = schemaQualified ? uniqueNames([originalName, canonicalShortName]) : [];

    return {
        exactRules: matchTenantScopeRules(rules, exactNames),
        shortRules: matchTenantScopeRules(rules, shortNames),
        names: uniqueNames([...exactNames, ...shortNames]),
        canonicalName,
        schemaQualified,
    };
}

function collectTenantScopeMatchFromBound(
    table: BoundTableReference,
    rules: readonly TenantScopeRule[],
): TenantScopeMatch {
    const canonicalPath = table.table.path.parts.map((part) => normalizeIdentifier(part));
    const canonicalName = canonicalPath.join(".");
    const canonicalShortName = canonicalPath[canonicalPath.length - 1] ?? canonicalName;
    const astName =
        table.ast.kind === "TableReference"
            ? table.ast.name.parts.map((part) => normalizeIdentifier(part.name)).join(".")
            : undefined;
    const shortName =
        table.ast.kind === "TableReference"
            ? normalizeIdentifier(
                  table.ast.name.parts[table.ast.name.parts.length - 1]?.name ?? table.table.name,
              )
            : normalizeIdentifier(table.table.name);
    const schemaQualified = table.source === "catalog" && table.table.path.parts.length > 1;
    const exactNames = uniqueNames(
        schemaQualified ? [canonicalName, astName] : [canonicalName, astName, shortName],
    );
    const shortNames = schemaQualified ? uniqueNames([shortName, canonicalShortName]) : [];

    return {
        exactRules: matchTenantScopeRules(rules, exactNames),
        shortRules: matchTenantScopeRules(rules, shortNames),
        names: uniqueNames([...exactNames, ...shortNames]),
        canonicalName,
        schemaQualified,
    };
}

function uniqueNames(names: readonly (string | undefined)[]): readonly string[] {
    return [
        ...new Set(
            names.filter((name): name is string => typeof name === "string" && name.length > 0),
        ),
    ];
}

function dedupeTenantScopeRules(rules: readonly TenantScopeRule[]): readonly TenantScopeRule[] {
    return [...new Set(rules)];
}
