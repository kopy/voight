import type {
    BetweenExpressionNode,
    BinaryExpressionNode,
    BoundBetweenExpression,
    BoundBinaryExpression,
    BoundCaseExpression,
    BoundCaseWhenClause,
    BoundColumnReference,
    BoundCurrentKeywordExpression,
    BoundCastExpression,
    BoundExistsExpression,
    BoundExpression,
    BoundFunctionCall,
    BoundGroupingExpression,
    BoundIntervalExpression,
    BoundInListExpression,
    BoundInSubqueryExpression,
    BoundIsNullExpression,
    BoundLimitClause,
    BoundLiteral,
    BoundOrderByItem,
    BoundParameter,
    BoundQuery,
    BoundScalarSubqueryExpression,
    BoundTableReference,
    BoundUnaryExpression,
    BoundWildcardExpression,
    BoundWindowSpecification,
    CaseExpressionNode,
    CastExpressionNode,
    CastTypeNode,
    ExistsExpressionNode,
    ExpressionNode,
    GroupingExpressionNode,
    IdentifierNode,
    IdentifierExpressionNode,
    InListExpressionNode,
    InSubqueryExpressionNode,
    IntervalExpressionNode,
    IsNullExpressionNode,
    QualifiedReferenceNode,
    QueryAst,
    ScalarSubqueryExpressionNode,
    UnaryExpressionNode,
    WildcardExpressionNode,
    WindowSpecificationNode,
} from "../ast";
import { normalizeIdentifier, type Catalog } from "../catalog";
import { isTrustedAstNode } from "../compiler/trusted-ast";
import {
    CompilerStage,
    DiagnosticCode,
    DiagnosticVisibility,
    createDiagnostic,
} from "../core/diagnostics";
import { stageFailure, stageSuccess, type StageResult } from "../core/result";
import type { SourceSpan } from "../core/source";

const RAW_SQL_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_$]*$/;

export type BindResult<T> = StageResult<T, CompilerStage.Binder, { scopeSize: number }>;

export interface BinderExpressionContext {
    readonly catalog: Catalog;
    readonly resolveSelectAliases: boolean;
    scopeSize(): number;
    bindExpression(node: ExpressionNode): BindResult<BoundExpression>;
    bindSubquery(query: QueryAst): BindResult<BoundQuery>;
    resolveTableAlias(alias: string, span: SourceSpan): BindResult<BoundTableReference>;
    visibleTables(): BoundTableReference[];
    selectAlias(name: string): BoundExpression | undefined;
    fail(code: DiagnosticCode, message: string, span: SourceSpan): BindResult<never>;
}

export function bindExpressionNode(
    context: BinderExpressionContext,
    node: ExpressionNode,
): BindResult<BoundExpression> {
    switch (node.kind) {
        case "Literal":
            return stageSuccess(
                CompilerStage.Binder,
                {
                    kind: "BoundLiteral",
                    span: node.span,
                    ast: node,
                    literalType: node.literalType,
                    value: node.value,
                } satisfies BoundLiteral,
                { scopeSize: context.scopeSize() },
            );
        case "Parameter":
            return stageSuccess(
                CompilerStage.Binder,
                {
                    kind: "BoundParameter",
                    span: node.span,
                    ast: node,
                    index: node.index,
                } satisfies BoundParameter,
                { scopeSize: context.scopeSize() },
            );
        case "IdentifierExpression":
            if (context.resolveSelectAliases) {
                const alias = context.selectAlias(normalizeIdentifier(node.identifier.name));
                if (alias) {
                    return stageSuccess(CompilerStage.Binder, alias, {
                        scopeSize: context.scopeSize(),
                    });
                }
            }
            return bindUnqualifiedColumn(context, node);
        case "QualifiedReference":
            return bindQualifiedColumn(context, node);
        case "UnaryExpression":
            return bindUnary(context, node);
        case "BinaryExpression":
            return bindBinary(context, node);
        case "FunctionCall":
            return bindFunction(context, node);
        case "CastExpression":
            return bindCast(context, node);
        case "CaseExpression":
            return bindCase(context, node);
        case "IntervalExpression":
            return bindInterval(context, node);
        case "GroupingExpression":
            return bindGrouping(context, node);
        case "WildcardExpression":
            return bindWildcard(context, node);
        case "IsNullExpression":
            return bindIsNull(context, node);
        case "CurrentKeywordExpression":
            return stageSuccess(
                CompilerStage.Binder,
                {
                    kind: "BoundCurrentKeywordExpression",
                    span: node.span,
                    ast: node,
                    keyword: node.keyword,
                } satisfies BoundCurrentKeywordExpression,
                { scopeSize: context.scopeSize() },
            );
        case "BetweenExpression":
            return bindBetween(context, node);
        case "InListExpression":
            return bindInList(context, node);
        case "InSubqueryExpression":
            return bindInSubquery(context, node);
        case "ExistsExpression":
            return bindExists(context, node);
        case "ScalarSubqueryExpression":
            return bindScalarSubquery(context, node);
    }
}

