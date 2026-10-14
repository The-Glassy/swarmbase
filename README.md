# SwarmBase

Workflow orchestration for Connectome residents, as an MCPL server. A resident submits a JavaScript script that
orchestrates subagents (`agent()` / `parallel()` / `pipeline()`). SwarmBase runs it in the background, fans out the
subagents, and pushes the result back to the resident as a `push/event` when the run ends. A dashboard on the tailnet
shows every run live.

```
resident (MCPL host) ──MCPL over WS ?token=──▶ swarmbase daemon (127.0.0.1:7360)
                                                 ├─ script runner per run (node --experimental-permission + vm)
                                                 ├─ agent() → one headless `claude -p` (or `codex exec`) process per call
                                                 ├─ run store  ~/.swarmbase/runs/<stamp>-<runId>/
                                                 └─ dashboard  (tailscale serve → tailnet only)
```

Why it's a daemon and not a host module:
- Runs outlive the caller. A resident can restart mid-run; its completion notice is queued and delivered when it reconnects.
- One dashboard covers every caller.
- Subagent transcripts stay out of the resident's own memory store.

## Caller surface

| tool | does |
|---|---|
| `run` | start a run: `{script, args?, label?, model?, effort?, profile?, budgetUsd?, budgetTokens?, keepWork?}` → runId, immediately |
| `status` | phases, each agent's state and cost, recent log lines |
| `result` | the return value, paged |
| `cancel` | stop a run (finished agent results stay cached) |
| `list` | the caller's recent runs |
| `resume` | re-run a script; identical agent() calls that already succeeded replay from the journal for free |
| `guide` | the authoring reference (`src/guide.ts`) |

There are two feature sets. `swarmbase` uses `tools`. `swarmbase.notify` uses `pushEvents` and carries run-completion
notices: eventId `<runId>:end`, origin `{source: "swarmbase", kind: "run-end", runId}`. A host whose wake policy skips
unrecognized push events needs a rule placed before the skips, for example on agent-framework:

```json
{ "name": "swarmbase-wake", "match": { "scope": ["mcpl:push-event"], "source": "swarmbase" }, "behavior": "always" }
```

Notices for a caller that is offline wait in `~/.swarmbase/outbox.json` and go out when it reconnects. Failed pushes
retry with backoff.

## Scripts

A script is plain JavaScript that runs as the body of an async function: top-level `await` and `return` work. Hooks:
`agent(prompt, opts)`, `parallel(thunks)`, `pipeline(items, ...stages)`, `phase(title)`, `log(message)`, `args`,
`budget`. An optional `export const meta = {name, description}` labels the run. `agent()` resolves to text, or to an
object when `opts.schema` is given. It resolves to `null` when the agent fails or is skipped, and throws when the run
budget is spent. The full reference is what the `guide` tool returns.

`Date.now()`, argless `new Date()` and `Math.random()` throw, because they would break resume.

Each run's script executes in a child process under Node's permission model (no filesystem writes, no child
processes) inside a `vm` context. That context reaches the daemon only through a bridge of primitives and callbacks,
so no host-realm object is reachable from the script. A watchdog fails a run whose script busy-loops.

## Config — `~/.swarmbase/config.json` (or `$SWARMBASE_CONFIG`)

