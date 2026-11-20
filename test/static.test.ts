import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { PROVIDER_PREFIX } from "../src/policy.ts"

const SRC_DIR = new URL("../src/", import.meta.url)
const policySource = readFileSync(new URL("policy.ts", SRC_DIR), "utf8")
const indexSource = readFileSync(new URL("index.ts", SRC_DIR), "utf8")
const SOURCES = [
  ["policy.ts", policySource],
  ["index.ts", indexSource],
] as const

test("AC5: the provider is read from event.model.providerID by prefix", () => {
  assert.equal(PROVIDER_PREFIX, "baidu-qianfan")
  assert.match(indexSource, /event\?\.model\?\.providerID/)
  assert.match(indexSource, /\.startsWith\(PROVIDER_PREFIX\)/)

  for (const [name, source] of SOURCES) {
    assert.doesNotMatch(source, /session\.get\(/, `${name} must not look up the session model`)
  }
})

test("AC6: no resume path and no cross-request failure counter exist in src", () => {
  const banned = ["resumeAfterAttempt", "scheduleResume", "failures"]
  for (const [name, source] of SOURCES) {
    for (const token of banned) {
      assert.ok(!source.includes(token), `${name} must not mention ${token}`)
    }
  }
  assert.doesNotMatch(indexSource, /setTimeout|setInterval/, "no self-scheduled resume timers")
})

test("the policy module stays importable without the OpenCode SDK", () => {
  for (const [name, source] of SOURCES) {
    assert.doesNotMatch(source, /from\s+["']@opencode/, `${name} must not import the SDK`)
    assert.doesNotMatch(source, /require\(/, `${name} must stay ESM`)
  }
})