export function bindLimitClause(
    context: BinderExpressionContext,
    node: BoundLimitClause["ast"],
): BindResult<BoundLimitClause> {
    const count = context.bindExpression(node.count);
    if (!count.ok) {
        return count;
    }

    const offset = node.offset ? context.bindExpression(node.offset) : undefined;
    if (offset && !offset.ok) {
        return offset;
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundLimitClause",
            span: node.span,
            ast: node,
            count: count.value,
            offset: offset?.value,
        },
        { scopeSize: context.scopeSize() },
    );
}

export function bindOrderByExpressionNode(
    context: BinderExpressionContext,
    node: ExpressionNode,
): BindResult<BoundExpression> {
    return context.bindExpression(node);
}

function bindUnary(
    context: BinderExpressionContext,
    node: UnaryExpressionNode,
): BindResult<BoundUnaryExpression> {
    const operand = context.bindExpression(node.operand);
    if (!operand.ok) {
        return operand;
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundUnaryExpression",
            span: node.span,
            ast: node,
            operator: node.operator,
            operand: operand.value,
        },
        { scopeSize: context.scopeSize() },
    );
}

function bindBinary(
    context: BinderExpressionContext,
    node: BinaryExpressionNode,
): BindResult<BoundBinaryExpression> {
    const left = context.bindExpression(node.left);
    if (!left.ok) {
        return left;
    }

    const right = context.bindExpression(node.right);
    if (!right.ok) {
        return right;
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundBinaryExpression",
            span: node.span,
            ast: node,
            operator: node.operator,
            left: left.value,
            right: right.value,
        },
        { scopeSize: context.scopeSize() },
    );
}

function bindFunction(
    context: BinderExpressionContext,
    node: BoundFunctionCall["ast"],
): BindResult<BoundFunctionCall> {
    const callee = normalizeIdentifier(node.callee.name);
    if (!isSafeRawSqlIdentifier(node.callee, callee)) {
        return context.fail(
            DiagnosticCode.UnsupportedConstruct,
            "Function names must be unquoted simple identifiers.",
            node.callee.span,
        );
    }

    const args: BoundExpression[] = [];
    for (const arg of node.arguments) {
        const bound = context.bindExpression(arg);
        if (!bound.ok) {
            return bound;
        }
        args.push(bound.value);
    }

    const wildcardArgument = args.find(
        (arg): arg is BoundWildcardExpression => arg.kind === "BoundWildcardExpression",
    );
    if (wildcardArgument) {
        if (node.distinct) {
            return context.fail(
                DiagnosticCode.UnsupportedConstruct,
                "DISTINCT wildcard arguments are not supported in functions.",
                wildcardArgument.span,
            );
        }

        if (callee !== "count") {
            return context.fail(
                DiagnosticCode.UnsupportedConstruct,
                `Function "${callee}" does not support wildcard arguments. Only COUNT(*) is allowed.`,
                wildcardArgument.span,
            );
        }

        if (args.length !== 1) {
            return context.fail(
                DiagnosticCode.UnsupportedConstruct,
                "COUNT(*) must be used as the function's only argument.",
                wildcardArgument.span,
            );
        }

        if (wildcardArgument.table) {
            return context.fail(
                DiagnosticCode.UnsupportedConstruct,
                "Qualified wildcard arguments are not supported in functions. Use COUNT(*) instead of COUNT(alias.*).",
                wildcardArgument.span,
            );
        }
    }

    const over = node.over ? bindWindowSpecification(context, node.over) : undefined;
    if (over && !over.ok) {
        return over;
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundFunctionCall",
            span: node.span,
            ast: node,
            callee,
            distinct: node.distinct,
            arguments: args,
            over: over?.value,
        },
        { scopeSize: context.scopeSize() },
    );
}

