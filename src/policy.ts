/**
 * Baidu Qianfan error policy: pure classification and retry-ladder logic.
 *
 * This module has no imports on purpose. The OpenCode SDK only exists inside
 * the plugin runtime, so keeping the policy dependency-free lets `node --test`
 * exercise it bare, and leaves every runtime touch to `index.ts`.
 */

export type ErrorKind = "retry" | "switch" | "fail"

export interface HookError {
  readonly type?: string
  readonly message?: string
  readonly status?: number
}

export interface Classification {
  readonly kind: ErrorKind
  /** Stable category id from the matrix; used by config overrides and traces. */
  readonly category: string
  /** Retries allowed after the initial request. */
  readonly cap: number
  /** Base delays in ms (before jitter) for this category, in retry order. */
  readonly bases: readonly number[]
  /** Headline delay for the first tier, in ms. */
  readonly delayMs: number
  readonly reason: string
}

export interface Rule {
  readonly category: string
  readonly kind: ErrorKind
  /** Tested against `${error.type} ${error.message}`; first matching rule wins. */
  readonly patterns: readonly RegExp[]
  readonly bases: readonly number[]
  readonly cap: number
  readonly reason: string
}

export type LadderOverrides = Record<string, readonly number[]>

export const PROVIDER_PREFIX = "baidu-qianfan"

/** Hard ceiling for a single wait; well below the 10 minute idle watchdog. */
export const MAX_DELAY_MS = 120_000

export const JITTER_MIN = 0.7
export const JITTER_SPAN = 0.6

const SECOND = 1_000

/**
 * Error matrix, in evaluation order:
 * long quota -> auth -> billing -> content -> model -> invalid request ->
 * cluster capacity -> TPM -> RPM -> QPS -> 5xx -> unrecognized.
 *
 * The order is load bearing. Every long-lived quota error is also an HTTP 429,
 * so it has to be ruled out before any retryable pattern; cluster codes embed
 * the plain `rpm_rate_limit_exceeded` / `tpm_rate_limit_exceeded` strings, so
 * they have to be matched before the per-request classes.
 */
export const MATRIX: readonly Rule[] = [
  {
    category: "long_quota",
    kind: "fail",
    patterns: [
      /coding_plan_(?:hour|week|month)_quota_exceeded/i,
      /quota[\s_-]+(?:has been )?exceeded/i,
    ],
    bases: [],
    cap: 0,
    reason: "5h/week/month quota exhausted; waiting a minute cannot help",
  },
  {
    category: "auth",
    kind: "fail",
    patterns: [
      /coding_plan_api_key_(?:required|not_allowed)/i,
      /coding_plan_(?:not_subscribed|subscription_expired)/i,
      /invalid_iam_token/i,
      /invalid_appid/i,
    ],
    bases: [],
    cap: 0,
    reason: "credentials or subscription rejected; fix the configuration",
  },
  {
    category: "billing",
    kind: "fail",
    patterns: [/account_overdue/i],
    bases: [],
    cap: 0,
    reason: "account overdue; top up before retrying",
  },
  {
    category: "content_safety",
    kind: "fail",
    patterns: [/\b(?:system|user_setting|functions)_unsafe\b/i],
    bases: [],
    cap: 0,
    reason: "content safety rejection; change the request content",
  },
  {
    category: "model",
    kind: "fail",
    patterns: [/invalid_model/i, /model_not_supported/i, /model_offline/i],
    bases: [],
    cap: 0,
    reason: "model unavailable; pick a model the account can use",
  },
  {
    category: "invalid_request",
    kind: "fail",
    patterns: [
      /invalid_messages/i,
      /invalid_argument/i,
      /characters_too_long/i,
      /tokens_too_long/i,
      /invalid_image_/i,
    ],
    bases: [],
    cap: 0,
    reason: "request rejected as invalid; retrying the same body cannot help",
  },
  {
    category: "cluster_capacity",
    kind: "retry",
    patterns: [
      /cluster_rpm_rate_limit_exceeded/i,
      /cluster_tpm_rate_limit_exceeded/i,
      /coding_plan_cluster_rate_limited/i,
    ],
    bases: [5 * SECOND, 15 * SECOND, 30 * SECOND, 60 * SECOND, 120 * SECOND],
    cap: 5,
    reason: "cluster capacity saturated; back off on a 5s..120s ladder",
  },
  {
    category: "tpm",
    kind: "retry",
    patterns: [
      /input_tpm_rate_limit_exceeded/i,
      /output_tpm_rate_limit_exceeded/i,
      /tpm_rate_limit_exceeded/i,
    ],
    bases: [
      5 * SECOND,
      10 * SECOND,
      20 * SECOND,
      30 * SECOND,
      45 * SECOND,
      60 * SECOND,
      90 * SECOND,
    ],
    cap: 7,
    reason: "token-per-minute limit; back off on a 5s..90s ladder",
  },
  {
    category: "rpm",
    kind: "retry",
    patterns: [
      /rpm_rate_limit_exceeded/i,
      /coding_plan_rate_limit_exceeded/i,
      /request rate limit/i,
    ],
    bases: [
      3 * SECOND,
      6 * SECOND,
      10 * SECOND,
      15 * SECOND,
      20 * SECOND,
      30 * SECOND,
      45 * SECOND,
      60 * SECOND,
      90 * SECOND,
    ],
    cap: 9,
    reason: "requests-per-minute limit; back off on a 3s..90s ladder",
  },
  {
    category: "qps",
    kind: "retry",
    patterns: [
      /user_rate_limit_exceeded/i,
      /cluster_rate_limit_exceeded/i,
      /preemptible_rate_limit_exceeded/i,
    ],
    bases: [
      1 * SECOND,
      2 * SECOND,
      3 * SECOND,
      5 * SECOND,
      8 * SECOND,
      12 * SECOND,
      20 * SECOND,
    ],
    cap: 7,
    reason: "queries-per-second limit; back off on a 1s..20s ladder",
  },
  {
    category: "server_error",
    kind: "retry",
    patterns: [/dispatch_internal_error/i, /internal_error/i],
    bases: [1 * SECOND, 2 * SECOND, 4 * SECOND, 8 * SECOND, 16 * SECOND],
    cap: 5,
    reason: "upstream 5xx; back off on a 1s..16s ladder",
  },
]

