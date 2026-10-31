# CLI signals: usage limits, auth, headless calls, first-run blockers

How Morrow reads Claude Code and Codex CLI output: when a CLI hit a subscription limit (start a cooldown), when it's a transient throttle (retry, no cooldown), when auth is gone (ask for re-login), and when it crashed.

Every string below comes from one of three kinds of source:

- **Binary / source code**: strings pulled from the shipped artifact.
  - Claude Code **2.1.312**: native binary, `~/.local/share/claude/versions/2.1.312`. This matches npm `@anthropic-ai/claude-code@2.1.312`, whose npm package is only a wrapper that pulls the platform binary.
  - Claude Code **2.1.288**: the older installed binary, used to diff versions.
  - Codex **0.165.0**: source at tag `rust-v0.165.0` of `openai/codex`, cross-checked against the `@openai/codex@0.165.0-darwin-arm64` binary. Older Codex tags `rust-v0.20.0`, `rust-v0.30.0` and `rust-v0.46.0` were read for legacy formats.
- **Official docs**:
  - Claude Code: `code.claude.com/docs/en/errors`, `/headless`, `/cli-reference`, `/authentication`, `/env-vars`.
  - Codex: `learn.chatgpt.com/docs/non-interactive-mode` (redirect target of `developers.openai.com/codex/noninteractive`).
- **GitHub issues with pasted output** in `anthropics/claude-code` and `openai/codex`, cited by issue number.

Nothing below was produced by running either CLI against a real account.

---

## 0. Read this first (things that will bite you)

1. **Strings change between versions. Do not rely on one regex.**
   - Claude Code 2.1.288 printed `You've hit your session limit`. 2.1.312 prints `You've hit your 5-hour limit`: the limit-name map changed from `five_hour:"session limit"` to `five_hour:"5-hour limit"`.
   - Older Claude Code printed `Claude AI usage limit reached|<epoch>`, `Claude usage limit reached. Your limit will reset at ...` and `5-hour limit reached ∙ resets ...`.
   - Codex went from straight `'` to curly `’`, and from `Try again in 2 days 3 hours` to `try again at Mmm Dth, YYYY h:mm PM`.
2. **Prefer structured fields over regex wherever you can.**
   - Claude `-p --output-format json`: the result has `is_error`, `api_error_status` (HTTP code) and `api_error` (`"usage_limit_reached"` for a plan or spend limit).
   - Claude `stream-json`: carries `rate_limit_event` messages with `rate_limit_info.resetsAt` as epoch seconds.
   - Caveat: the binary's schema marks `api_error`, `api_error_status` and `api_error_params` as `@internal`, so treat them as best-effort and keep the regex fallback.
   - Codex `exec --json` has **no** structured error code, only `message` text, so Codex needs regex.
3. **Both status commands only check that credentials exist locally.** They do not check that the server accepts them.
   - `claude auth status` sets `loggedIn` from local token / API key presence: `N=!D&&(f||u!=="none"||O||U)`.
   - `codex login status` only loads `auth.json`.
   - A revoked or expired token still reports "logged in". Confirm with a real headless probe (section 4).
4. **`claude --bare` ignores subscription logins.** The binary help says: *"Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read)."* Never pass `--bare` for a Pro/Max account.
5. **Set `TZ=UTC` for every spawned CLI.**
   - Claude prints the reset time in the process time zone and appends it as `(America/Los_Angeles)`.
   - Codex prints the reset time in **local time with no zone at all** (`format_retry_timestamp` uses chrono `Local`).
   - With `TZ=UTC`, Codex timestamps are unambiguous.
6. **Normalize before matching**, in this order:
   1. Strip ANSI/OSC escapes.
   2. Replace U+00A0 and U+202F with a space.
   3. Collapse runs of whitespace, including newlines. TUIs wrap lines: issue #9236 shows `Your limit will reset\nat 3pm`.
   4. Map `’` to `'`, and `∙` (U+2219) and `•` to `·` (U+00B7).
   5. Drop leading UI glyphs: `⎿`, `■`, `ERROR:`.
7. **Warnings are not limits.** Never cool down on these:
   - Claude: `You've used 85% of your session limit · resets h:mmpm`, `You're close to your ...`, `Over N% of your ... used`, `Approaching your 5-hour usage limit`.
   - Codex: `Heads up, you have less than N% of your <label> limit left. Run /status for a breakdown.`
   - Claude's own classifier puts `You've used` / `You're close to` in a separate warning list (`Xos`).

---

## 1. Claude Code

### 1.1 How the limit message is built (2.1.312 source)

- Builder: `M(limitName, suffix) => \`You've hit your ${limitName}${suffix}${progressSaved}\``.
  - `progressSaved` is `" · progress saved"` behind a flag.
- Limit names (`Wce` map): `five_hour:"5-hour limit"`, `seven_day:"weekly limit"`, `seven_day_opus:"Opus limit"`, `seven_day_sonnet:"Sonnet limit"`, `seven_day_overage_included:"Fable limit"`, `overage:"usage credit limit"`.
  - In 2.1.288 the same map had `five_hour:"session limit"`.
  - On Pro and Enterprise plans, `seven_day_sonnet` is reported as `weekly limit` (`pBt()`).
- Suffix: `` ` · resets ${tk(resetsAt,true)}` `` when a reset is known. The separator is ` · ` (U+00B7).
- Claude Code's own "is this a usage-limit message" test (`G_i`) checks whether the message **starts with** one of:
  `You've hit your`, `You've reached your`, `You're out of usage credits`, `Your org is out of usage · add funds to continue`, `Your org is out of usage · contact your admin`, `Your seat type doesn't include usage credits`, `Your seat type doesn't include usage`, `Your usage allocation has been disabled by your admin`, `Your group's usage limit is set to $0`, `Fable 5 requires usage credits`, `You're out of extra usage`, `Your seat type doesn't include extra usage`, or matches `/^(?:Fable|Haiku|Mythos|Opus|Sonnet)(?: [^·\n]{1,40})? requires usage credits\./`.
  - When the 429 is a plan limit, the message gets `apiError:"usage_limit_reached"` plus `apiErrorParams.rate_limit_info`.