function bindWindowSpecification(
    context: BinderExpressionContext,
    node: WindowSpecificationNode,
): BindResult<BoundWindowSpecification> {
    const partitionBy: BoundExpression[] = [];
    for (const expression of node.partitionBy) {
        const bound = context.bindExpression(expression);
        if (!bound.ok) {
            return bound;
        }
        partitionBy.push(bound.value);
    }

    const orderBy: BoundOrderByItem[] = [];
    for (const item of node.orderBy) {
        const bound = context.bindExpression(item.expression);
        if (!bound.ok) {
            return bound;
        }
        orderBy.push({
            kind: "BoundOrderByItem",
            span: item.span,
            ast: item,
            expression: bound.value,
            direction: item.direction,
        });
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundWindowSpecification",
            span: node.span,
            ast: node,
            partitionBy,
            orderBy,
        },
        { scopeSize: context.scopeSize() },
    );
}

function bindCast(
    context: BinderExpressionContext,
    node: CastExpressionNode,
): BindResult<BoundCastExpression> {
    const unsafeTypeIdentifier = findUnsafeCastTypeIdentifier(node.targetType);
    if (unsafeTypeIdentifier) {
        return context.fail(
            DiagnosticCode.UnsupportedConstruct,
            "CAST target type names must be unquoted simple identifiers.",
            unsafeTypeIdentifier.span,
        );
    }

    const expression = context.bindExpression(node.expression);
    if (!expression.ok) {
        return expression;
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundCastExpression",
            span: node.span,
            ast: node,
            expression: expression.value,
            targetType: node.targetType,
        } satisfies BoundCastExpression,
        { scopeSize: context.scopeSize() },
    );
}

function findUnsafeCastTypeIdentifier(type: CastTypeNode): IdentifierNode | undefined {
    for (const part of type.name.parts) {
        if (!isSafeRawSqlIdentifier(part, normalizeIdentifier(part.name))) {
            return part;
        }
    }

    for (const argument of type.arguments) {
        if (argument.kind === "CastType") {
            const unsafe = findUnsafeCastTypeIdentifier(argument);
            if (unsafe) {
                return unsafe;
            }
        }
    }

    return undefined;
}

function isSafeRawSqlIdentifier(identifier: IdentifierNode, normalized: string): boolean {
    return !identifier.quoted && RAW_SQL_IDENTIFIER_PATTERN.test(normalized);
}

function bindCase(
    context: BinderExpressionContext,
    node: CaseExpressionNode,
): BindResult<BoundCaseExpression> {
    const operand = node.operand ? context.bindExpression(node.operand) : undefined;
    if (operand && !operand.ok) {
        return operand;
    }

    const whenClauses: BoundCaseWhenClause[] = [];
    for (const clause of node.whenClauses) {
        const when = context.bindExpression(clause.when);
        if (!when.ok) {
            return when;
        }

        const then = context.bindExpression(clause.then);
        if (!then.ok) {
            return then;
        }

        whenClauses.push({
            kind: "BoundCaseWhenClause",
            span: clause.span,
            ast: clause,
            when: when.value,
            then: then.value,
        });
    }

    const elseExpression = node.elseExpression
        ? context.bindExpression(node.elseExpression)
        : undefined;
    if (elseExpression && !elseExpression.ok) {
        return elseExpression;
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundCaseExpression",
            span: node.span,
            ast: node,
            operand: operand?.value,
            whenClauses,
            elseExpression: elseExpression?.value,
        } satisfies BoundCaseExpression,
        { scopeSize: context.scopeSize() },
    );
}

