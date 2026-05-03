import type { BoundExpression, BoundQuery, BoundSelectStatement, QueryAst } from "../ast";
import { collectBoundPolicyDiagnostics } from "../ast/bound-policy-traversal";
import { mapQueryAst } from "../ast/query-ast-traversal";
import {
    CompilerStage,
    DiagnosticCode,
    createDiagnostic,
    type Diagnostic,
} from "../core/diagnostics";
import { createSpan } from "../core/source";
import { PolicyConfigurationError, type CompilerPolicy } from "./shared";

export interface MaxLimitPolicyOptions {
    readonly maxLimit: number;
    readonly maxOffset?: number;
    readonly defaultLimit?: number;
}

export function maxLimitPolicy(options: MaxLimitPolicyOptions): CompilerPolicy {
    return new MaxLimitPolicy(options);
}

class MaxLimitPolicy implements CompilerPolicy {
    readonly name = "max-limit";
    readonly #maxLimit: number;
    readonly #maxOffset?: number;
    readonly #defaultLimit?: number;

    constructor(options: MaxLimitPolicyOptions) {
        this.#maxLimit = validateNonNegativeInteger(options.maxLimit, "maxLimit");
        this.#maxOffset =
            typeof options.maxOffset === "undefined"
                ? undefined
                : validateNonNegativeInteger(options.maxOffset, "maxOffset");
        this.#defaultLimit =
            typeof options.defaultLimit === "undefined"
                ? undefined
                : validateNonNegativeInteger(options.defaultLimit, "defaultLimit");

        if (typeof this.#defaultLimit !== "undefined" && this.#defaultLimit > this.#maxLimit) {
            throw new PolicyConfigurationError(
                `Policy "max-limit" requires defaultLimit (${this.#defaultLimit}) to be less than or equal to maxLimit (${this.#maxLimit}).`,
                { policyName: "max-limit" },
            );
        }
    }

    rewrite(query: QueryAst): QueryAst {
        if (typeof this.#defaultLimit === "undefined") {
            return query;
        }

        return mapQueryAst(query, (select) =>
            select.limit ? select : addDefaultLimit(select, this.#defaultLimit!),
        );
    }

    enforce(bound: BoundQuery): readonly Diagnostic[] {
        return collectBoundPolicyDiagnostics(bound, {
            select: (select) => this.#validateSelectLimit(select),
        });
    }

    #validateSelectLimit(select: BoundSelectStatement): readonly Diagnostic[] | void {
        if (!select.limit) {
            return [
                createDiagnostic({
                    code: DiagnosticCode.LimitExceeded,
                    stage: CompilerStage.Enforcer,
                    message: `A constant LIMIT clause is required when the configured maximum is ${this.#maxLimit}.`,
                    primarySpan: select.span,
                }),
            ];
        }

        const count = evaluateBareIntegerLiteral(select.limit.count);
        if (count === undefined) {
            return [
                createDiagnostic({
                    code: DiagnosticCode.LimitExceeded,
                    stage: CompilerStage.Enforcer,
                    message: "LIMIT must be a bare non-negative integer literal.",
                    primarySpan: select.limit.count.span,
                }),
            ];
        }

        if (count > BigInt(this.#maxLimit)) {
            return [
                createDiagnostic({
                    code: DiagnosticCode.LimitExceeded,
                    stage: CompilerStage.Enforcer,
                    message: `LIMIT ${count.toString()} exceeds the configured maximum of ${this.#maxLimit}.`,
                    primarySpan: select.limit.count.span,
                }),
            ];
        }

        if (typeof this.#maxOffset !== "undefined" && select.limit.offset) {
            const offset = evaluateBareIntegerLiteral(select.limit.offset);
            if (offset === undefined) {
                return [
                    createDiagnostic({
                        code: DiagnosticCode.LimitExceeded,
                        stage: CompilerStage.Enforcer,
                        message: "OFFSET must be a bare non-negative integer literal.",
                        primarySpan: select.limit.offset.span,
                    }),
                ];
            }

            if (offset > BigInt(this.#maxOffset)) {
                return [
                    createDiagnostic({
                        code: DiagnosticCode.LimitExceeded,
                        stage: CompilerStage.Enforcer,
                        message: `OFFSET ${offset.toString()} exceeds the configured maximum of ${this.#maxOffset}.`,
                        primarySpan: select.limit.offset.span,
                    }),
                ];
            }
        }
    }
}

function validateNonNegativeInteger(
    value: number,
    field: "maxLimit" | "maxOffset" | "defaultLimit",
): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new PolicyConfigurationError(
            `Policy "max-limit" requires ${field} to be a non-negative safe integer.`,
            { policyName: "max-limit" },
        );
    }

    return value;
}

function addDefaultLimit(select: QueryAst["body"], limit: number): QueryAst["body"] {
    const span = createSpan(select.span.end, select.span.end);

    return {
        ...select,
        limit: {
            kind: "LimitClause",
            span,
            count: {
                kind: "Literal",
                span,
                literalType: "integer",
                value: String(limit),
            },
        },
    };
}

function evaluateBareIntegerLiteral(expression: BoundExpression | undefined): bigint | undefined {
    if (!expression || expression.kind !== "BoundLiteral") {
        return undefined;
    }

    if (expression.literalType !== "integer" || typeof expression.value !== "string") {
        return undefined;
    }

    const value = BigInt(expression.value);
    return value >= 0n ? value : undefined;
}