/** Fallback row: no pattern matched, so allow a single short retry. */
export const UNKNOWN_RULE: Rule = {
  category: "unknown",
  kind: "retry",
  patterns: [],
  bases: [5 * SECOND],
  cap: 1,
  reason: "unrecognized error; one 5s retry, then fail",
}

/** Largest number of retries any category may request (OpenCode allows 10). */
export const MAX_RETRIES = Math.max(...MATRIX.map((rule) => rule.cap), UNKNOWN_RULE.cap)

export function isLadder(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry > 0)
  )
}

function materialize(rule: Rule, override?: readonly number[]): Classification {
  const bases = isLadder(override) ? override.slice() : rule.bases
  return {
    kind: rule.kind,
    category: rule.category,
    cap: rule.cap,
    bases,
    delayMs: bases[0] ?? 0,
    reason: rule.reason,
  }
}

/**
 * Map a retry-hook error onto the matrix. `overrides` replaces a category's
 * base delays with hot-read configuration values; invalid entries are ignored.
 */
export function classify(
  error: HookError | null | undefined,
  overrides?: LadderOverrides,
): Classification {
  const text = [error?.type, error?.message]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
  const matched = MATRIX.find((rule) => rule.patterns.some((pattern) => pattern.test(text)))
  const rule = matched ?? UNKNOWN_RULE
  return materialize(rule, overrides?.[rule.category])
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

/** One tier: `min(base_i * U(0.7, 1.3), 120000)`, rounded to whole ms. */
export function delayForTier(baseMs: number, rng: () => number = Math.random): number {
  const factor = JITTER_MIN + JITTER_SPAN * clamp01(rng())
  return Math.min(MAX_DELAY_MS, Math.round(baseMs * factor))
}

export type LadderDecision =
  | { readonly retry: true; readonly delay: number; readonly index: number; readonly base: number }
  | { readonly retry: false; readonly veto: "kind" | "cap" }

/**
 * Turn `(classification, attempt)` into a retry decision.
 *
 * `attempt` is the physical attempt that just failed: the initial request is 1.
 * The ladder index is `max(0, attempt - 2)` so attempt 1 and attempt 2 both use
 * the first tier, and the cap counts issued retries (`attempt - 1`).
 */
export function ladder(
  classification: Pick<Classification, "kind" | "bases" | "cap">,
  attempt: number,
  rng: () => number = Math.random,
): LadderDecision {
  if (classification.kind !== "retry") return { retry: false, veto: "kind" }

  const physicalAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1
  if (physicalAttempt - 1 >= classification.cap) return { retry: false, veto: "cap" }

  const bases = classification.bases.length > 0 ? classification.bases : UNKNOWN_RULE.bases
  const index = Math.min(Math.max(0, physicalAttempt - 2), bases.length - 1)
  const base = bases[index] as number
  return { retry: true, delay: delayForTier(base, rng), index, base }
}