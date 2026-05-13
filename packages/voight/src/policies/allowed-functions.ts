import type { BoundExpression, BoundQuery } from "../ast";
import { collectBoundPolicyDiagnostics } from "../ast/bound-policy-traversal";
import { normalizeIdentifier } from "../catalog";
import {
    CompilerStage,
    DiagnosticCode,
    createDiagnostic,
    type Diagnostic,
} from "../core/diagnostics";
import { PolicyConfigurationError, type CompilerPolicy } from "./shared";

export interface AllowedFunctionsPolicyOptions {
    readonly allowedFunctions: ReadonlySet<string>;
}

export function allowedFunctionsPolicy(options: AllowedFunctionsPolicyOptions): CompilerPolicy {
    return new AllowedFunctionsPolicy(options);
}

export const ALLOWED_FUNCTIONS_POLICY_NAME = "allowed-functions";

class AllowedFunctionsPolicy implements CompilerPolicy {
    readonly name = ALLOWED_FUNCTIONS_POLICY_NAME;
    readonly #allowedFunctions: ReadonlySet<string>;

    constructor(options: AllowedFunctionsPolicyOptions) {
        this.#allowedFunctions = validateAllowedFunctions(options.allowedFunctions);
    }

    enforce(bound: BoundQuery): readonly Diagnostic[] {
        return collectBoundPolicyDiagnostics(bound, {
            expression: (expression) => {
                const functionName = getFunctionName(expression);
                if (!functionName || this.#allowedFunctions.has(functionName)) {
                    return;
                }

                return [
                    createDiagnostic({
                        code: DiagnosticCode.DisallowedFunction,
                        stage: CompilerStage.Enforcer,
                        message: `Function "${functionName}" is not allowed.`,
                        primarySpan:
                            expression.kind === "BoundFunctionCall"
                                ? expression.ast.callee.span
                                : expression.ast.span,
                    }),
                ];
            },
        });
    }
}

function validateAllowedFunctions(allowedFunctions: ReadonlySet<string>): ReadonlySet<string> {
    if (
        typeof allowedFunctions !== "object" ||
        allowedFunctions === null ||
        typeof allowedFunctions[Symbol.iterator] !== "function"
    ) {
        throw new PolicyConfigurationError(
            'Policy "allowed-functions" requires allowedFunctions to be an iterable of function names.',
            { policyName: "allowed-functions" },
        );
    }

    const normalized = new Set<string>();
    for (const functionName of allowedFunctions) {
        if (typeof functionName !== "string") {
            throw new PolicyConfigurationError(
                'Policy "allowed-functions" requires every allowed function to be a string.',
                { policyName: "allowed-functions" },
            );
        }

        const name = normalizeIdentifier(functionName.trim());
        if (!name) {
            throw new PolicyConfigurationError(
                'Policy "allowed-functions" does not accept empty function names.',
                { policyName: "allowed-functions" },
            );
        }

        normalized.add(name);
    }

    return normalized;
}

function getFunctionName(boundExpression: BoundExpression): string | undefined {
    if (boundExpression.kind === "BoundFunctionCall") {
        return boundExpression.callee;
    }

    if (boundExpression.kind === "BoundCurrentKeywordExpression") {
        return normalizeIdentifier(boundExpression.keyword);
    }

    return undefined;
}
