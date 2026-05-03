import type { BoundQuery, QueryAst } from "../ast";
import type { Catalog } from "../catalog";
import type { Diagnostic } from "../core/diagnostics";

export type PolicyContext = Readonly<Record<string, unknown>>;

export interface PolicyRewriteContext {
    readonly context: PolicyContext;
    readonly catalog?: Catalog;
}

export interface PolicyEnforcementContext {
    readonly context: PolicyContext;
    readonly catalog?: Catalog;
}

export interface CompilerPolicy {
    readonly name: string;
    rewrite?(query: QueryAst, context: PolicyRewriteContext): QueryAst;
    enforce?(bound: BoundQuery, context: PolicyEnforcementContext): readonly Diagnostic[];
}

export interface PolicySelectionOptions {
    readonly policies?: readonly CompilerPolicy[];
}

export class PolicyError extends Error {
    readonly policyName?: string;

    constructor(message: string, options: { policyName?: string } = {}) {
        super(message);
        this.name = new.target.name;
        this.policyName = options.policyName;
    }
}

export class PolicyDiagnosticError extends PolicyError {
    readonly diagnostic: Diagnostic;

    constructor(diagnostic: Diagnostic, options: { policyName?: string } = {}) {
        super(diagnostic.message, options);
        this.diagnostic = diagnostic;
    }
}

export class PolicyConfigurationError extends PolicyError {}

export class PolicyUsageError extends PolicyError {}

export class PolicyConflictError extends PolicyConfigurationError {
    readonly conflictingPolicyNames: readonly string[];

    constructor(conflictingPolicyNames: readonly string[]) {
        super(`Duplicate policy names are not allowed: ${conflictingPolicyNames.join(", ")}.`, {
            policyName: conflictingPolicyNames[0],
        });
        this.conflictingPolicyNames = conflictingPolicyNames;
    }
}

export function dedupePoliciesByName(
    policies: readonly CompilerPolicy[],
): readonly CompilerPolicy[] {
    const byName = new Map<string, CompilerPolicy>();
    const duplicates = new Set<string>();

    for (const policy of policies) {
        if (byName.has(policy.name)) {
            duplicates.add(policy.name);
            continue;
        }
        byName.set(policy.name, policy);
    }

    if (duplicates.size > 0) {
        throw new PolicyConflictError([...duplicates]);
    }

    return [...byName.values()];
}