function bindInterval(
    context: BinderExpressionContext,
    node: IntervalExpressionNode,
): BindResult<BoundIntervalExpression> {
    const value = context.bindExpression(node.value);
    if (!value.ok) {
        return value;
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundIntervalExpression",
            span: node.span,
            ast: node,
            value: value.value,
            unit: node.unit,
        } satisfies BoundIntervalExpression,
        { scopeSize: context.scopeSize() },
    );
}

function bindGrouping(
    context: BinderExpressionContext,
    node: GroupingExpressionNode,
): BindResult<BoundGroupingExpression> {
    const expression = context.bindExpression(node.expression);
    if (!expression.ok) {
        return expression;
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundGroupingExpression",
            span: node.span,
            ast: node,
            expression: expression.value,
        },
        { scopeSize: context.scopeSize() },
    );
}

function bindWildcard(
    context: BinderExpressionContext,
    node: WildcardExpressionNode,
): BindResult<BoundWildcardExpression> {
    const table = node.qualifier
        ? context.resolveTableAlias(node.qualifier.name, node.qualifier.span)
        : undefined;
    if (table && !table.ok) {
        return table;
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundWildcardExpression",
            span: node.span,
            ast: node,
            table: table?.value,
        },
        { scopeSize: context.scopeSize() },
    );
}

function bindIsNull(
    context: BinderExpressionContext,
    node: IsNullExpressionNode,
): BindResult<BoundIsNullExpression> {
    const operand = context.bindExpression(node.operand);
    if (!operand.ok) {
        return operand;
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundIsNullExpression",
            span: node.span,
            ast: node,
            operand: operand.value,
            negated: node.negated,
        },
        { scopeSize: context.scopeSize() },
    );
}

function bindBetween(
    context: BinderExpressionContext,
    node: BetweenExpressionNode,
): BindResult<BoundBetweenExpression> {
    const operand = context.bindExpression(node.operand);
    if (!operand.ok) {
        return operand;
    }

    const lower = context.bindExpression(node.lower);
    if (!lower.ok) {
        return lower;
    }

    const upper = context.bindExpression(node.upper);
    if (!upper.ok) {
        return upper;
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundBetweenExpression",
            span: node.span,
            ast: node,
            operand: operand.value,
            lower: lower.value,
            upper: upper.value,
            negated: node.negated,
        } satisfies BoundBetweenExpression,
        { scopeSize: context.scopeSize() },
    );
}

function bindInList(
    context: BinderExpressionContext,
    node: InListExpressionNode,
): BindResult<BoundInListExpression> {
    const operand = context.bindExpression(node.operand);
    if (!operand.ok) {
        return operand;
    }

    const values: BoundExpression[] = [];
    for (const value of node.values) {
        const boundValue = context.bindExpression(value);
        if (!boundValue.ok) {
            return boundValue;
        }
        values.push(boundValue.value);
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundInListExpression",
            span: node.span,
            ast: node,
            operand: operand.value,
            values,
            negated: node.negated,
        } satisfies BoundInListExpression,
        { scopeSize: context.scopeSize() },
    );
}

function bindInSubquery(
    context: BinderExpressionContext,
    node: InSubqueryExpressionNode,
): BindResult<BoundInSubqueryExpression> {
    const operand = context.bindExpression(node.operand);
    if (!operand.ok) {
        return operand;
    }

    const query = context.bindSubquery(node.query);
    if (!query.ok) {
        return query;
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundInSubqueryExpression",
            span: node.span,
            ast: node,
            operand: operand.value,
            query: query.value,
            negated: node.negated,
        },
        { scopeSize: context.scopeSize() },
    );
}

function bindExists(
    context: BinderExpressionContext,
    node: ExistsExpressionNode,
): BindResult<BoundExistsExpression> {
    const query = context.bindSubquery(node.query);
    if (!query.ok) {
        return query;
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundExistsExpression",
            span: node.span,
            ast: node,
            query: query.value,
            negated: node.negated,
        },
        { scopeSize: context.scopeSize() },
    );
}

