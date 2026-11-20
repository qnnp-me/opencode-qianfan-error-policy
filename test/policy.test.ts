import { test } from "node:test"
import assert from "node:assert/strict"
import {
  classify,
  delayForTier,
  JITTER_MIN,
  ladder,
  MATRIX,
  MAX_DELAY_MS,
  MAX_RETRIES,
  UNKNOWN_RULE,
} from "../src/policy.ts"

/** Deterministic PRNG so jitter assertions are reproducible, not flaky. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const RETRY_GROUPS: Array<{ category: string; cap: number; messages: string[] }> = [
  {
    category: "qps",
    cap: 7,
    messages: ["user_rate_limit_exceeded", "cluster_rate_limit_exceeded", "preemptible_rate_limit_exceeded"],
  },
  {
    category: "rpm",
    cap: 9,
    messages: [
      "rpm_rate_limit_exceeded",
      "coding_plan_rate_limit_exceeded",
      "Token Plan Person request rate limit exceeded (code=-32603, data={\"service\":\"session\",\"errorName\":\"provider.quota\"})",
    ],
  },
  {
    category: "tpm",
    cap: 7,
    messages: ["tpm_rate_limit_exceeded", "input_tpm_rate_limit_exceeded", "output_tpm_rate_limit_exceeded"],
  },
  {
    category: "cluster_capacity",
    cap: 5,
    messages: [
      "cluster_rpm_rate_limit_exceeded",
      "cluster_tpm_rate_limit_exceeded",
      "coding_plan_cluster_rate_limited",
    ],
  },
  {
    category: "server_error",
    cap: 5,
    messages: ["internal_error", "dispatch_internal_error"],
  },
]

const FAIL_GROUPS: Array<{ category: string; messages: string[] }> = [
  {
    category: "long_quota",
    messages: [
      "coding_plan_hour_quota_exceeded",
      "coding_plan_week_quota_exceeded",
      "coding_plan_month_quota_exceeded",
      "quota has been exceeded",
      "coding_plan_quota_exceeded",
    ],
  },
  {
    category: "auth",
    messages: [
      "coding_plan_api_key_required",
      "coding_plan_api_key_not_allowed",
      "coding_plan_not_subscribed",
      "coding_plan_subscription_expired",
      "invalid_iam_token",
      "invalid_appid",
    ],
  },
  { category: "billing", messages: ["account_overdue"] },
  {
    category: "content_safety",
    messages: ["system_unsafe", "user_setting_unsafe", "functions_unsafe"],
  },
  {
    category: "model",
    messages: ["invalid_model", "model_not_supported", "model_offline"],
  },
  {
    category: "invalid_request",
    messages: [
      "invalid_messages",
      "invalid_argument",
      "characters_too_long",
      "tokens_too_long",
      "invalid_image_format",
      "invalid_image_url",
    ],
  },
]

test("AC1: every non-retryable row classifies as fail and vetoes the retry", () => {
  for (const group of FAIL_GROUPS) {
    for (const message of group.messages) {
      const classification = classify({ type: "provider.quota", message, status: 429 })
      assert.equal(classification.kind, "fail", `${group.category}: ${message}`)
      assert.equal(classification.category, group.category, message)

      const decision = ladder(classification, 1, () => 0.5)
      assert.deepEqual(decision, { retry: false, veto: "kind" }, message)
    }
  }
})

test("AC2: every retryable row maps to its category and cap", () => {
  for (const group of RETRY_GROUPS) {
    for (const message of group.messages) {
      const classification = classify({ type: "provider.quota", message, status: 429 })
      assert.equal(classification.kind, "retry", `${group.category}: ${message}`)
      assert.equal(classification.category, group.category, message)
      assert.equal(classification.cap, group.cap, message)

      assert.equal(ladder(classification, group.cap, () => 0.5).retry, true, message)
      assert.deepEqual(ladder(classification, group.cap + 1, () => 0.5), { retry: false, veto: "cap" }, message)
    }
  }
})

test("AC2: an unrecognized error gets one 5s retry and then fails", () => {
  const classification = classify({ type: "provider.internal", message: "something nobody documented" })
  assert.equal(classification.category, "unknown")
  assert.equal(classification.kind, "retry")
  assert.equal(classification.cap, 1)
  assert.deepEqual(classification.bases, UNKNOWN_RULE.bases)
  assert.equal(classification.delayMs, 5_000)

  const first = ladder(classification, 1, () => 0.5)
  assert.equal(first.retry, true)
  assert.equal(first.delay, 5_000)
  assert.deepEqual(ladder(classification, 2, () => 0.5), { retry: false, veto: "cap" })
})

test("AC2: a long quota outranks a retryable phrase in the same message", () => {
  const classification = classify({
    type: "provider.quota",
    message: "quota has been exceeded; request rate limit exceeded for this key",
  })
  assert.equal(classification.kind, "fail")
  assert.equal(classification.category, "long_quota")
  assert.deepEqual(ladder(classification, 1, () => 0.5), { retry: false, veto: "kind" })
})

test("AC2: a missing or empty error still lands on the unrecognized row", () => {
  for (const error of [undefined, null, {}, { type: "", message: "" }]) {
    const classification = classify(error)
    assert.equal(classification.category, "unknown")
  }
})

test("AC3: the ladder index is max(0, attempt - 2)", () => {
  const rpm = classify({ message: "rpm_rate_limit_exceeded" })
  assert.equal(rpm.cap, 9)

  for (let attempt = 1; attempt <= rpm.cap; attempt += 1) {
    const decision = ladder(rpm, attempt, () => 0.5)
    assert.equal(decision.retry, true, `attempt ${attempt}`)
    assert.equal(decision.index, Math.min(Math.max(0, attempt - 2), rpm.bases.length - 1))
    assert.equal(decision.delay, rpm.bases[decision.index])
  }

  assert.equal(ladder(rpm, 1, () => 0).index, 0)
  assert.equal(ladder(rpm, 2, () => 0).index, 0)
  assert.equal(ladder(rpm, 3, () => 0).index, 1)
  assert.deepEqual(ladder(rpm, rpm.cap + 1, () => 0.5), { retry: false, veto: "cap" })
})

test("AC3: every served tier stays inside its 0.7x..1.3x band", () => {
  for (const group of RETRY_GROUPS) {
    for (const message of group.messages) {
      const classification = classify({ message })
      for (let attempt = 1; attempt <= classification.cap; attempt += 1) {
        for (const r of [0, 0.5, 1]) {
          const decision = ladder(classification, attempt, () => r)
          assert.equal(decision.retry, true)
          const lower = Math.round(JITTER_MIN * decision.base)
          const upper = Math.min(MAX_DELAY_MS, Math.round(1.3 * decision.base))
          assert.ok(decision.delay >= lower, `${message} attempt ${attempt}: ${decision.delay} < ${lower}`)
          assert.ok(decision.delay <= upper, `${message} attempt ${attempt}: ${decision.delay} > ${upper}`)
        }
      }
    }
  }
})

test("AC3: a mixed QPS/RPM/TPM chain cannot exceed the total retry budget", () => {
  const cycle = [
    classify({ message: "user_rate_limit_exceeded" }),
    classify({ message: "coding_plan_rate_limit_exceeded" }),
    classify({ message: "tpm_rate_limit_exceeded" }),
    classify({ message: "cluster_rpm_rate_limit_exceeded" }),
    classify({ message: "internal_error" }),
  ]

  const allowed: number[] = []
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const classification = cycle[(attempt - 1) % cycle.length]
    const decision = ladder(classification, attempt, () => 0.5)
    assert.equal(
      decision.retry,
      attempt - 1 < classification.cap,
      `attempt ${attempt} (${classification.category})`,
    )
    if (decision.retry) allowed.push(attempt)
    else assert.equal(decision.veto, "cap")
  }

  assert.deepEqual(allowed, [1, 2, 3, 4, 5, 6, 7])
  assert.ok(allowed.length <= MAX_RETRIES)
  assert.equal(MAX_RETRIES, 9)
})

test("AC3: one category alone reaches exactly nine retries, never ten", () => {
  const rpm = classify({ message: "coding_plan_rate_limit_exceeded" })
  const allowed: number[] = []
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    if (ladder(rpm, attempt, () => 0.5).retry) allowed.push(attempt)
  }
  assert.equal(allowed.length, 9)
  assert.equal(allowed.at(-1), 9)
  assert.equal(ladder(rpm, 10, () => 0.5).retry, false)
})

const TIER_BASES = [...new Set(MATRIX.flatMap((rule) => rule.bases))].sort((a, b) => a - b)

test("AC7: 500 draws per tier keep the band, the 120s ceiling and half the spread", () => {
  assert.deepEqual(TIER_BASES.at(-1), MAX_DELAY_MS)

  for (const base of TIER_BASES) {
    const rng = seededRandom(base)
    const samples = Array.from({ length: 500 }, () => delayForTier(base, rng))
    const upper = Math.min(MAX_DELAY_MS, 1.3 * base)
    const lower = 0.7 * base

    for (const delay of samples) {
      assert.ok(delay <= MAX_DELAY_MS, `base=${base}: ${delay} > ${MAX_DELAY_MS}`)
      assert.ok(delay >= lower, `base=${base}: ${delay} < ${lower}`)
      assert.ok(delay <= upper, `base=${base}: ${delay} > ${upper}`)
    }

    const spread = Math.max(...samples) - Math.min(...samples)
    const required = 0.5 * (upper - lower)
    assert.ok(spread >= required, `base=${base}: spread ${spread} < ${required}`)
  }
})

test("AC7: the cluster top tier is min(120000, jitter)", () => {
  const cluster = classify({ message: "coding_plan_cluster_rate_limited" })
  const top = cluster.bases.at(-1)
  assert.equal(top, 120_000)

  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    const jitter = Math.round(top * (JITTER_MIN + 0.6 * r))
    assert.equal(delayForTier(top, () => r), Math.min(MAX_DELAY_MS, jitter))
  }
})

function collisionsPerRound(
  rounds: number,
  draw: (rng: () => number) => number,
  seed: number,
): number {
  const rng = seededRandom(seed)
  let collided = 0
  for (let round = 0; round < rounds; round += 1) {
    const arrivals = [0, rng() * 200, rng() * 200]
    const stamps = arrivals.map((arrival) => arrival + draw(rng))
    const gaps = [
      Math.abs(stamps[1] - stamps[0]),
      Math.abs(stamps[2] - stamps[0]),
      Math.abs(stamps[2] - stamps[1]),
    ]
    if (Math.min(...gaps) < 20) collided += 1
  }
  return collided
}

test("AC7: jitter at least halves near-simultaneous retries versus a fixed delay", (t) => {
  const rounds = 500
  const seed = 0x5eed
  const fixed = collisionsPerRound(rounds, () => 1_000, seed)
  const jittered = collisionsPerRound(rounds, (rng) => delayForTier(1_000, rng), seed)

  t.diagnostic(`fixed=${fixed}/${rounds} jittered=${jittered}/${rounds}`)
  assert.ok(
    jittered <= fixed / 2,
    `jittered ${jittered}/${rounds} > half of fixed ${fixed}/${rounds}`,
  )
})