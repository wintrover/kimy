import type {
  PermissionPolicy,
  PermissionPolicyCategory,
  PermissionPolicyContext,
  PermissionPolicyResult,
} from './types';

/**
 * Base class for all permission policies.
 *
 * Subclasses MUST declare a `category` — this is enforced at compile time.
 * The evaluator uses a declarative mode matrix to filter policies by category,
 * keeping mode-awareness out of individual policy classes.
 *
 * Subclasses SHOULD keep `evaluate()` side-effect-free. If a policy needs to
 * fire side effects (telemetry, state mutation) when its result is actually
 * used, override `onSelected()` instead — the evaluator calls it only for
 * policies whose result kind wins the combining algorithm.
 */
export abstract class BasePermissionPolicy implements PermissionPolicy {
  abstract readonly name: string;
  abstract readonly category: PermissionPolicyCategory;

  abstract evaluate(
    context: PermissionPolicyContext,
  ): PermissionPolicyResult | undefined | Promise<PermissionPolicyResult | undefined>;

  /**
   * Called after this policy's result kind wins the combining algorithm.
   * Use this for telemetry or other side effects that should only fire
   * when the policy's decision is actually applied.
   */
  onSelected?(
    _context: PermissionPolicyContext,
    _result: PermissionPolicyResult,
  ): void;
}