function bindScalarSubquery(
    context: BinderExpressionContext,
    node: ScalarSubqueryExpressionNode,
): BindResult<BoundScalarSubqueryExpression> {
    const query = context.bindSubquery(node.query);
    if (!query.ok) {
        return query;
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundScalarSubqueryExpression",
            span: node.span,
            ast: node,
            query: query.value,
        },
        { scopeSize: context.scopeSize() },
    );
}

function bindQualifiedColumn(
    context: BinderExpressionContext,
    node: QualifiedReferenceNode,
): BindResult<BoundColumnReference> {
    const table = context.resolveTableAlias(node.qualifier.name, node.qualifier.span);
    if (!table.ok) {
        return table;
    }

    const column = context.catalog.resolveColumn(
        table.value.table,
        normalizeIdentifier(node.column.name),
    );
    if (!column) {
        return context.fail(
            DiagnosticCode.UnknownColumn,
            `Unknown column "${node.column.name}" on table "${table.value.alias}".`,
            node.column.span,
        );
    }

    if (column.selectable === false && !isTrustedReferenceNode(node)) {
        return stageFailure(
            CompilerStage.Binder,
            [
                createNonSelectableColumnDiagnostic(
                    `Column "${node.column.name}" is not selectable.`,
                    node.column.span,
                ),
            ],
            { scopeSize: context.scopeSize() },
        );
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundColumnReference",
            span: node.span,
            ast: node,
            table: table.value,
            column,
        },
        { scopeSize: context.scopeSize() },
    );
}

function bindUnqualifiedColumn(
    context: BinderExpressionContext,
    node: IdentifierExpressionNode,
): BindResult<BoundColumnReference> {
    const matches = context
        .visibleTables()
        .map((table) => ({
            table,
            column: context.catalog.resolveColumn(
                table.table,
                normalizeIdentifier(node.identifier.name),
            ),
        }))
        .filter(
            (
                match,
            ): match is {
                table: BoundTableReference;
                column: NonNullable<ReturnType<Catalog["resolveColumn"]>>;
            } => match.column !== null,
        );

    if (matches.length === 0) {
        return context.fail(
            DiagnosticCode.UnknownColumn,
            `Unknown column "${node.identifier.name}".`,
            node.identifier.span,
        );
    }

    if (matches.length > 1) {
        return stageFailure(
            CompilerStage.Binder,
            [
                createDiagnostic({
                    code: DiagnosticCode.AmbiguousColumn,
                    stage: CompilerStage.Binder,
                    message: `Ambiguous column "${node.identifier.name}".`,
                    primarySpan: node.identifier.span,
                    relatedSpans: matches.map((match) => ({
                        message: `Matched table alias "${match.table.alias}".`,
                        span: match.table.span,
                    })),
                }),
            ],
            { scopeSize: context.scopeSize() },
        );
    }

    const match = matches[0]!;
    if (match.column.selectable === false && !isTrustedReferenceNode(node)) {
        return stageFailure(
            CompilerStage.Binder,
            [
                createNonSelectableColumnDiagnostic(
                    `Column "${node.identifier.name}" is not selectable.`,
                    node.identifier.span,
                ),
            ],
            { scopeSize: context.scopeSize() },
        );
    }

    return stageSuccess(
        CompilerStage.Binder,
        {
            kind: "BoundColumnReference",
            span: node.span,
            ast: node,
            table: match.table,
            column: match.column,
        },
        { scopeSize: context.scopeSize() },
    );
}

function createNonSelectableColumnDiagnostic(message: string, span: SourceSpan) {
    return createDiagnostic({
        code: DiagnosticCode.NonSelectableColumn,
        stage: CompilerStage.Binder,
        message,
        primarySpan: span,
        visibility: DiagnosticVisibility.PublicRedacted,
        publicCode: DiagnosticCode.UnknownColumn,
        publicMessage: "Query references columns that are not available.",
    });
}

function isTrustedReferenceNode(node: IdentifierExpressionNode | QualifiedReferenceNode): boolean {
    if (node.kind === "IdentifierExpression") {
        return isTrustedAstNode(node.identifier);
    }

    return isTrustedAstNode(node.qualifier) || isTrustedAstNode(node.column);
}
