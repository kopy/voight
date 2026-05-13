import {
    ALLOWED_FUNCTIONS_POLICY_NAME,
    allowedFunctionsPolicy,
    type AllowedFunctionsPolicyOptions,
} from "./allowed-functions";
import { MAX_LIMIT_POLICY_NAME, maxLimitPolicy, type MaxLimitPolicyOptions } from "./max-limit";
import { SUPPORTED_OPERATORS_POLICY_NAME, supportedOperatorsPolicy } from "./supported-operators";
import {
    PolicyConflictError,
    PolicyConfigurationError,
    PolicyDiagnosticError,
    PolicyError,
    PolicyUsageError,
    dedupePoliciesByName,
    type PolicySelectionOptions,
} from "./shared";
import {
    TENANT_SCOPING_POLICY_NAME,
    tenantScopingPolicy,
    type TenantScopingPolicyOptions,
    type TenantScopingScopeOptions,
    type TenantScopeValueType,
} from "./tenant-scoping";

export type {
    CompilerPolicy,
    PolicyContext,
    PolicyEnforcementContext,
    PolicyRewriteContext,
    PolicySelectionOptions,
} from "./shared";

export type {
    AllowedFunctionsPolicyOptions,
    MaxLimitPolicyOptions,
    TenantScopingPolicyOptions,
    TenantScopingScopeOptions,
    TenantScopeValueType,
};

export {
    ALLOWED_FUNCTIONS_POLICY_NAME,
    MAX_LIMIT_POLICY_NAME,
    allowedFunctionsPolicy,
    maxLimitPolicy,
    PolicyConflictError,
    PolicyConfigurationError,
    PolicyDiagnosticError,
    PolicyError,
    PolicyUsageError,
    SUPPORTED_OPERATORS_POLICY_NAME,
    TENANT_SCOPING_POLICY_NAME,
    supportedOperatorsPolicy,
    tenantScopingPolicy,
};

export function resolvePolicies(options: PolicySelectionOptions = {}) {
    const policies = dedupePoliciesByName(options.policies ?? []);
    if (policies.some((policy) => policy.name === ALLOWED_FUNCTIONS_POLICY_NAME)) {
        return policies;
    }

    // If no allowed functions policy is provided, add a default one that disallows all functions.
    return [allowedFunctionsPolicy({ allowedFunctions: new Set() }), ...policies];
}