- Reset formatter (`BA(epochSec, withTz=true)`):
  - **< 24 h away:** `toLocaleTimeString("en-US",{hour:"numeric",minute: m===0?undefined:"2-digit",hour12:true})`, with ` AM`/` PM` lowercased and the space removed. Then ` (${IANA zone})`. Gives `3pm (America/Los_Angeles)` or `h:mmpm (Europe/Berlin)`.
  - **> 24 h away:** `toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:...})`, plus `year:"numeric"` when the year differs. Gives `Mmm D, hpm (UTC)` or `Mmm D, YYYY, h:mmam (UTC)`.
  - The zone comes from `Intl.DateTimeFormat().resolvedOptions().timeZone`.

### 1.2 Message patterns

Apply after the normalization in section 0. `RESET` is the shared reset sub-pattern from 1.3.

| # | Exact string (example) | Proposed regex (JS) | Category | Reset parse | Source | Version |
|---|---|---|---|---|---|---|
| C1 | `You've hit your 5-hour limit · resets 3pm (America/Los_Angeles)` | `/You've hit your (?<limit>5-hour limit\|session limit\|weekly limit\|Opus limit\|Sonnet limit\|Fable limit\|limit\|usage limit)\b/` | usage_limit | `RESET` after `· resets ` | binary `Wce`, `M()`, `BA()` | 2.1.312 |
| C2 | `You've hit your session limit · resets 1pm (Europe/Berlin)` | same as C1 | usage_limit | same | 2.1.288 binary (`five_hour:"session limit"`); issue #61828 | 2.1.288 and nearby |
| C3 | `You've hit your weekly limit · resets Mmm D, 9pm (America/New_York)` | same as C1 | usage_limit | `RESET` (date form) | issue #78982 | not stated |
| C4 | `You've hit your weekly limit · resets in 6d` | `/resets in (?<rel>(?:\d+d)?\s*(?:\d+h)?\s*(?:\d+m)?)/` | usage_limit | relative from now (only one sample, low confidence) | issue #78982 | not stated |
| C5 | `You've hit your session limit · resets h:mmpm` / `You've hit your weekly limit · resets Mon h:mmam` / `You've hit your Opus limit · resets h:mmpm` / `You've hit your Sonnet limit · resets h:mmpm` | same as C1 | usage_limit | `RESET` (weekday form is docs-only; the 2.1.312 formatter never prints a weekday) | docs `/errors#youve-hit-your-session-limit` | docs |
| C6 | `You've hit your limit · resets hpm (UTC)` / `You've hit your limit · resets 3pm (Asia/Tbilisi)` | same as C1 (`limit` alternative) | usage_limit | `RESET` | issue #9236 (comments) | ~2.0.x, not stated |
| C7 | `Claude usage limit reached. Your limit will reset at 3pm (America/Santiago).` | `/Claude usage limit reached\. Your limit will reset at (?<when>[^.]+?)\.?(?:\s\|$)/` | usage_limit | `RESET` body without `resets ` | issues #9236, #8959 (`... at ham (UTC).`), #8620 (`... at Mmm D, 1am`) | ~2.0.x, not stated |
| C8 | `Claude AI usage limit reached\|1749924000` | `/Claude AI usage limit reached\|(?<epoch>\d{10})/` | usage_limit | `new Date(epoch*1000)` | issues #2087, #4082, #9046 | 1.0.x era, not stated |
| C9 | `5-hour limit reached ∙ resets 12pm` / `Session limit reached ∙ resets 6pm` | `/(?<limit>5-hour\|Session\|Weekly\|Opus\|Sonnet) limit reached [·∙] resets (?<when>.+)$/i` | usage_limit | `RESET` | issues #6457, #8926 | not stated |
| C10 | `You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message` (also `individual spend limit`, `org's monthly spend limit`, `team's shared budget`, `channel's monthly spend limit`, `individual usage limit`, `org's monthly usage limit`) | `/You've hit your (?:monthly spend limit\|individual (?:spend\|usage) limit\|org's monthly (?:spend\|usage) limit\|team's shared budget\|channel's monthly (?:spend\|usage) limit)/` | usage_limit (spend cap) | Optional `· your <window> resets <RESET>`. Without it, there's no auto-reset: needs a human. | docs `/errors#youve-hit-your-monthly-spend-limit`; binary | 2.1.312 |
| C11 | `You're out of usage credits · resets ...` / `Your org is out of usage · add funds to continue` / `You're out of extra usage` / `<Model> requires usage credits.` | `G_i` prefix list from 1.1 | usage_limit (credits) | Optional `· resets RESET` | binary `GQr`, `qos` | 2.1.312 |
| C12 | `Goal paused · usage limit reached · send a message after it resets to continue` | `/usage limit reached · (?:send a message after it resets\|continues automatically when it resets)/` | usage_limit (secondary echo; take the reset from C1) | none | binary | 2.1.312 |
| T1 | `API Error: Server is temporarily limiting requests (not your usage limit)` (may continue ` · <server text>`) | `/Server is temporarily limiting requests \(not your usage limit\)/` | rate_limit_transient | none | docs `/errors#server-is-temporarily-limiting-requests`; binary `t4o` | 2.1.312 |
| T2 | `API Error: Request rejected (429) · this may be a temporary capacity issue. If it persists, check https://status.claude.com.` | `/API Error: Request rejected \(429\)/` | rate_limit_transient. API key / Bedrock / Vertex limit, not a subscription limit. | none | docs `/errors#request-rejected-429`; binary | 2.1.312 |
| T3 | `API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment. If it persists, check https://status.claude.com.` | `/Repeated 529 Overloaded errors/` | rate_limit_transient | none | docs `/errors#api-error-repeated-529-overloaded-errors`; binary `Ske` | 2.1.312 |
| T4 | `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}` | `/API Error:? \(?529\b\|"type":"overloaded_error"/` | rate_limit_transient | none | issues #2919, #35704, #35487 | older |
| T5 | `API Error (529 {...}) · Retrying in 4 seconds… (attempt 4/10)` | `/· Retrying in \d+ seconds… \(attempt \d+\/\d+\)/` | rate_limit_transient (still retrying, no action) | none | issue #2919 | older |
| T6 | `Opus is experiencing high load, please use /model to switch to Sonnet` / `Fable is experiencing high load, please use /model to switch to Sonnet` | `/(?:Opus\|Fable) is experiencing high load/` | rate_limit_transient | none | docs; binary `Lht`, `Nht` | 2.1.312 |
| T7 | `Request timed out` / `API Error: 500 ...` | `/^Request timed out$\|API Error: 5\d\d\b/` | rate_limit_transient | none | docs `/errors#request-timed-out`, `#api-error-500-internal-server-error` | 2.1.312 |
| A1 | `Not logged in · Please run /login` | `/Not logged in · (?:Please run\|Run) \/login/` | auth_required | n/a | docs `/errors#not-logged-in`; binary `Ban` | 2.1.312 |
| A2 | `OAuth token revoked · Please run /login` | `/OAuth token revoked · Please run \/login/` | auth_required | n/a | docs `/errors#oauth-token-revoked-or-expired`; binary `S$t` | 2.1.312 |
| A3 | `Login expired · Please run /login` | `/Login expired · (?:Please run \/login\|Run \/login)/` | auth_required | n/a | docs `/errors#login-expired`; binary `KYo` | 2.1.312 |
| A4 | `Please run /login · API Error: 401 OAuth token has expired ...` / `Please run /login · API Error: 401 Invalid authentication credentials` | `/Please run \/login · API Error: 401/` | auth_required | n/a | docs `/errors` | 2.1.312 |
| A5 | `API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."},"request_id":"req_..."} · Please run /login` | `/API Error: 401\b.*authentication_error\|OAuth token has expired/` | auth_required | n/a | issues #12447, #33811, #33879 | older 2.x |
| A6 | (`-p`) `Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.` / `Failed to authenticate. API Error: 401 OAuth token has expired ...` / `Failed to authenticate: OAuth session expired and could not be refreshed` | `/Failed to authenticate[.:]/` | auth_required | n/a | docs `/errors` (non-interactive variants); binary `o4o` | 2.1.312 (pre-2.1.287 revoked text: `Your account does not have access to Claude. Please login again or contact your administrator.`) |
| A7 | `Invalid API key · Fix external API key` (older: `Invalid API key · Please run /login`) | `/Invalid API key · (?:Fix external API key\|Please run \/login)/` | auth_required | n/a | docs `/errors#invalid-api-key`; issues #5167, #1634 | 2.1.312 / 1.x |
| A8 | `Authentication required · Sign in again to continue` | literal | auth_required (Desktop-hosted variant of A1) | n/a | docs; binary `BYo` | 2.1.312 |
| A9 | `Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access` | `/disabled Claude subscription access for Claude Code/` | auth_required (org policy, no reset) | n/a | binary `n4o` | 2.1.312 |
| A10 | `Credit balance is too low` | literal | auth_required. On a subscription box it means a stray `ANTHROPIC_API_KEY` is in use. | n/a | docs `/errors#credit-balance-is-too-low` | 2.1.312 |
| A11 | `Not logged in. Run claude auth login to authenticate.` (`claude auth status --text`) | literal | auth_required | n/a | binary `authStatus` | 2.1.312 |
| X1 | `Execution error` (text-mode `-p`, subtype `error_during_execution`) / `Error: Reached max turns (N)` | `/^Execution error$/` | crash (max turns is a config error, not a crash) | n/a | binary print formatter | 2.1.312 |
| X2 | `Session crashed (` ... | `/Session crashed \(/` | crash | n/a | binary | 2.1.312 |

