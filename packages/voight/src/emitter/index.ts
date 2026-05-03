import type {
    BinaryExpressionNode,
    BoundExpression,
    BoundQuery,
    BoundSelectStatement,
} from "../ast";
import {
    CompilerStage,
    DiagnosticCode,
    DiagnosticVisibility,
    createDiagnostic,
} from "../core/diagnostics";
import { stageFailure, stageSuccess, type StageResult } from "../core/result";

export interface EmitOptions {
    readonly canonical?: boolean;
}

export interface EmitValue {
    readonly sql: string;
    readonly parameters: readonly number[];
}

export type EmitResult = StageResult<EmitValue, CompilerStage.Emitter, { parameterCount: number }>;

export function emit(statement: BoundQuery, _options: EmitOptions = {}): EmitResult {
    try {
        const parameterIndices: number[] = [];
        const sql = emitBoundQuery(statement, parameterIndices);

        return stageSuccess(
            CompilerStage.Emitter,
            {
                sql,
                parameters: parameterIndices,
            },
            { parameterCount: parameterIndices.length },
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : "Emitter invariant violation.";
        return stageFailure(
            CompilerStage.Emitter,
            [
                createDiagnostic({
                    code: DiagnosticCode.EmitInvariantViolation,
                    stage: CompilerStage.Emitter,
                    message,
                    primarySpan: statement.span,
                    visibility: DiagnosticVisibility.Internal,
                }),
            ],
            { parameterCount: 0 },
        );
    }
}

function emitBoundQuery(query: BoundQuery, parameterIndices: number[]): string {
    const withClause =
        query.with && query.with.ctes.length > 0
            ? `WITH ${query.with.ctes.map((cte) => emitBoundCte(cte, parameterIndices)).join(", ")} `
            : "";
    return `${withClause}${emitBoundSelect(query.body, parameterIndices)}`;
}

function emitBoundCte(
    cte: NonNullable<BoundQuery["with"]>["ctes"][number],
    parameterIndices: number[],
): string {
    const columnList =
        cte.ast.columns.length > 0
            ? ` (${cte.ast.columns.map((column) => quoteIdentifier(column.name)).join(", ")})`
            : "";
    return `${quoteIdentifier(cte.name)}${columnList} AS (${emitBoundQuery(cte.query, parameterIndices)})`;
}

function emitBoundSelect(statement: BoundSelectStatement, parameterIndices: number[]): string {
    const select = statement.selectItems
        .map((item) => {
            if (item.kind === "BoundSelectWildcardItem") {
                return item.columns.map((column) => emitOutputColumn(column)).join(", ");
            }

            return item.alias
                ? `${emitBoundExpression(item.expression, parameterIndices)} AS ${quoteIdentifier(item.alias)}`
                : emitBoundExpression(item.expression, parameterIndices);
        })
        .join(", ");

    const from = statement.from ? ` FROM ${emitBoundTable(statement.from, parameterIndices)}` : "";
    const joins = statement.joins
        .map(
            (join) =>
                `${join.joinType} JOIN ${emitBoundTable(join.table, parameterIndices)} ON ${emitBoundExpression(join.on, parameterIndices)}`,
        )
        .join(" ");
    const where = statement.where
        ? ` WHERE ${emitBoundExpression(statement.where, parameterIndices)}`
        : "";
    const groupBy =
        statement.groupBy.length > 0
            ? ` GROUP BY ${statement.groupBy.map((expr) => emitBoundExpression(expr, parameterIndices)).join(", ")}`
            : "";
    const having = statement.having
        ? ` HAVING ${emitBoundExpression(statement.having, parameterIndices)}`
        : "";
    const orderBy =
        statement.orderBy.length > 0
            ? ` ORDER BY ${statement.orderBy.map((item) => `${emitBoundExpression(item.expression, parameterIndices)} ${item.direction}`).join(", ")}`
            : "";
    const limit = statement.limit ? emitBoundLimit(statement.limit, parameterIndices) : "";

    const distinct = statement.distinct ? "DISTINCT " : "";

    return `SELECT ${distinct}${select}${from}${joins ? ` ${joins}` : ""}${where}${groupBy}${having}${orderBy}${limit}`;
}

function emitOutputColumn(column: BoundQuery["output"][number]): string {
    if (!column.sourceTable) {
        throw new Error(`Cannot emit projected column "${column.name}" without a source table.`);
    }

    return `${quoteIdentifier(column.sourceTable.alias)}.${quoteIdentifier(column.column.name)}`;
}

function emitBoundTable(table: BoundSelectStatement["from"], parameterIndices: number[]): string {
    if (!table) {
        throw new Error("Cannot emit a missing table reference.");
    }

    if (table.source === "derived" && table.subquery) {
        return `(${emitBoundQuery(table.subquery, parameterIndices)}) AS ${quoteIdentifier(table.alias)}`;
    }

    const qualified = table.table.path.parts.map((part) => quoteIdentifier(part)).join(".");
    return table.alias !== table.table.name
        ? `${qualified} AS ${quoteIdentifier(table.alias)}`
        : qualified;
}

function emitBoundLimit(limit: BoundSelectStatement["limit"], parameterIndices: number[]): string {
    if (!limit) {
        return "";
    }

    if (limit.offset) {
        return ` LIMIT ${emitBoundExpression(limit.count, parameterIndices)} OFFSET ${emitBoundExpression(limit.offset, parameterIndices)}`;
    }

    return ` LIMIT ${emitBoundExpression(limit.count, parameterIndices)}`;
}

function emitBoundExpression(expression: BoundExpression, parameterIndices: number[]): string {
    switch (expression.kind) {
        case "BoundLiteral":
            return emitLiteral(expression.value, expression.literalType);
        case "BoundParameter":
            parameterIndices.push(expression.index);
            return "?";
        case "BoundColumnReference":
            return `${quoteIdentifier(expression.table.alias)}.${quoteIdentifier(expression.column.name)}`;
        case "BoundUnaryExpression":
            return expression.operator === "NOT"
                ? `NOT ${emitBoundExpression(expression.operand, parameterIndices)}`
                : `-${emitBoundExpression(expression.operand, parameterIndices)}`;
        case "BoundBinaryExpression":
            return emitBinary(
                emitBoundBinaryOperand(
                    expression.left,
                    expression.operator,
                    parameterIndices,
                    "left",
                ),
                expression.operator,
                emitBoundBinaryOperand(
                    expression.right,
                    expression.operator,
                    parameterIndices,
                    "right",
                ),
            );
        case "BoundFunctionCall":
            return `${expression.callee}(${expression.distinct ? "DISTINCT " : ""}${expression.arguments.map((arg) => emitBoundExpression(arg, parameterIndices)).join(", ")})${expression.over ? ` ${emitWindowSpecification(expression.over, parameterIndices)}` : ""}`;
        case "BoundCastExpression":
            return `CAST(${emitBoundExpression(expression.expression, parameterIndices)} AS ${emitCastType(expression.targetType)})`;
        case "BoundCaseExpression":
            return emitCaseExpression(expression, parameterIndices);
        case "BoundIntervalExpression":
            return `INTERVAL ${emitBoundExpression(expression.value, parameterIndices)} ${expression.unit}`;
        case "BoundGroupingExpression":
            return `(${emitBoundExpression(expression.expression, parameterIndices)})`;
        case "BoundWildcardExpression":
            return expression.table ? `${quoteIdentifier(expression.table.alias)}.*` : "*";
        case "BoundIsNullExpression":
            return `${emitBoundExpression(expression.operand, parameterIndices)} IS ${expression.negated ? "NOT " : ""}NULL`;
        case "BoundCurrentKeywordExpression":
            return expression.keyword;
        case "BoundBetweenExpression":
            return `${emitBetweenOperand(expression.operand, parameterIndices)} ${expression.negated ? "NOT " : ""}BETWEEN ${emitBetweenOperand(expression.lower, parameterIndices)} AND ${emitBetweenOperand(expression.upper, parameterIndices)}`;
        case "BoundInListExpression":
            return `${emitBoundExpression(expression.operand, parameterIndices)} ${expression.negated ? "NOT " : ""}IN (${expression.values.map((value) => emitBoundExpression(value, parameterIndices)).join(", ")})`;
        case "BoundInSubqueryExpression":
            return `${emitBoundExpression(expression.operand, parameterIndices)} ${expression.negated ? "NOT " : ""}IN (${emitBoundQuery(expression.query, parameterIndices)})`;
        case "BoundExistsExpression":
            return `${expression.negated ? "NOT " : ""}EXISTS (${emitBoundQuery(expression.query, parameterIndices)})`;
        case "BoundScalarSubqueryExpression":
            return `(${emitBoundQuery(expression.query, parameterIndices)})`;
    }
}

function emitWindowSpecification(
    specification: Extract<BoundExpression, { kind: "BoundFunctionCall" }>["over"],
    parameterIndices: number[],
): string {
    if (!specification) {
        throw new Error("Cannot emit a missing window specification.");
    }

    const parts = ["OVER ("];

    if (specification.partitionBy.length > 0) {
        parts.push(
            `PARTITION BY ${specification.partitionBy
                .map((expression) => emitBoundExpression(expression, parameterIndices))
                .join(", ")}`,
        );
    }

    if (specification.orderBy.length > 0) {
        const orderBy = specification.orderBy
            .map(
                (item) =>
                    `${emitBoundExpression(item.expression, parameterIndices)} ${item.direction}`,
            )
            .join(", ");
        parts.push(`${specification.partitionBy.length > 0 ? " " : ""}ORDER BY ${orderBy}`);
    }

    parts.push(")");
    return parts.join("");
}

function emitBetweenOperand(expression: BoundExpression, parameterIndices: number[]): string {
    const emitted = emitBoundExpression(expression, parameterIndices);
    switch (expression.kind) {
        case "BoundBinaryExpression":
        case "BoundBetweenExpression":
        case "BoundInListExpression":
        case "BoundInSubqueryExpression":
        case "BoundIsNullExpression":
            return `(${emitted})`;
        default:
            return emitted;
    }
}

function emitCaseExpression(
    expression: Extract<BoundExpression, { kind: "BoundCaseExpression" }>,
    parameterIndices: number[],
): string {
    const parts = ["CASE"];

    if (expression.operand) {
        parts.push(emitBoundExpression(expression.operand, parameterIndices));
    }

    for (const clause of expression.whenClauses) {
        parts.push(
            `WHEN ${emitBoundExpression(clause.when, parameterIndices)} THEN ${emitBoundExpression(clause.then, parameterIndices)}`,
        );
    }

    if (expression.elseExpression) {
        parts.push(`ELSE ${emitBoundExpression(expression.elseExpression, parameterIndices)}`);
    }

    parts.push("END");
    return parts.join(" ");
}

function emitCastType(type: {
    readonly name: { readonly parts: readonly { readonly name: string }[] };
    readonly arguments: readonly (
        | {
              readonly kind: "CastType";
              readonly name: { readonly parts: readonly { readonly name: string }[] };
              readonly arguments: readonly unknown[];
          }
        | { readonly kind: "Literal"; readonly value: string }
    )[];
}): string {
    const name = type.name.parts.map((part) => part.name).join(".");
    if (type.arguments.length === 0) {
        return name;
    }

    return `${name}(${type.arguments.map((argument) => emitCastTypeArgument(argument)).join(", ")})`;
}

function emitCastTypeArgument(argument: {
    readonly kind: string;
    readonly value?: string;
    readonly name?: { readonly parts: readonly { readonly name: string }[] };
    readonly arguments?: readonly unknown[];
}): string {
    if (argument.kind === "Literal") {
        return argument.value ?? "";
    }

    return emitCastType(argument as Parameters<typeof emitCastType>[0]);
}

function emitLiteral(
    value: string | boolean | null,
    literalType?: "string" | "integer" | "decimal" | "boolean" | "null",
): string {
    if (literalType === "integer" || literalType === "decimal") {
        return value as string;
    }

    if (typeof value === "string") {
        return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
    }

    if (typeof value === "boolean") {
        return value ? "TRUE" : "FALSE";
    }

    if (value === null) {
        return "NULL";
    }
    throw new Error("Unsupported literal emission value.");
}

function emitBinary(
    left: string,
    operator: BinaryExpressionNode["operator"],
    right: string,
): string {
    return `${left} ${operator} ${right}`;
}

function emitBoundBinaryOperand(
    expression: BoundExpression,
    parentOperator: BinaryExpressionNode["operator"],
    parameterIndices: number[],
    side: "left" | "right",
): string {
    const emitted = emitBoundExpression(expression, parameterIndices);
    return expression.kind === "BoundBinaryExpression" &&
        shouldParenthesizeBinary(expression.operator, parentOperator, side)
        ? `(${emitted})`
        : emitted;
}

function shouldParenthesizeBinary(
    childOperator: BinaryExpressionNode["operator"],
    parentOperator: BinaryExpressionNode["operator"],
    side: "left" | "right",
): boolean {
    const childPrecedence = binaryPrecedence(childOperator);
    const parentPrecedence = binaryPrecedence(parentOperator);
    if (childPrecedence < parentPrecedence) {
        return true;
    }

    return (
        side === "right" &&
        childPrecedence === parentPrecedence &&
        !canFlattenRightBinaryOperand(parentOperator, childOperator)
    );
}

function canFlattenRightBinaryOperand(
    parentOperator: BinaryExpressionNode["operator"],
    childOperator: BinaryExpressionNode["operator"],
): boolean {
    if (parentOperator === "AND" || parentOperator === "OR") {
        return childOperator === parentOperator;
    }

    if (parentOperator === "+") {
        return childOperator === "+";
    }

    if (parentOperator === "*") {
        return childOperator === "*";
    }

    return false;
}

function binaryPrecedence(operator: BinaryExpressionNode["operator"]): number {
    switch (operator) {
        case "OR":
            return 1;
        case "AND":
            return 2;
        case "=":
        case "!=":
        case "<":
        case "<=":
        case ">":
        case ">=":
        case "LIKE":
        case "REGEXP":
        case "RLIKE":
            return 3;
        case "+":
        case "-":
            return 4;
        case "*":
        case "/":
        case "%":
            return 5;
        default:
            operator satisfies never;
            throw new Error(`Unsupported binary operator: ${operator}`);
    }
}

function quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, "``")}\``;
}
