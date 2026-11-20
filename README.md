# opencode-qianfan-error-policy

An OpenCode v2 server plugin that classifies Baidu Qianfan (千帆) provider errors and decides whether to retry them.

OpenCode classifies Qianfan rate limits as `provider.quota` and, since `QuotaExceeded` is not retryable, gives up after the first failure. Qianfan's RPM/TPM/QPS limits are minute-level: waiting out the window usually works, and parallel agents need more than one or two attempts. This plugin makes that decision from the error text instead.

- Only providers whose `providerID` starts with `baidu-qianfan` are touched.
- Every wait is jittered (`±30%`) so parallel sessions do not retry in lockstep.
- Errors that waiting cannot fix (5h/week/month quota, auth, billing, content safety, invalid request, unavailable model) fail immediately.
- No model switching, no second scheduling of a finished session, no dependency to install.

## Error matrix

Rules are evaluated in this order; the first match wins.

| Category | Matches (substring, case-insensitive) | Action | Ladder (ms) | Retries |
| --- | --- | --- | --- | --- |
| `long_quota` | `coding_plan_hour_quota_exceeded`, `coding_plan_week_quota_exceeded`, `coding_plan_month_quota_exceeded`, `quota has been exceeded`, `quota_exceeded` | fail | – | 0 |
| `auth` | `coding_plan_api_key_required`, `coding_plan_api_key_not_allowed`, `coding_plan_not_subscribed`, `coding_plan_subscription_expired`, `invalid_iam_token`, `invalid_appid` | fail | – | 0 |
| `billing` | `account_overdue` | fail | – | 0 |
| `content_safety` | `system_unsafe`, `user_setting_unsafe`, `functions_unsafe` | fail | – | 0 |
| `model` | `invalid_model`, `model_not_supported`, `model_offline` | fail | – | 0 |
| `invalid_request` | `invalid_messages`, `invalid_argument`, `characters_too_long`, `tokens_too_long`, `invalid_image_*` | fail | – | 0 |
| `cluster_capacity` | `cluster_rpm_rate_limit_exceeded`, `cluster_tpm_rate_limit_exceeded`, `coding_plan_cluster_rate_limited` | retry | 5000, 15000, 30000, 60000, 120000 | 5 |
| `tpm` | `input_tpm_rate_limit_exceeded`, `output_tpm_rate_limit_exceeded`, `tpm_rate_limit_exceeded` | retry | 5000 … 90000 | 7 |
| `rpm` | `rpm_rate_limit_exceeded`, `coding_plan_rate_limit_exceeded`, `request rate limit` | retry | 3000 … 90000 | 9 |
| `qps` | `user_rate_limit_exceeded`, `cluster_rate_limit_exceeded`, `preemptible_rate_limit_exceeded` | retry | 1000 … 20000 | 7 |
| `server_error` | `internal_error`, `dispatch_internal_error` | retry | 1000 … 16000 | 5 |
| `unknown` | nothing matched | retry once | 5000 | 1 |

Long-lived quotas are HTTP 429 as well, so they are matched before any retryable row. `provider.quota` is only the error *type*; classification is driven by the message.

The delay for retry `n` is `min(base × U(0.7, 1.3), 120000)`. OpenCode allows one initial request plus at most 10 retries; this plugin never asks for more than 9, and each category's cap is lower.

## Install (another machine)

Requirements: OpenCode v2, and a local checkout. The plugin has no runtime dependency and no build step.

```bash
git clone https://github.com/qnnp-me/opencode-qianfan-error-policy.git ~/opencode-qianfan-error-policy
```

Then add the directory to `plugins` in the OpenCode config (`~/.config/opencode/opencode.jsonc` for a global install, or `.opencode/opencode.jsonc` inside a project):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/you/opencode-qianfan-error-policy"]
}
```

Use an absolute path (or `~/…`, which OpenCode expands). Restart OpenCode once so the plugin loads; retry decisions afterwards follow config changes without another restart.

Alternative: copy `src/` into `.opencode/plugins/qianfan-error-policy/` — plugins there load automatically, and the `index.ts` at the root is picked up as the server part.

## Verify

```bash
opencode api get /api/plugin
```

The response should list `qianfan-error-policy`. A Qianfan retry or failure also appends a line to the trace file:

```bash
tail -n 20 ~/.cache/opencode/qianfan-error-policy.log
```

Each line looks like:

```
2026-01-01T00:00:00.000Z plugin=qianfan-error-policy provider=baidu-qianfan-token-plan type=provider.quota message="Token Plan Person request rate limit exceeded …" category=rpm action=retry attempt=2 delayMs=3087 cap=9 reason="requests-per-minute limit; back off on a 3s..90s ladder"
```

`action` is `retry` or `fail`. `delayMs=none` means the plugin vetoed the retry. Messages are truncated to 512 characters and credential shapes (`Authorization`, `api_key`, `token=`, `sk-…`) are redacted before they are written.

Repository tests run without installing anything:

```bash
node --test
```

## Configuration

Optional file: `~/.config/opencode/qianfan-error-policy.json` (override the location with `OPENCODE_QIANFAN_ERROR_POLICY_CONFIG`).

```json
{
  "enabled": true,
  "logPath": "~/.cache/opencode/qianfan-error-policy.log",
  "ladders": {
    "rpm": [3000, 6000, 10000, 15000, 20000, 30000, 45000, 60000, 90000]
  }
}
```

| Key | Meaning |
| --- | --- |
| `enabled` | `false` leaves every retry decision exactly as OpenCode proposed it, and stops tracing. |
| `logPath` | Trace file. `~/` is expanded; the directory is created on demand. `OPENCODE_QIANFAN_ERROR_POLICY_LOG` sets the default. |
| `ladders` | Per-category base delays in ms, replacing the built-in ladder for that category only. Entries must be positive numbers; invalid ladders are ignored. Caps are not configurable. |

The file is re-read when its mtime changes. A half-written edit is ignored, so the last working ladder stays in effect.

`qianfan-error-policy.example.json` shows every category at its default.

## Disable

Without restarting: set `"enabled": false` in the config file. The plugin then returns before touching `event.decision`, so OpenCode's own policy applies again.

Temporarily, before the first load: remove the entry from `plugins`.

## Rollback

```bash
# remove the "plugins" entry that points at opencode-qianfan-error-policy
# then restart OpenCode, then remove the checkout and the config file
rm -rf ~/opencode-qianfan-error-policy
rm -f ~/.config/opencode/qianfan-error-policy.json ~/.cache/opencode/qianfan-error-policy.log
```

Nothing else is written: no config entry is added automatically, no state is kept, and unloading disposes the hook registration.

## Limits

- Retries stop at the category cap, and never exceed OpenCode's hard limit of 10 attempts.
- Jitter spreads retries out; it does not guarantee that parallel sessions never retry within the same second.
- No model switching. `invalid_model`, `model_offline` and cluster saturation fail instead of switching models.
- A single request that is itself larger than the TPM budget is not specially detected; it uses the normal TPM ladder.
- Context-overflow recovery and the Multica error label are out of scope.

## Security

The plugin never sends the trace file anywhere, never reads credentials, and never writes anything but the trace file and the trace directory.