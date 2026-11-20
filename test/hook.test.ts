import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import {
  createQianfanErrorPolicyPlugin,
  type PluginContext,
  type RetryEvent,
} from "../src/index.ts"

interface Harness {
  readonly dir: string
  readonly configPath: string
  readonly logPath: string
  writeConfig(value: unknown): void
  writeRawConfig(body: string): void
  emit(event: RetryEvent): void
  dispose(): Promise<void>
  handlerCount(): number
  disposeCalls(): number
  lines(): string[]
}

/** Boots the plugin against a fake ctx that records the retry handler. */
async function createHarness(t: TestContext): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "qianfan-policy-test-"))
  const configPath = join(dir, "qianfan-error-policy.json")
  const logPath = join(dir, "logs", "nested", "trace.log")
  let clock = Date.now()

  const touch = () => {
    clock += 5_000
    const stamp = new Date(clock)
    utimesSync(configPath, stamp, stamp)
  }

  const handlers: Array<(event: RetryEvent) => void> = []
  let disposed = 0

  const plugin = createQianfanErrorPolicyPlugin({ configPath, logPath })
  const ctx: PluginContext = {
    session: {
      hook: async (name, handler) => {
        assert.equal(name, "retry")
        handlers.push(handler)
        return {
          dispose: async () => {
            disposed += 1
          },
        }
      },
    },
  }
  const dispose = await plugin.setup(ctx)
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  return {
    dir,
    configPath,
    logPath,
    writeConfig(value) {
      writeFileSync(configPath, JSON.stringify(value, null, 2))
      touch()
    },
    writeRawConfig(body) {
      writeFileSync(configPath, body)
      touch()
    },
    emit(event) {
      for (const handler of handlers) handler(event)
    },
    dispose,
    handlerCount: () => handlers.length,
    disposeCalls: () => disposed,
    lines: () => readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0),
  }
}

function makeEvent(
  input: {
    message?: string
    attempt?: number
    providerID?: string
    type?: string
    status?: number
  } = {},
): RetryEvent {
  return {
    sessionID: "ses_qianfan_policy_test",
    agent: "build",
    model: { providerID: input.providerID ?? "baidu-qianfan-token-plan", id: "qianfan-test-model" },
    error: {
      type: input.type ?? "provider.quota",
      message: input.message ?? "rpm_rate_limit_exceeded",
      status: input.status ?? 429,
    },
    attempt: input.attempt ?? 2,
    decision: { retry: true, delay: 2_000 },
  }
}

function loggedMessage(line: string): string {
  const match = /message=("(?:[^"\\]|\\.)*")/.exec(line)
  assert.ok(match, `no message field in ${line}`)
  return JSON.parse(match[1] as string) as string
}

test("AC1 hook: non-retryable classes replace the proposed retry with a veto", async (t) => {
  const h = await createHarness(t)
  h.writeConfig({ enabled: true, logPath: h.logPath })

  const messages = [
    "coding_plan_hour_quota_exceeded",
    "account_overdue",
    "invalid_iam_token",
    "system_unsafe",
    "tokens_too_long",
    "model_offline",
  ]
  for (const message of messages) {
    const event = makeEvent({ message })
    h.emit(event)
    assert.deepEqual(event.decision, { retry: false }, message)
  }

  const lines = h.lines()
  assert.equal(lines.length, messages.length)
  assert.ok(lines.every((line) => line.includes("action=fail")))
  assert.ok(lines.every((line) => line.includes("delayMs=none")))
})

test("AC2 hook: a real Qianfan RPM sample retries from the first tier and stops at the cap", async (t) => {
  const h = await createHarness(t)
  h.writeConfig({ enabled: true, logPath: h.logPath })

  const event = makeEvent({
    message:
      "Token Plan Person request rate limit exceeded (code=-32603, data={\"service\":\"session\",\"errorName\":\"provider.quota\"})",
    attempt: 2,
  })
  h.emit(event)
  assert.equal(event.decision.retry, true)
  assert.ok(event.decision.delay >= 2_100 && event.decision.delay <= 3_900, String(event.decision.delay))

  const atCap = makeEvent({ message: "coding_plan_rate_limit_exceeded", attempt: 11 })
  h.emit(atCap)
  assert.deepEqual(atCap.decision, { retry: false })

  const line = h.lines().at(0) as string
  assert.ok(line.includes("category=rpm"))
  assert.ok(line.includes("cap=9"))
})

test("AC4 hook: a non-Qianfan provider keeps OpenCode's own decision untouched", async (t) => {
  const h = await createHarness(t)

  for (const providerID of ["openai", "opencode", "anthropic", "baidu"]) {
    const event = makeEvent({ providerID, message: "rpm_rate_limit_exceeded", attempt: 2 })
    const before = event.decision
    h.emit(event)
    assert.equal(event.decision, before, providerID)
  }

  assert.equal(existsSync(h.logPath), false)
})

test("AC5 hook: the provider comes from event.model.providerID, not from a session lookup", async (t) => {
  const h = await createHarness(t)
  h.writeConfig({ enabled: true, logPath: h.logPath })

  const event = makeEvent({ providerID: "baidu-qianfan-coding-plan", attempt: 2 })
  h.emit(event)
  assert.equal(event.decision.retry, true)
  assert.ok((h.lines().at(0) as string).includes("provider=baidu-qianfan-coding-plan"))
})

