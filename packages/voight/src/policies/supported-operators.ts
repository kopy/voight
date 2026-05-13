import type { BoundQuery } from "../ast";
import { collectBoundPolicyDiagnostics } from "../ast/bound-policy-traversal";
import {
    CompilerStage,
    DiagnosticCode,
    createDiagnostic,
    type Diagnostic,
} from "../core/diagnostics";
import type { CompilerPolicy } from "./shared";

const SUPPORTED_BINARY_OPERATORS = new Set([
    "+",
    "-",
    "*",
    "/",
    "%",
    "=",
    "!=",
    "<",
    "<=",
    ">",
    ">=",
    "LIKE",
    "REGEXP",
    "RLIKE",
    "AND",
    "OR",
]);

const SUPPORTED_UNARY_OPERATORS = new Set(["-", "NOT"]);

export const SUPPORTED_OPERATORS_POLICY_NAME = "supported-operators";

export function supportedOperatorsPolicy(): CompilerPolicy {
    return new SupportedOperatorsPolicy();
}

class SupportedOperatorsPolicy implements CompilerPolicy {
    readonly name = SUPPORTED_OPERATORS_POLICY_NAME;

    enforce(bound: BoundQuery): readonly Diagnostic[] {
        return collectBoundPolicyDiagnostics(bound, {
            expression: (expression) => {
                if (expression.kind === "BoundUnaryExpression") {
                    if (SUPPORTED_UNARY_OPERATORS.has(expression.operator)) {
                        return;
                    }

                    return [
                        createDiagnostic({
                            code: DiagnosticCode.UnsupportedOperator,
                            stage: CompilerStage.Enforcer,
                            message: `Unary operator "${expression.operator}" is not supported.`,
                            primarySpan: expression.span,
                        }),
                    ];
                }

                if (expression.kind === "BoundBinaryExpression") {
                    if (SUPPORTED_BINARY_OPERATORS.has(expression.operator)) {
                        return;
                    }

                    return [
                        createDiagnostic({
                            code: DiagnosticCode.UnsupportedOperator,
                            stage: CompilerStage.Enforcer,
                            message: `Binary operator "${expression.operator}" is not supported.`,
                            primarySpan: expression.span,
                        }),
                    ];
                }
            },
        });
    }
}
