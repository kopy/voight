import type { BoundQuery, QueryAst } from "../ast";
import type { Catalog } from "../catalog";
import {
    CompilerStage,
    DiagnosticCode,
    DiagnosticVisibility,
    createDiagnostic,
    projectDiagnosticForPublic,
    type Diagnostic,
} from "../core/diagnostics";
import { bind, type BindResult } from "../binder";
import { emit, type EmitResult, type EmitValue } from "../emitter";
import { enforce, type EnforcementOptions, type EnforcementResult } from "./enforcer";
import { parse, type ParseResult } from "../parser";
import type { CompilerPolicy, PolicyContext } from "../policies";
import { PolicyConflictError, PolicyDiagnosticError, PolicyError } from "../policies";
import { rewrite, type QueryRewriter, type RewriteResult } from "./rewriter";
import { createSpan } from "../core/source";

export interface CompileOptions extends EnforcementOptions {
    readonly catalog: Catalog;
    readonly policies?: readonly CompilerPolicy[];
    readonly policyContext?: PolicyContext;
    readonly rewriters?: readonly QueryRewriter[];
    readonly debug?: boolean;
}

export interface CompileResult {
    readonly ok: boolean;
    readonly source: string;
    readonly terminalStage: CompilerStage;
    readonly diagnostics: readonly Diagnostic[];
    readonly ast?: QueryAst;
    readonly rewrittenAst?: QueryAst;
    readonly bound?: BoundQuery;
    readonly emitted?: EmitValue;
    readonly stages?: {
        readonly parse?: ParseResult<QueryAst>;
        readonly rewrite?: RewriteResult;
        readonly bind?: BindResult<BoundQuery>;
        readonly enforce?: EnforcementResult;
        readonly emit?: EmitResult;
    };
}

export function compile(source: string, options: CompileOptions): CompileResult {
    const internal = compileSafely(source, options);
    return options.debug ? internal : sanitizeCompileResult(internal);
}

function compileSafely(source: string, options: CompileOptions): CompileResult {
    try {
        return compileInternal(source, options);
    } catch (error) {
        return {
            ok: false,
            source,
            terminalStage:
                error instanceof PolicyDiagnosticError
                    ? error.diagnostic.stage
                    : CompilerStage.Compiler,
            diagnostics: [createThrownDiagnostic(source, error)],
        };
    }
}

function compileInternal(source: string, options: CompileOptions): CompileResult {
    const parsed = parse(source);

    if (!parsed.ok) {
        return {
            ok: false,
            source,
            terminalStage: CompilerStage.Parser,
            diagnostics: parsed.diagnostics,
            stages: { parse: parsed },
        };
    }

    const rewritten = rewrite(parsed.value, {
        policies: options.policies,
        policyContext: options.policyContext,
        rewriters: options.rewriters,
        catalog: options.catalog,
    });
    if (!rewritten.ok) {
        return {
            ok: false,
            source,
            terminalStage: CompilerStage.Rewriter,
            diagnostics: rewritten.diagnostics,
            ast: parsed.value,
            stages: { parse: parsed, rewrite: rewritten },
        };
    }

    const bound = bind(rewritten.value, options.catalog);
    if (!bound.ok) {
        return {
            ok: false,
            source,
            terminalStage: CompilerStage.Binder,
            diagnostics: bound.diagnostics,
            ast: parsed.value,
            rewrittenAst: rewritten.value,
            stages: { parse: parsed, rewrite: rewritten, bind: bound },
        };
    }

    const enforced = enforce(bound.value, {
        policies: options.policies,
        policyContext: options.policyContext,
        catalog: options.catalog,
    });
    if (!enforced.ok) {
        return {
            ok: false,
            source,
            terminalStage: CompilerStage.Enforcer,
            diagnostics: enforced.diagnostics,
            ast: parsed.value,
            rewrittenAst: rewritten.value,
            bound: bound.value,
            stages: {
                parse: parsed,
                rewrite: rewritten,
                bind: bound,
                enforce: enforced,
            },
        };
    }

    const emitted = emit(bound.value);
    if (!emitted.ok) {
        return {
            ok: false,
            source,
            terminalStage: CompilerStage.Emitter,
            diagnostics: emitted.diagnostics,
            ast: parsed.value,
            rewrittenAst: rewritten.value,
            bound: bound.value,
            stages: {
                parse: parsed,
                rewrite: rewritten,
                bind: bound,
                enforce: enforced,
                emit: emitted,
            },
        };
    }

    return {
        ok: true,
        source,
        terminalStage: CompilerStage.Emitter,
        diagnostics: [],
        ast: parsed.value,
        rewrittenAst: rewritten.value,
        bound: bound.value,
        emitted: emitted.value,
        stages: {
            parse: parsed,
            rewrite: rewritten,
            bind: bound,
            enforce: enforced,
            emit: emitted,
        },
    };
}

function sanitizeCompileResult(result: CompileResult): CompileResult {
    if (result.ok) {
        return {
            ok: true,
            source: result.source,
            terminalStage: CompilerStage.Compiler,
            diagnostics: [],
            emitted: result.emitted,
        };
    }

    const diagnostics = result.diagnostics
        .map((diagnostic) => projectDiagnosticForPublic(diagnostic))
        .filter((diagnostic) => typeof diagnostic !== "undefined");

    return {
        ok: false,
        source: result.source,
        terminalStage: CompilerStage.Compiler,
        diagnostics: diagnostics.length > 0 ? diagnostics : [createPublicDiagnostic(result.source)],
    };
}

function createPublicDiagnostic(source: string): Diagnostic {
    return createDiagnostic({
        code: DiagnosticCode.InternalCompilerError,
        stage: CompilerStage.Compiler,
        message: "Query could not be compiled because of an internal compiler error.",
        primarySpan: createSpan(0, source.length),
    });
}

function createThrownDiagnostic(source: string, error: unknown): Diagnostic {
    const primarySpan = createSpan(0, source.length);

    if (error instanceof PolicyDiagnosticError) {
        return error.diagnostic;
    }

    if (error instanceof PolicyConflictError) {
        return createDiagnostic({
            code: DiagnosticCode.InvalidPolicyConfiguration,
            stage: CompilerStage.Compiler,
            message: error.message,
            primarySpan,
            visibility: DiagnosticVisibility.Internal,
        });
    }

    if (error instanceof PolicyError) {
        return createDiagnostic({
            code: DiagnosticCode.PolicyExecutionError,
            stage: CompilerStage.Compiler,
            message: error.message,
            primarySpan,
            visibility: DiagnosticVisibility.Internal,
        });
    }

    return createDiagnostic({
        code: DiagnosticCode.InternalCompilerError,
        stage: CompilerStage.Compiler,
        message: error instanceof Error ? error.message : "Compiler failed unexpectedly.",
        primarySpan,
        visibility: DiagnosticVisibility.Internal,
    });
}
