import { allowedFunctionsPolicy, type AllowedFunctionsPolicyOptions } from "./allowed-functions";
import { maxLimitPolicy, type MaxLimitPolicyOptions } from "./max-limit";
import { supportedOperatorsPolicy } from "./supported-operators";
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
    allowedFunctionsPolicy,
    maxLimitPolicy,
    PolicyConflictError,
    PolicyConfigurationError,
    PolicyDiagnosticError,
    PolicyError,
    PolicyUsageError,
    supportedOperatorsPolicy,
    tenantScopingPolicy,
};

export function resolvePolicies(options: PolicySelectionOptions = {}) {
    return dedupePoliciesByName(options.policies ?? []);
}
