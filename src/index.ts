/**
 * OpenCode v2 server plugin: Baidu Qianfan retry policy.
 *
 * The plugin only rewrites `event.decision` for `baidu-qianfan*` providers. Any
 * other provider is left exactly as OpenCode proposed it. There is no
 * `Plugin.define` import: the module is a plain default export with an `id` and
 * a `setup`, so a bare checkout needs no dependency installed.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  classify,
  isLadder,
  ladder,
  PROVIDER_PREFIX,
  type HookError,
  type LadderOverrides,
} from "./policy.ts"

const PLUGIN_ID = "qianfan-error-policy"
const CONFIG_ENV = "OPENCODE_QIANFAN_ERROR_POLICY_CONFIG"
const LOG_ENV = "OPENCODE_QIANFAN_ERROR_POLICY_LOG"
const MESSAGE_LIMIT = 512

export interface PolicyConfig {
  readonly enabled: boolean
  readonly logPath: string
  readonly ladders: LadderOverrides
}

export type RetryDecision = { retry: false } | { retry: true; delay: number }

/** Subset of the retry hook the plugin reads or writes. */
export interface RetryEvent {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string }
  readonly error: { readonly type: string; readonly message: string; readonly status?: number }
  readonly attempt: number
  decision: RetryDecision
}

export interface PluginRegistration {
  dispose(): Promise<void>
}

export interface PluginContext {
  readonly session: {
    hook(name: "retry", handler: (event: RetryEvent) => void): Promise<PluginRegistration>
  }
}

function defaultConfigPath(): string {
  return process.env[CONFIG_ENV] || join(homedir(), ".config", "opencode", "qianfan-error-policy.json")
}

function defaultLogPath(): string {
  return process.env[LOG_ENV] || join(homedir(), ".cache", "opencode", "qianfan-error-policy.log")
}

function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

function mergeConfig(raw: unknown, defaults: PolicyConfig): PolicyConfig {
  let config: PolicyConfig = { ...defaults, ladders: {} }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return config

  const record = raw as Record<string, unknown>
  if (typeof record.enabled === "boolean") config = { ...config, enabled: record.enabled }
  if (typeof record.logPath === "string" && record.logPath.trim() !== "") {
    config = { ...config, logPath: expandHome(record.logPath.trim()) }
  }

  const ladders: Record<string, readonly number[]> = {}
  const rawLadders = record.ladders
  if (rawLadders && typeof rawLadders === "object" && !Array.isArray(rawLadders)) {
    for (const [category, value] of Object.entries(rawLadders as Record<string, unknown>)) {
      if (isLadder(value)) ladders[category] = value.slice()
    }
  }
  return { ...config, ladders }
}

/**
 * mtime-keyed config reader: an edit applies on the next retry without a
 * restart, and a half-written file keeps the currently working ladder.
 */
function createConfigReader(configPath: string, fallbackLogPath: string): () => PolicyConfig {
  const defaults: PolicyConfig = {
    enabled: true,
    logPath: expandHome(fallbackLogPath),
    ladders: {},
  }
  let cached: { mtimeMs: number; config: PolicyConfig } = { mtimeMs: Number.NaN, config: defaults }

  return () => {
    let mtimeMs: number
    try {
      mtimeMs = statSync(configPath).mtimeMs
    } catch {
      cached = { mtimeMs: Number.NaN, config: defaults }
      return cached.config
    }
    if (mtimeMs !== cached.mtimeMs) {
      let next = cached.config
      try {
        next = mergeConfig(JSON.parse(readFileSync(configPath, "utf8")), defaults)
      } catch {
        // A half-written edit must not drop the working ladder.
      }
      cached = { mtimeMs, config: next }
    }
    return cached.config
  }
}

const AUTHORIZATION = /(authorization\s*:\s*(?:bearer|basic|token)?\s*)[^\s"',;&]+/gi
const KEY_VALUE = /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[=:]\s*)["']?[^\s"',;&]+/gi
const SK_KEY = /\bsk-[A-Za-z0-9_-]{6,}/g

/** Strip credential shapes out of an error message and cap its length. */
export function sanitizeMessage(text: string): string {
  const redacted = text
    .replace(AUTHORIZATION, "$1[redacted]")
    .replace(KEY_VALUE, "$1[redacted]")
    .replace(SK_KEY, "sk-[redacted]")
  return redacted.length > MESSAGE_LIMIT ? redacted.slice(0, MESSAGE_LIMIT) : redacted
}

const ensuredDirs = new Set<string>()

function trace(logPath: string, fields: Record<string, string | number>): void {
  try {
    const dir = dirname(logPath)
    if (!ensuredDirs.has(dir)) {
      mkdirSync(dir, { recursive: true })
      ensuredDirs.add(dir)
    }
    const body = Object.entries(fields)
      .map(([key, value]) => {
        const rendered =
          typeof value === "string" && (key === "message" || key === "reason")
            ? JSON.stringify(value)
            : String(value)
        return `${key}=${rendered}`
      })
      .join(" ")
    appendFileSync(logPath, `${new Date().toISOString()} plugin=${PLUGIN_ID} ${body}\n`)
  } catch {
    // Tracing must never break a retry.
  }
}

function handleRetry(event: RetryEvent, readConfig: () => PolicyConfig): void {
  const config = readConfig()
  if (!config.enabled) return

  const providerID = event?.model?.providerID
  if (typeof providerID !== "string" || !providerID.startsWith(PROVIDER_PREFIX)) return

  const error: HookError | undefined = event?.error
  const classification = classify(error, config.ladders)
  const decision = ladder(classification, event.attempt)

  if (decision.retry) {
    event.decision = { retry: true, delay: decision.delay }
  } else {
    event.decision = { retry: false }
  }

  trace(config.logPath, {
    provider: providerID,
    type: error?.type ?? "",
    message: sanitizeMessage(error?.message ?? ""),
    category: classification.category,
    action: decision.retry ? "retry" : "fail",
    attempt: Number.isFinite(event.attempt) ? event.attempt : 1,
    delayMs: decision.retry ? decision.delay : "none",
    cap: classification.cap,
    reason: decision.retry ? classification.reason : `${classification.reason} (veto=${decision.veto})`,
  })
}

export function createQianfanErrorPolicyPlugin(
  overrides: { configPath?: string; logPath?: string } = {},
) {
  const configPath = overrides.configPath ?? defaultConfigPath()
  const fallbackLogPath = overrides.logPath ?? defaultLogPath()
  const readConfig = createConfigReader(configPath, fallbackLogPath)

  return {
    id: PLUGIN_ID,
    async setup(ctx: PluginContext): Promise<() => Promise<void>> {
      const registration = await ctx.session.hook("retry", (event) => {
        try {
          handleRetry(event, readConfig)
        } catch {
          // A policy bug must leave OpenCode's own decision in place.
        }
      })

      let disposed = false
      return async () => {
        if (disposed) return
        disposed = true
        await registration.dispose()
      }
    },
  }
}

export default createQianfanErrorPolicyPlugin()