```jsonc
{
  "port": 7360,
  "publicUrl": "https://<machine>.<tailnet>.ts.net:7360",      // used in links handed to callers
  "engines": {
    "claude": { "bin": "/usr/local/bin/claude", "baseUrl": "https://<gateway>/anthropic" },  // baseUrl optional; null = the vendor API
    "codex":  { "bin": "/usr/local/bin/codex", "baseUrl": "https://<gateway>/codex",         // omit baseUrl to leave the engine off
                "sandbox": "bwrap", "maxTokensDefault": 3000000, "maxTokensMax": 3000000 }   // a bare bin name is resolved on PATH at start
  },
  "maxConcurrentAgents": 10, "perRunConcurrency": 8, "maxAgentsPerRun": 200,
  "dashboard": { "adminLogins": ["you@example.com"] },         // may cancel runs and skip agents
  "callers": [{
    "name": "resident-a",
    "tokenSha256": "<sha256 of the caller's MCPL token>",      // the token itself is never stored here
    "apiKeyFile": "~/.swarmbase/resident-a.key",               // API key or gateway token, 0600
    "engines": ["claude", "codex"], "maxProfile": "read",
    "cwdRoots": ["/srv/resident-a/files"],
    "defaultModels": { "claude": "claude-sonnet-5-5", "codex": "gpt-6-astra" },
    "runUsdDefault": 5, "runUsdMax": 25, "maxActiveRuns": 3,
    "runTokensDefault": 10000000, "runTokensMax": 30000000       // per-run token budget for codex agents
  }],
  "prices": { }                                                 // optional extra rows for spend estimates
}
```

To add a caller:
1. Generate a token: `openssl rand -hex 24 > ~/.swarmbase/mcpl-<name>.token`.
2. Put the token's sha256 in the config as `tokenSha256`.
3. Give the caller its own API key file, mode 0600.
4. Restart the daemon.

The host connects to `ws://127.0.0.1:7360/mcpl` with that token.

`apiBaseUrl` and `claudeBin` are still read as aliases of `engines.claude.baseUrl` / `.bin`, and `defaultModel` of
`defaultModels.claude`.

When an engine's `baseUrl` points at an inference gateway, every agent request carries `x-gate-origin: swarmbase`,
`x-gate-channel: <runId>` and `x-gate-counterparty: <n>:<label>`, so the gateway ledger attributes spend per run and
per agent. One key file per caller serves both engines when one gateway token is valid on both legs; give the swarm
its own gateway identity rather than the resident's, so a burst never moves the resident's pins or limits.

## Engines

| engine | subagent | models | budget |
|---|---|---|---|
| `claude` (default) | `claude -p` | Claude ids/aliases | `--max-budget-usd` from the CLI's own cost report |
| `codex` | `codex exec --json` | whatever the codex endpoint serves (`gpt-…`) | token ceiling (`opts.maxTokens`) reserved from the run's token budget; USD too when `prices` has a row for the model |

Scripts pick with `agent(prompt, { engine: 'codex' })`; a caller's `engines` list says which it may use. The run-level
`model` default applies to claude agents; codex agents fall back to the caller's `defaultModels.codex`.

The Codex CLI reports token usage only when its (single) turn ends, so the daemon runs a loopback **usage meter** that
each codex subagent's requests pass through on their way to `engines.codex.baseUrl`. The meter holds the caller's
gateway token (the CLI never sees it — it authenticates to the meter with a per-agent bearer), adds the `x-gate-*`
attribution, and reads the usage out of every response as it streams past (one SSE event in memory at a time, so a
long response counts like a short one); an agent is stopped when it crosses its token ceiling or, for priced models,
its USD cap. The meter relays exactly one route, `POST /responses`, so a meter bearer is worth nothing on any other
path of the gateway; and killing an agent (cancel, skip, timeout, ceiling) destroys its in-flight upstream request,
so it stops costing when it stops. Without a price row a codex agent counts as $0 against the run's USD budget — add
rows under `prices` to shadow-price it — which is why every run also carries a **token budget** (`budgetTokens`,
caller defaults `runTokensDefault` / `runTokensMax`): a codex agent reserves its ceiling from it while it runs, the
way `maxUsd` is reserved from the USD budget, and `agent()` throws once it is spent. `opts.maxTokens` is clamped to
`engines.codex.maxTokensMax`. When the meter saw no usage for a response it could not parse, the CLI's own
`turn.completed` count is used instead.