test("AC8 hook: enabled:false changes nothing and writes no trace", async (t) => {
  const h = await createHarness(t)
  h.writeConfig({ enabled: false, logPath: h.logPath })

  const event = makeEvent({ message: "rpm_rate_limit_exceeded", attempt: 2 })
  const before = event.decision
  h.emit(event)

  assert.equal(event.decision, before)
  assert.equal(existsSync(h.logPath), false)

  h.writeConfig({ enabled: true, logPath: h.logPath })
  const restored = makeEvent({ message: "rpm_rate_limit_exceeded", attempt: 2 })
  h.emit(restored)
  assert.equal(restored.decision.retry, true)
  assert.equal(h.lines().length, 1)
})

test("AC8 hook: a ladder edit applies on the next call without a restart", async (t) => {
  const h = await createHarness(t)
  h.writeConfig({ enabled: true, logPath: h.logPath, ladders: { rpm: [3_000] } })

  const before = makeEvent({ message: "rpm_rate_limit_exceeded", attempt: 2 })
  h.emit(before)
  assert.ok(before.decision.retry === true)
  assert.ok(before.decision.delay >= 2_100 && before.decision.delay <= 3_900, String(before.decision.delay))

  h.writeConfig({ enabled: true, logPath: h.logPath, ladders: { rpm: [1_000] } })
  const after = makeEvent({ message: "rpm_rate_limit_exceeded", attempt: 2 })
  h.emit(after)
  assert.ok(after.decision.retry === true)
  assert.ok(after.decision.delay >= 700 && after.decision.delay <= 1_300, String(after.decision.delay))

  h.writeConfig({ enabled: true, logPath: h.logPath })
  const reset = makeEvent({ message: "rpm_rate_limit_exceeded", attempt: 2 })
  h.emit(reset)
  assert.ok(reset.decision.retry === true)
  assert.ok(reset.decision.delay >= 2_100 && reset.decision.delay <= 3_900, String(reset.decision.delay))
})

test("AC8 hook: a half-written config keeps the ladder that was working", async (t) => {
  const h = await createHarness(t)
  h.writeConfig({ enabled: true, logPath: h.logPath, ladders: { rpm: [1_000] } })

  const before = makeEvent({ message: "rpm_rate_limit_exceeded", attempt: 2 })
  h.emit(before)
  assert.ok(before.decision.retry === true)
  assert.ok(before.decision.delay >= 700 && before.decision.delay <= 1_300, String(before.decision.delay))

  h.writeRawConfig('{"enabled": true, "ladders": {"rpm": [')
  const during = makeEvent({ message: "rpm_rate_limit_exceeded", attempt: 2 })
  h.emit(during)
  assert.ok(during.decision.retry === true)
  assert.ok(during.decision.delay >= 700 && during.decision.delay <= 1_300, String(during.decision.delay))
})

test("AC8 hook: malformed ladder entries fall back to the built-in row", async (t) => {
  const h = await createHarness(t)
  h.writeConfig({ enabled: true, logPath: h.logPath, ladders: { rpm: ["soon", 0, null] } })

  const event = makeEvent({ message: "rpm_rate_limit_exceeded", attempt: 2 })
  h.emit(event)
  assert.ok(event.decision.retry === true)
  assert.ok(event.decision.delay >= 2_100 && event.decision.delay <= 3_900, String(event.decision.delay))
})

test("AC9 trace: the directory is created and every line carries the required fields", async (t) => {
  const h = await createHarness(t)
  h.writeConfig({ enabled: true, logPath: h.logPath })
  assert.equal(existsSync(dirname(h.logPath)), false)

  const retry = makeEvent({ message: "rpm_rate_limit_exceeded", attempt: 3 })
  h.emit(retry)

  assert.equal(existsSync(h.logPath), true)
  const line = h.lines().at(0) as string
  for (const field of [
    "provider=baidu-qianfan-token-plan",
    "type=provider.quota",
    "category=rpm",
    "action=retry",
    "attempt=3",
    "cap=9",
    "message=",
    "delayMs=",
  ]) {
    assert.ok(line.includes(field), `missing ${field} in ${line}`)
  }
  assert.match(line, /delayMs=\d+/)
})

test("AC9 trace: a 2000 character message is truncated to 512", async (t) => {
  const h = await createHarness(t)
  h.writeConfig({ enabled: true, logPath: h.logPath })

  const event = makeEvent({ message: `request rate limit exceeded ${"x".repeat(2_000)}`, attempt: 2 })
  h.emit(event)

  const message = loggedMessage(h.lines().at(0) as string)
  assert.ok(message.length <= 512, String(message.length))
  assert.ok(message.startsWith("request rate limit exceeded"))
})

test("AC9 trace: credentials in the message never reach the log", async (t) => {
  const h = await createHarness(t)
  h.writeConfig({ enabled: true, logPath: h.logPath })

  const credential = ["sk", "fixture", "credential123456"].join("-")
  const password = "abc123fixture"
  const event = makeEvent({
    message: `429 request rate limit exceeded; Authorization: Bearer ${credential}; token${"="}${password}`,
    attempt: 2,
  })
  h.emit(event)

  const line = h.lines().at(0) as string
  assert.ok(!line.includes(credential), `credential leaked: ${line}`)
  assert.ok(!line.includes(password), `token leaked: ${line}`)
  assert.ok(line.includes("[redacted]"))
  assert.equal(event.decision.retry, true)
})

test("dispose releases the retry registration exactly once", async (t) => {
  const h = await createHarness(t)
  assert.equal(h.handlerCount(), 1)
  assert.equal(h.disposeCalls(), 0)

  await h.dispose()
  assert.equal(h.disposeCalls(), 1)

  await h.dispose()
  assert.equal(h.disposeCalls(), 1)
})