**Matching order:** auth (A*), then usage (C*), then transient (T*), then crash (X*). Some transient lines contain the words "usage limit" (`not your usage limit`), so T1 must win over any broad `usage limit` match. Anchor C-patterns on `You've hit your` / `limit reached`, never on bare `usage limit`.

### 1.3 Reset-time parsing (Claude)

```js
// After normalization. Covers C1-C9.
const RESET = /resets? (?:at )?(?<when>(?:(?<wd>Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?(?:(?<mon>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?<day>\d{1,2}), (?:(?<year>\d{4}), )?)?(?<hour>\d{1,2})(?::(?<min>\d{2}))?(?<ampm>am|pm))(?: \((?<tz>[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*)\))?/i;
```

- **No date part** (`3pm`, `h:mmpm`): the next occurrence of that wall time in `tz`. Fall back to the CLI process TZ (`UTC` if you set it). Source: `BA` only omits the date when the reset is <24 h away.
- **Date part** (`Mmm D, 3pm`): that date in `tz`. A missing year means the current year in `tz`, because `BA` adds `year` only when it differs.
- **Epoch form** (C8): `new Date(Number(epoch) * 1000)`.
- **Better than regex:** stream-json `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":<epoch sec>,"rateLimitType":"five_hour"|"seven_day"|"seven_day_opus"|"seven_day_sonnet"|"seven_day_overage_included"|"overage",...}}`. Use it when `status==="rejected"`. `allowed_warning` is only a warning. Source: binary schema `FF` / `GXr`.
- **Edge case:** the text after `resets` can be followed by ` (error type rate_limit, HTTP 429, ...)` inside agent errors (issue #61828). The TZ group stops at `)`, so the trailing parenthetical is not part of the time.

### 1.4 Examples

| Input | Parsed (process TZ = UTC, "now" = some instant N) |
|---|---|
| `You've hit your 5-hour limit · resets 3pm (America/Los_Angeles)` | next 15:00 America/Los_Angeles after N |
| `You've hit your weekly limit · resets Mmm D, 9pm (America/New_York)` | Mmm D, 21:00 America/New_York, current year |
| `Claude usage limit reached. Your limit will reset at Mmm D, 1am` | Mmm D, 01:00 in process TZ |
| `Claude AI usage limit reached\|1760000400` | epoch 1760000400 |

---

## 2. Codex CLI

### 2.1 How the limit message is built (0.165.0 source)

- `codex-rs/protocol/src/error.rs`, `impl Display for UsageLimitReachedError`. The apostrophe is **U+2019** (`You’ve`).
- Raised only when the backend answers **HTTP 429** with `error.type == "usage_limit_reached"`. `resets_at` comes from the body as epoch seconds (`codex-api/src/api_bridge.rs`).
- Any other 429 becomes `exceeded retry limit, last status: 429 Too Many Requests[, request id: …]`, which is transient.
- Variants, in the order the code checks them:
  - Per-model limit: `You’ve hit your usage limit for {limit_name}. Switch to another model now,{or-suffix}`
  - Workspace / credits (no reset):
    - `Your workspace is out of credits. Add credits to continue.`
    - `Your workspace is out of credits. Ask your workspace owner to refill in order to continue.`
    - `You hit your spend cap set in your workspace. Increase your spend cap to continue.`
    - `You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.`
  - Server promo: `You’ve hit your usage limit. {promo_message},{or-suffix}`
  - Plus: `You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits{or-suffix}`
  - Team / Business / Enterprise-CBP / Sci: `You’ve hit your usage limit. To get more access now, send a request to your admin{or-suffix}`
  - Free / Go: `You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus),{or-suffix}`
  - Pro / ProLite / ProMax: `You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits{or-suffix}`
  - Enterprise / Edu / unknown plan: `You’ve hit your usage limit.{suffix}`
- Suffixes:
  - `{or-suffix}` = ` or try again at {ts}.` or ` or try again later.`
  - `{suffix}` = ` Try again at {ts}.` or ` Try again later.`
- `{ts}` (`format_retry_timestamp`, **local time, no zone**):
  - Same local day: `%-I:%M %p`, e.g. `h:mm AM`.
  - Otherwise: `%b %-d{st|nd|rd|th}, %Y %-I:%M %p`, e.g. `Mmm Dth, YYYY h:mm PM`.
- Legacy:
  - 0.30.0 and 0.46.0: `Try again in {n days n hours n minutes}` / `less than a minute`, straight `'`.
  - 0.20.0: `Limits reset every 5h and every week.` with no time.

### 2.2 Message patterns

All matched after normalization (`’` mapped to `'`).

| # | Exact string (example) | Proposed regex (JS) | Category | Reset parse | Source | Version |
|---|---|---|---|---|---|---|
| D1 | `You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at h:mm AM.` | `/You've hit your usage limit(?: for (?<limit>[^.]+?))?[.,]/` | usage_limit | `CODEX_AT` / `CODEX_IN` (2.3) | source `error.rs`; issue #12299 (0.137.0 shows the `chatgpt.com/codex/settings/usage` URL, so don't match on the URL) | 0.137.0, 0.165.0 |
| D2 | `You’ve hit your usage limit. To get more access now, send a request to your admin or try again at Mmm Dth, YYYY h:mm PM.` | same as D1 | usage_limit | `CODEX_AT` | issues #16917, #16906; `error_tests.rs` | 0.165.0 and earlier |
| D3 | `You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Mmm Dth, YYYY h:mm ...` | same as D1 | usage_limit | `CODEX_AT` | issue #32680; source | recent |
| D4 | `You’ve hit your usage limit for <model>. Switch to another model now, or try again later.` | same as D1 (`limit` group) | usage_limit (per-model; other models may work) | `CODEX_AT` or none | source | 0.165.0 |
| D5 | `You’ve hit your usage limit. Try again later.` | same as D1 | usage_limit | none: use a default cooldown | source / `error_tests.rs` | 0.165.0 |
| D6 | `You've hit your usage limit. Try again in 2 days 3 hours 5 minutes.` / `... or try again in 3 hours 32 minutes.` / `... Try again in less than a minute.` | same as D1 | usage_limit | `CODEX_IN` | tags `rust-v0.30.0`, `rust-v0.46.0` `error.rs` tests | 0.30 to 0.46 |
| D7 | `You've hit your usage limit. Limits reset every 5h and every week.` | same as D1 | usage_limit | none | tag `rust-v0.20.0` | 0.20 |
| D8 | `You've hit your usage limit. Upgrade your plan or add credits to continue, or try again at Mmm D, YYYY, h:mm PM.` | same as D1 | usage_limit | `CODEX_AT` (note `Mmm D, YYYY, h:mm PM` has no ordinal: this is the **Codex App** format, not CLI). The CLI equivalent is the promo branch. | issues #38379, #34360 (App) | App |
| D9 | `Your workspace is out of credits. Add credits to continue.` / `... Ask your workspace owner to refill in order to continue.` / `You hit your spend cap set in your workspace. Increase your spend cap to continue.` / `You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.` | `/Your workspace is out of credits\|You hit your spend cap set/` | usage_limit (no reset; needs human) | none | source | 0.165.0 |
| D10 | `Quota exceeded. Check your plan and billing details.` | literal | usage_limit (API key quota; no reset) | none | source (`QuotaExceeded`) | 0.165.0 |
| D11 | `To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.` | literal | usage_limit (plan does not include Codex; permanent until upgrade) | none | source (`UsageNotIncluded`) | 0.165.0 |
| R1 | `exceeded retry limit, last status: 429 Too Many Requests, request id: <id>` | `/exceeded retry limit, last status: 429\b/` | rate_limit_transient | none | source `RetryLimitReachedError` + `api_bridge.rs` | 0.165.0 |
| R2 | `rate limit exceeded: <server text>` | `/^rate limit exceeded: /` | rate_limit_transient | server text may say `Please try again in 11.054s` | source; `sse/responses.rs` test fixture | 0.165.0 |
| R3 | `Selected model is at capacity. Please try a different model.` | literal | rate_limit_transient | none | source (`ServerOverloaded`, from 503 `server_is_overloaded`) | 0.165.0 |
| R4 | `We’re currently experiencing high demand, which may cause temporary errors.` | `/currently experiencing high demand/` | rate_limit_transient (HTTP 500) | none | source (`InternalServerError`) | 0.165.0 |
| R5 | `Reconnecting... 2/5` / `Reconnecting... waiting for network` | `/Reconnecting\.\.\. (?:\d+\/\d+\|waiting for network)/` | rate_limit_transient (in-progress, no action) | none | `core/src/responses_retry.rs`; issue #25246 | 0.135.0+ |
| R6 | `stream disconnected before completion: <detail>` | `/stream disconnected before completion:/` | rate_limit_transient **unless** the detail matches an auth pattern (issue #25246 has `You didn't provide an API key`) | none | source | 0.165.0 |
| R7 | `Flex capacity unavailable.` | literal | rate_limit_transient | none | source | 0.165.0 |
| B1 | `Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.` (also `...was already used...`, `...was revoked...`, `Your access token could not be refreshed. Please log out and sign in again.`, `...because you have since logged out or signed in to another account. Please sign in again.`) | `/Your access token could not be refreshed/` | auth_required | n/a | `login/src/auth/manager.rs` consts | 0.165.0 |
| B2 | `unexpected status 401 Unauthorized: {"detail":"Unauthorized"}, url: https://chatgpt.com/backend-api/codex/responses, cf-ray: …, request id: …` | `/unexpected status 401 Unauthorized/` | auth_required | n/a | source `UnexpectedResponseError`; issues #25246, #39883, #48235 | 0.135 to 0.158 |
| B3 | `unexpected status 401 Unauthorized: Missing bearer or basic authentication in header` | same as B2 | auth_required | n/a | issue #30514 | 0.142.3 |
| B4 | `stream disconnected before completion: You didn't provide an API key. ...` / `Incorrect API key provided: ...` | `/You didn't provide an API key\|Incorrect API key provided/` | auth_required | n/a | issues #25246, #48241 | 0.141.0 / 0.158 |
| B5 | `Not logged in` (stderr of `codex login status`, exit 1) | `/^Not logged in$/` | auth_required | n/a | `cli/src/login.rs` | 0.165.0 |
| B6 | `Not inside a trusted directory and --skip-git-repo-check was not specified.` | literal | crash (config error; fix the invocation) | n/a | `exec/src/lib.rs` | 0.165.0 |
| Y1 | `internal error; agent loop died unexpectedly` / `Fatal error: …` / `turn failed` (JSONL fallback) / `exceeded retry limit, last status: 5xx …` | `/agent loop died unexpectedly\|^Fatal error: \|^turn failed$\|exceeded retry limit, last status: 5\d\d/` | crash | n/a | source; `event_processor_with_jsonl_output.rs` | 0.165.0 |
| W1 | `Heads up, you have less than 25% of your 5h limit left. Run /status for a breakdown.` | `/^Heads up, you have less than \d+% of your .+ limit left/` | **ignore** (warning) | n/a | `tui/src/chatwidget/rate_limits.rs` | 0.165.0 |

**Matching order:** auth (B*) first, because `stream disconnected ...` can wrap auth text. Then usage (D*), transient (R*), crash (Y*).

### 2.3 Reset-time parsing (Codex)

```js
const CODEX_AT = /try again at (?<ts>(?:(?<mon>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?<day>\d{1,2})(?:st|nd|rd|th)?, (?<year>\d{4}),? )?(?<h>\d{1,2}):(?<m>\d{2}) (?<ampm>AM|PM))/i;
const CODEX_IN = /try again in (?<dur>less than a minute|(?:\d+ days?)?\s*(?:\d+ hours?)?\s*(?:\d+ minutes?)?)\./i;
```

- **`CODEX_AT` with no date** (`h:mm AM`): today in the CLI's local zone. The code prints the bare time only when the reset falls on the same local date.
- **`CODEX_AT` with a date** (`Mmm Dth, YYYY h:mm PM`): that instant in the CLI's local zone. Run Codex with `TZ=UTC` so local = UTC. The optional comma also accepts the App form `Mmm D, YYYY, h:mm PM`.
- **`CODEX_IN`**: now + sum of days/hours/minutes. `less than a minute` = now + 60 s.
- **`try again later`**: no time. Use a default cooldown and re-probe.

Examples:

| Input (TZ=UTC) | Parsed |
|---|---|
| `... or try again at h:mm AM.` | today 04:01 UTC |
| `... or try again at Mmm Dth, YYYY h:mm PM.` | that calendar date, 15:31 UTC |
| `... Try again in 3 hours 32 minutes.` | now + 3 h 32 m |
| `... Try again later.` | unknown: default cooldown |

---

## 3. Status commands

### Claude Code: `claude auth status`

- **Output:**
  - JSON by default (`--json`); `--text` for human-readable.
  - Exit `0` if logged in, `1` if not (docs `/cli-reference`; binary: `process.exit(N?0:1)`).
- **JSON fields (2.1.312 source):**
  - Always: `loggedIn`, `authMethod` (`none` | `claude.ai` | `oauth_token` | `api_key` | `api_key_helper` | `third_party`), `apiProvider`, `analyticsDisabled`, `projectsDirectory`, `configDirectory` (v2.1.268+).
  - Optional: `forcedLoginMethod`, `allowedProviders`, `apiKeySource`.
  - For `claude.ai`: `email`, `orgId`, `orgName`, `subscriptionType`.
- **Text mode, not logged in:** `Not logged in. Run claude auth login to authenticate.`
- **Presence-only check** (see section 0.3).
- **Credential locations** (docs `/authentication#credential-management`):
  - Linux: `~/.claude/.credentials.json`, mode `0600`.
  - macOS: Keychain item `Claude Code-credentials` (service name from issue #5167's diagnostic script). Falls back to `~/.claude/.credentials.json` when the Keychain refuses the write (for example over SSH).
  - With `CLAUDE_CONFIG_DIR` set, the file lives under that directory instead.
  - `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) authenticates with no file at all.
  - To check "has a login" without reading contents: `stat` the file for existence and mode, or check that the env var is non-empty.
- **Global config `~/.claude.json`:** holds `oauthAccount` and `hasCompletedOnboarding` (binary). It contains account email and org, so don't log it.

### Codex: `codex login status`

- **Output goes to stderr, not stdout** (`cli/src/login.rs`):
  - `Logged in using ChatGPT` (exit 0)
  - `API key configured - <masked>` plus a notice (exit 0)
  - `Logged in using access token` / `personal access token` / `Amazon Bedrock API key` / `Amazon Bedrock AWS access keys` / `workload identity` (exit 0)
  - `Not logged in` (exit 1)
  - `Error checking login status: <err>` (exit 1)
- **Presence-only:** it loads stored auth and makes no server call.
- **Files:** `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`). Written only when `cli_auth_credentials_store` is `file`, which is the default per `config/src/types.rs` `AuthCredentialsStoreMode`. The `keyring`, `auto` and `ephemeral` modes may leave no file. `CODEX_API_KEY` works for `codex exec` with no file (docs).

---

## 4. Headless invocation recipes

### Claude Code (`-p`)

```bash
TZ=UTC claude -p "$PROMPT" \
  --output-format json \          # or stream-json --verbose (required pair) to get rate_limit_event
  --max-turns 3 \                 # print mode only; exits with error_max_turns when hit
  --tools "" \                    # disable all built-in tools ("default" or "Read,Grep" to allow some)
  --disallowedTools "mcp__*" \    # --tools doesn't affect MCP tools
  --permission-mode dontAsk \     # deny anything that would prompt (plan is another read-only option)
  --no-session-persistence \      # print mode only
  --json-schema "$SCHEMA_JSON"    # optional; result lands in .structured_output
# Do NOT add --bare for subscription logins (OAuth/keychain are never read in bare mode).
```

Flags verified in docs `/cli-reference`. `--json-schema` binary help: "JSON Schema for structured output validation (only works with --print)". `stream-json` without `--verbose` fails with `Error: When using --print, --output-format=stream-json requires --verbose` (binary).

**Result JSON** (`type:"result"`), from the 2.1.312 schema:

- **Success** (`subtype:"success"`): `duration_ms`, `duration_api_ms`, `is_error`, `api_error_status` (int|null), `api_error_code?`, `api_error?`, `num_turns`, `result` (string), `stop_reason`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`, `structured_output?`, `terminal_reason?`, `uuid`, `session_id`.
- **Error subtypes:** `error_during_execution`, `error_max_turns` (`errors:["Reached maximum number of turns (N)"]`), `error_max_budget_usd`, `error_max_structured_output_retries`. These carry `errors: string[]`.
- **A usage limit in `-p`** comes back as a result with `is_error:true`, `api_error_status:429`, `api_error:"usage_limit_reached"`, and the C1 text in `result`.
  - `usage_limit_reached` is set only when the text passes Claude's own `G_i` usage-limit prefix test.
  - A transient 429 has `api_error` unset and a T1/T2 text.
  - In stream-json, the assistant message also carries `error:"rate_limit"` and `api_error_params.rate_limit_info` (`resetsAt` epoch).
- **Auth failure:** `is_error:true`, text from A6. The stream `error` category is `authentication_failed`. Docs: "When a failure happens inside the run, such as missing authentication, Claude Code prints the failure as the result on stdout."
- **Exit codes:** docs say 0 on success, non-zero on failure. The binary's remote print path does `exit(result.is_error ? 1 : 0)`. There is no distinct exit code for usage limits, so classify from the JSON.
- `-p` does **not** wait for a reset: the auto-continue wait exists only in interactive claude.ai sessions (docs).
- `CLAUDE_CODE_RETRY_WATCHDOG` turns on an unattended retry mode that sleeps through limits. Leave it unset so Morrow owns the cooldown.
- **Retry events** (stream-json): `{"type":"system","subtype":"api_retry","attempt","max_retries","retry_delay_ms","error_status","error":"rate_limit"|"overloaded"|"authentication_failed"|…}` (docs `/headless#handle-api-retries`). These are informational; wait for the result.

### Codex (`codex exec`)

```bash
TZ=UTC codex exec \
  --json \                        # JSONL events on stdout (alias --experimental-json)
  --skip-git-repo-check \         # else exits 1 outside a git repo/trusted dir
  --sandbox read-only \           # read-only | workspace-write | danger-full-access (read-only is the exec default per docs)
  --ephemeral \                   # don't persist session files
  -C "$WORKDIR" \                 # working root
  -o "$OUT/last-message.txt" \    # --output-last-message; still printed to stdout too
  --output-schema ./schema.json \ # optional JSON Schema for the final message
  "$PROMPT"
```

- **Approvals:** `exec` forces `approval_policy: Never` ("Default to never ask for approvals in headless mode", `exec/src/lib.rs`), so no approval flag is needed. `--ask-for-approval` exists only on the TUI, and `--full-auto` is not present in 0.165.0.
- **JSONL events** (`exec/src/exec_events.rs`):
  - `{"type":"thread.started","thread_id":"…"}`
  - `{"type":"turn.started"}`
  - `{"type":"item.started"|"item.updated"|"item.completed","item":{"id":"…","type":"agent_message"|"reasoning"|"command_execution"|"file_change"|"mcp_tool_call"|"collab_tool_call"|"web_search"|"todo_list"|"error",…}}`
  - `{"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","cache_write_input_tokens","output_tokens","reasoning_output_tokens"}}`
  - `{"type":"turn.failed","error":{"message":"…"}}`
  - `{"type":"error","message":"…"}`
  - The final answer is the last `item.completed` with `item.type=="agent_message"` (`text`).
- **Usage limit in exec:** `{"type":"error","message":"You’ve hit your usage limit. … try again at …"}` and/or `{"type":"turn.failed","error":{"message":"…"}}`.
  - The message may get ` (<additional_details>)` appended.
  - Non-JSON mode prints `ERROR: <message>` to stderr.
  - Exit code is `1` whenever a non-retrying error or a failed/interrupted turn was seen (`error_seen` then `std::process::exit(1)`). No distinct code for limits.
- **Auth for automation:** `CODEX_API_KEY=<key> codex exec --json …` (docs). For ChatGPT-plan accounts, copy a valid `auth.json` into `$CODEX_HOME`.

---

## 5. First-run blockers in a fresh PTY

### Claude Code (interactive `claude`)

`-p` skips all of these. Docs: "A `-p` session shows no workspace trust dialog". The binary's trust check returns true when non-interactive.

| Screen (text from 2.1.312 binary) | When | Skip for a spawned agent |
|---|---|---|
| Theme picker: `Let's get started.` / `Choose the text style that looks best with your terminal` | onboarding not completed | `~/.claude.json`: `"hasCompletedOnboarding": true` and `"theme": "dark"` (`"dark"` is the default in the config defaults object). The binary sets `hasCompletedOnboarding:true` plus `lastOnboardingVersion` when onboarding finishes. *Inferred from source; verify once in a throwaway PTY.* |
| `Select login method` / `Security notes` / `Use Claude Code's terminal setup?` | same onboarding flow | same as above, plus valid credentials (`.credentials.json` or `CLAUDE_CODE_OAUTH_TOKEN`) |
| Trust dialog: `Quick safety check: Is this a project you created or one you trust? …` / `Yes, I trust this folder` | first open of a directory | `~/.claude.json`: `"projects": { "/abs/path": { "hasTrustDialogAccepted": true } }`. Default per-project object has `hasTrustDialogAccepted:false`. `CLAUDE_CODE_IGNORE_PERSISTED_TRUST` makes persisted trust ignored, so don't set it. |
| Bypass warning: `WARNING: Claude Code running in Bypass Permissions mode` / `Yes, I accept` | `--dangerously-skip-permissions` | settings key `"skipDangerousModePermissionPrompt": true` (schema: "Whether the user has accepted the bypass permissions mode dialog") |

Related env vars (docs `/env-vars`):

- `CLAUDE_CONFIG_DIR`: per-agent config dir. Also relocates `.credentials.json`.
- `DISABLE_AUTOUPDATER=1`.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`: disables updates, telemetry and feature-flag fetches. It also disables features that need flags.
- Make sure `ANTHROPIC_API_KEY` is **unset** on subscription boxes. A stray key takes precedence and produces `Credit balance is too low` or 429s on API tiers (docs `/errors`).

### Codex (interactive `codex`)

`codex exec` shows none of these. Its only gate is the git/trust check (`--skip-git-repo-check`).

| Screen (0.165.0 source) | When | Skip |
|---|---|---|
| Login: `Sign in with ChatGPT` … | `login_status == NotAuthenticated` and the provider requires OpenAI auth (`should_show_login_screen`) | valid `$CODEX_HOME/auth.json` or an API key login |
| Trust: `Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. …` with `Trust and continue` / `Quit` | the project has no saved trust | `$CODEX_HOME/config.toml`: `[projects."/abs/path"]` + `trust_level = "trusted"` (key path `projects."<key>".trust_level`, `tui/src/onboarding/onboarding_screen.rs`). The lookup (`get_active_project`) tries the folder, then the repository's main checkout (`resolve_root_git_project_for_trust`: a linked worktree resolves to it), by exact key. `relay-worker.sh exec` writes the main checkout's entry before each Codex worker starts. Agent Relay 14.0.0 answers only the older `Do you trust the contents of this directory?` wording, so a worker without the entry quits. Don't use `-c 'projects."/p".trust_level=…'`: `-c` splits the key on every `.` and keeps the quotes. |
| Update check | `check_for_update_on_startup` true | `check_for_update_on_startup = false` |
| Full-access warning, model-migration and rate-limit-nudge prompts | first use | `[notice]` table: `hide_full_access_warning = true`, `hide_rate_limit_model_nudge = true`, `model_migrations = { … }` (`config/src/types.rs` `Notice`) |

---

### Cursor Agent, Gemini CLI, Grok (workers)

| CLI | Folder trust | How a worker skips it |
|---|---|---|
| Cursor Agent 2026.10.22 | can ask before working in an untrusted folder | `--trust` (in `BRIDGED_HARNESS` and `READ_ONLY_ARGS`) |
| Gemini CLI 0.66.0 | folders are untrusted by default; stdio MCP servers need a trusted folder | `GEMINI_CLI_TRUST_WORKSPACE=true` (`relay-worker.sh exec`) |
| Grok 1.0.70 | can ask before working in an untrusted folder | `--trust` |

### Signal patterns for Gemini CLI and Grok

| ID | Example | Kind | Source |
|---|---|---|---|
| G1 | `Usage limit reached for gemini-2.5-pro.` | usage_limit | Gemini CLI 0.66.0 bundle |
| G2 | `You have exhausted your daily quota on this model.` | usage_limit | Gemini CLI 0.66.0 bundle |
| K1 | `Not signed in. Run \`grok login\` …` / `Not signed in. To authenticate without a browser, run:` | auth_required | Grok 1.0.70 binary strings |

No Cursor Agent pattern: its limit and sign-out wording was not found in the 2026.10.22 package. None of the three has a usage readout.

## 6. Test fixtures

### 6.1 Observed lines (docs or pasted in issues), verbatim except normalization noted

```text
# Claude Code: usage_limit
You've hit your session limit · resets h:mmpm                                  # docs /errors
You've hit your weekly limit · resets Mon h:mmam                              # docs /errors
You've hit your Opus limit · resets h:mmpm                                     # docs /errors
You've hit your Sonnet limit · resets h:mmpm                                   # docs /errors
You've hit your weekly limit · resets Mmm D, 9pm (America/New_York)           # #78982
You've hit your weekly limit · resets in 6d                                    # #78982
⎿ You've hit your limit · resets hpm (UTC)                                     # #9236
⎿ You've hit your limit · resets 3pm (Asia/Tbilisi)                            # #9236
⎿ You've hit your limit · resets 1am (Europe/Warsaw)                           # #9236
Agent "..." failed: Agent terminated early due to an API error: You've hit your session limit · resets 1pm (Europe/Berlin) (error type rate_limit, HTTP 429, request id req_011Cfwtf3ozq6qKrkf7BifvS, model sent to the API: claude-opus-5-5)   # #61828
Claude usage limit reached. Your limit will reset at 3pm (America/Santiago).   # #9236
Claude usage limit reached. Your limit will reset at ham (UTC).                # #8959
Claude AI usage limit reached|1749924000                                       # #2087
Claude AI usage limit reached|1753113600                                       # #4082
Claude AI usage limit reached|1760000400                                       # #9046
⎿ 5-hour limit reached ∙ resets 12pm                                           # #6457
Session limit reached ∙ resets 6pm                                             # #8926
You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message   # docs
You've hit your team's shared budget · ask your admin to raise it at https://claude.ai/admin-settings/usage     # docs

# Claude Code: rate_limit_transient (must NOT cool down)
API Error: Server is temporarily limiting requests (not your usage limit)      # docs
API Error: Request rejected (429) · this may be a temporary capacity issue. If it persists, check https://status.claude.com.   # docs
API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment. If it persists, check https://status.claude.com.   # docs
⎿  API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}   # #2919
⎿ API Error (529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}) · Retrying in 4 seconds… (attempt 4/10)   # #2919
Opus is experiencing high load, please use /model to switch to Sonnet           # docs

# Claude Code: warnings (must NOT match usage_limit)
You've used 85% of your session limit · resets h:mmpm                          # docs

# Claude Code: auth_required
Not logged in · Please run /login                                              # docs
OAuth token revoked · Please run /login                                        # docs
Login expired · Please run /login                                              # docs
Please run /login · API Error: 401 Invalid authentication credentials          # docs
Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.   # docs (-p)
Failed to authenticate: OAuth session expired and could not be refreshed       # docs (-p)
Invalid API key · Fix external API key                                         # docs
Invalid API key · Please run /login                                            # #5167
API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."},"request_id":"req_011CWR6QbR9zivmQtHS6Tzck"} · Please run /login   # #12447

# Codex: usage_limit
■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at h:mm AM.   # #12299 (v0.137.0)
You've hit your usage limit. To get more access now, send a request to your admin or try again at Mmm Dth, YYYY h:mm PM.   # #16917
You've hit your usage limit. To get more access now, send a request to your admin or try again at Mmm Dth, YYYY h:mm AM.    # #16906
You've hit your usage limit. Upgrade your plan or add credits to continue, or try again at Mmm D, YYYY, h:mm PM.          # #38379 (Codex App format)

# Codex: rate_limit_transient
ERROR: Reconnecting... 2/5                                                     # #25246

# Codex: auth_required
ERROR: unexpected status 401 Unauthorized: {"detail":"Unauthorized"}, url: https://chatgpt.com/backend-api/codex/responses, cf-ray: redacted, request id: redacted   # #25246 (v0.135.0)
ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header   # #30514 (v0.142.3)
■ stream disconnected before completion: You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth (i.e. Authorization: Bearer YOUR_KEY), or as the password field (with blank username) if you're accessing the API from your browser and are prompted for a username and password. You can obtain an API key from https://platform.openai.com/account/api-keys.   # #25246 (v0.141.0, unwrapped)
```

### 6.2 Template-derived lines (synthetic, built from source templates; label them as such in tests)

```text
You've hit your 5-hour limit · resets 3pm (America/Los_Angeles)                 # CC 2.1.312 M()+BA(), <24h
You've hit your weekly limit · resets Mmm D, hpm (UTC)                         # CC 2.1.312, >24h same year
You've hit your Opus limit · resets Mmm D, YYYY, h:mmam (UTC)                  # CC 2.1.312, different year
You've hit your 5-hour limit · resets hpm (UTC) · progress saved               # CC 2.1.312 flagged suffix
You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at h:mm PM.   # Codex 0.165.0 Pro, same day
You’ve hit your usage limit. Try again at Mmm Dth, YYYY h:mm PM.               # Codex 0.165.0 Enterprise/unknown
You’ve hit your usage limit. Try again later.                                  # Codex 0.165.0 error_tests.rs
You've hit your usage limit. Try again in 2 days 3 hours 5 minutes.            # Codex 0.46.0 error.rs test
You've hit your usage limit. Try again in less than a minute.                  # Codex 0.46.0 error.rs test
exceeded retry limit, last status: 429 Too Many Requests, request id: abc      # Codex 0.165.0, transient
Selected model is at capacity. Please try a different model.                   # Codex 0.165.0, transient
Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.   # Codex 0.165.0, auth
Heads up, you have less than 25% of your 5h limit left. Run /status for a breakdown.   # Codex 0.165.0, ignore
```

### 6.3 Structured fixtures (Claude `-p` JSON)

Field names from the 2.1.312 schema. Values are illustrative.

```json
{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"api_error":"usage_limit_reached","result":"You've hit your 5-hour limit · resets hpm (UTC)","num_turns":1,"session_id":"…","uuid":"…","duration_ms":0,"duration_api_ms":0,"stop_reason":null,"total_cost_usd":0,"usage":{},"modelUsage":{},"permission_denials":[]}
{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":2128705200,"rateLimitType":"five_hour"},"uuid":"…","session_id":"…"}
```

---

## 7. Open items (not verifiable without a live account)

- Whether 2.1.312 `-p` puts the limit on `subtype:"success"` with `is_error:true` (the schema allows it, and `api_error` is a success-variant field) or on `error_during_execution`. Handle both.
- The exact onboarding gate condition in Claude Code. The `hasCompletedOnboarding` skip is inferred from source, not traced to the one `if`. Smoke-test once in a disposable PTY before relying on it.
- Whether the Codex promo branch (`You’ve hit your usage limit. {promo_message},…`) uses the App wording from #38379 in the CLI. The CLI timestamp format would still be `Mmm Dth, YYYY h:mm PM`.