Codex isolation differs from Claude Code's, and the engine compensates:
- The CLI's own sandbox (bubblewrap on Linux) confines writes to the workspace but reads the whole disk; a named
  permission profile with `filesystem` deny entries blocks reads, but only as a deny-list, and the `-s` flag replaces
  it. The engine writes a throwaway `CODEX_HOME` per agent whose profile denies the daemon's secrets (key and token
  files, the config file, every run's records and agent files, the other agents' `config.toml` with their meter
  bearers), `.env`/token/credential files under the workspace, and the usual credential dirs; selects it with
  `default_permissions`; and never passes `-s`. Deny globs are expanded when the session starts and their accepted
  shapes differ between CLI versions (0.158 expands a `*` directory component, 0.162 does not), so the run records
  are enumerated as exact paths at agent start; only `*` in a last component and `**` (with `glob_scan_max_depth`)
  are relied on.
- By default (`engines.codex.sandbox: "bwrap"`) the whole CLI runs inside an **outer bubblewrap allow-list**: `/usr`
  (+ `/lib`, `/bin` …), a few `/etc` files, the agent's cwd (read-only unless the profile is `write`) and its
  throwaway `CODEX_HOME`; nothing else exists in its namespace, and the CLI's inner sandbox nests inside. The
  directories of `engines.codex.bin` and of the daemon's own `node` are mounted read-only too, and for an
  npm-installed CLI (`bin/codex` → `lib/node_modules/@openai/codex/bin/codex.js`) the whole `node_modules` tree,
  since the wrapper loads its platform package from a sibling directory. A bare `bin` name is resolved on `PATH`
  when the config loads, and the daemon refuses to start when it isn't found. Install `bubblewrap`, or set
  `"sandbox": "none"` to rely on the deny-list alone: an unwrapped shell reads everything the deny-list misses
  (other runs' work dirs, most of `$HOME`), so codex `read`/`write` are then offered only to callers whose
  `maxProfile` is `write` — the same trust the claude engine's unconfined Bash takes — and everyone else gets `think`.
- Tools per profile: `think` = none; `read` = a read-only shell with **no network** plus the CLI's web search;
  `write` = a shell that may write inside the cwd and has network (`permissions.swarm-write.network.enabled`;
  without it the CLI's sandbox has none at all, not even DNS). The outer wrapper shares the host's network namespace
  (the CLI must reach the meter), so a shell with network reaches every loopback service on the host — this daemon's
  own dashboard included — which is why `read` has none and `write` is for trusted callers only, like the claude
  engine's Bash. Sub-agents, goals, image viewing and user-input requests are off in every profile.
- `schema` is strict on this engine: the engine adds `additionalProperties: false` to every object, and `agent()`
  throws up front when a property is missing from `required` (optional = nullable type) or an object allows extras.
- `effort: "max"` is not a Codex level; it is sent as `xhigh`.
- `maxTokens` counts every request's full context, so a one-command task is ~10k tokens; keep the ceiling ≥ 50k.

Deploying the codex engine, in order: the caller's key file holds a gateway token valid on the codex leg (and on
the anthropic leg, if the caller also runs claude agents); `@openai/codex` installed with its platform package
(`codex --version` works as the daemon's user); `bubblewrap` installed; if `engines.codex.baseUrl` is signed by a
private CA, start the daemon with `NODE_EXTRA_CA_CERTS=<ca.pem>` — the meter's outbound TLS uses Node's trust store,
and the CLI itself only ever talks plain HTTP to the meter on loopback. A certificate failure surfaces on the agent
as `meter: upstream unable to verify the first certificate` with that hint.

## Profiles (what a claude subagent may touch)

| profile | CLI tools | confinement |
|---|---|---|
| think | none (`--tools=`); StructuredOutput only when a schema is given | — |
| read | Read, Grep, Glob, WebFetch, WebSearch | `Read(//<cwd>/**)`, which also governs Grep and Glob; reads outside are denied |
| write | + Edit, Write, Bash | `Edit`/`Write(//<cwd>/**)`; **Bash is not confined**, so trusted callers only |

Every claude subagent also runs with:
- `--permission-mode=dontAsk`: anything not allowed is denied, never asked.
- `--setting-sources=` (empty): no user, project or local settings, so a settings dir planted in the cwd is ignored.
- `--settings` deny rules for credential directories, `.env` and token files.
- `--strict-mcp-config` with an empty MCP config.
- `--no-session-persistence`.
- A minimal environment.

Its cwd is the run's `work/` dir unless the caller's policy allows another; the path is realpath-pinned. A plain
`--allowedTools=Read` was verified to let Read and Grep reach files outside the cwd, which is why the rules are
path-scoped.

## Budget

Each started agent reserves its cap, `opts.maxUsd` (default `max($0.50, budget/8)`), and runs with
`--max-budget-usd=<cap>`. Spend is settled when the agent ends and the unused reservation is returned. An agent that
can't reserve at least $0.03 waits while others hold reservations; when nothing can free up, `agent()` throws.
Overshoot is bounded by one model turn per running agent. Killed agents (skip, cancel, timeout) are costed from the
per-message usage they streamed.

Codex agents reserve their token ceiling (`opts.maxTokens`, default `maxTokensDefault`, clamped to `maxTokensMax`)
from the run's token budget (`budgetTokens`, default `runTokensDefault`, at most `runTokensMax`) the same way, and
settle what they used when they end. A codex agent without a price row still holds a USD reservation while it runs
(so paid agents' spend can refuse it) but settles at $0; the token budget is what bounds it.

## Dashboard

The daemon serves an HTTP dashboard on the same port:
- A run list.
- A page per run with per-phase agent rows, live over SSE.
- Per-agent prompt and transcript drill-down.

Publish it tailnet-only with `tailscale serve --bg --https=7360 http://127.0.0.1:7360`; never use Funnel. Viewing is
open to the tailnet. Cancel and skip require a `Tailscale-User-Login` listed in `dashboard.adminLogins` plus an
`X-SwarmBase: 1` header, which blocks cross-site POSTs. A Host allowlist blocks DNS rebinding.

## Ops

- Build: `npm install && npm run build`. Run: `node dist/src/index.js`.
- Service: on macOS, `ops/swarmbase.plist.template` is a launchd template.
- Disk: a run's `work/` (clones, toolchains, scratch; the bulk of a run on disk) is deleted when the run ends, and the work dirs of ended runs are swept on boot, unless the run was started with `keepWork: true` or the config sets `deleteWorkOnEnd: false`. `resume` starts a fresh run with its own `work/`; cached agent results replay as recorded, so one that names a file under the old `work/` points at nothing (keep the run's work, or have the agent return the content).
- Restart: stops every in-flight subagent. Runs are marked `interrupted` on the next boot, callers are notified, and `resume` replays finished agents for free. If the daemon died uncleanly, leftover agent process groups (claude and codex) are reaped on boot and interrupted runs' throwaway `CODEX_HOME`s are deleted.
- Tests: `npm test` (the codex engine suite runs its live cases when a Codex CLI is found — `CODEX_BIN` or the usual
  install paths — else skips them). `node test/runner-harness.mjs` exercises the runner sandbox. `node test/client.mjs <caller> <tool> '<json>' [--wait]` is a minimal MCPL host.

## Known limits

- There's no per-caller model allowlist.
- Codex agents: the outer wrapper shares the host network (the CLI needs it to reach the meter), so the `write`
  shell's network has no domain rules and reaches loopback services; `read` has no network for that reason. Under
  `sandbox: "none"` other runs' work dirs are readable (a deny entry for them would also deny the agent's own cwd).
  A `think` codex agent still gets the CLI's own system prompt, which describes a coding assistant.
- An aborted claude stream is metered from what was streamed before the abort. A codex response cut off by a kill is
  not metered at all (the CLI's usage comes only with the terminal event); the gap is bounded by one response.
- `isolation: 'worktree'` and `workflow()` nesting aren't implemented and fail loudly.
- The runner sandbox is defense in depth. Node 20's permission model doesn't restrict network.
- The dashboard trusts `Tailscale-User-Login`. A local process running as the same user could forge it, but it could also read `~/.swarmbase` directly.
