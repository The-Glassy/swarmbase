# SwarmBase

Workflow orchestration for Connectome residents, as an MCPL server. A resident submits a JavaScript script that
orchestrates subagents (`agent()` / `parallel()` / `pipeline()`). SwarmBase runs it in the background, fans out the
subagents, and pushes the result back to the resident as a `push/event` when the run ends. A dashboard on the tailnet
shows every run live.

```
resident (MCPL host) ──MCPL over WS ?token=──▶ swarmbase daemon (127.0.0.1:7360)
                                                 ├─ script runner per run (node --experimental-permission + vm)
                                                 ├─ agent() → one headless `claude -p` process per call
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
| `run` | start a run: `{script, args?, label?, model?, effort?, profile?, budgetUsd?}` → runId, immediately |
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
  "apiBaseUrl": "https://<gateway>/anthropic",                  // optional; null = the vendor API directly
  "claudeBin": "/usr/local/bin/claude",
  "maxConcurrentAgents": 10, "perRunConcurrency": 8, "maxAgentsPerRun": 200,
  "dashboard": { "adminLogins": ["you@example.com"] },         // may cancel runs and skip agents
  "callers": [{
    "name": "resident-a",
    "tokenSha256": "<sha256 of the caller's MCPL token>",      // the token itself is never stored here
    "apiKeyFile": "~/.swarmbase/resident-a.key",               // API key or gateway token, 0600
    "engines": ["claude"], "maxProfile": "read",
    "cwdRoots": ["/srv/resident-a/files"],
    "defaultModel": "claude-sonnet-5-5", "runUsdDefault": 5, "runUsdMax": 25, "maxActiveRuns": 3
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

When `apiBaseUrl` points at an inference gateway, every agent request carries `x-gate-origin: swarmbase`,
`x-gate-channel: <runId>` and `x-gate-counterparty: <n>:<label>`, so the gateway ledger attributes spend per run and
per agent.

## Profiles (what a subagent may touch)

| profile | CLI tools | confinement |
|---|---|---|
| think | none (`--tools=`); StructuredOutput only when a schema is given | — |
| read | Read, Grep, Glob, WebFetch, WebSearch | `Read(//<cwd>/**)`, which also governs Grep and Glob; reads outside are denied |
| write | + Edit, Write, Bash | `Edit`/`Write(//<cwd>/**)`; **Bash is not confined**, so trusted callers only |

Every subagent also runs with:
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
- Restart: stops every in-flight subagent. Runs are marked `interrupted` on the next boot, callers are notified, and `resume` replays finished agents for free. If the daemon died uncleanly, leftover agent process groups are reaped on boot.
- Tests: `node test/runner-harness.mjs` exercises the runner sandbox. `node test/client.mjs <caller> <tool> '<json>' [--wait]` is a minimal MCPL host.

## Known limits

- One engine (`claude`), so Claude models only. There's no per-caller model allowlist.
- An aborted stream is metered from what was streamed before the abort.
- `isolation: 'worktree'` and `workflow()` nesting aren't implemented and fail loudly.
- The runner sandbox is defense in depth. Node 20's permission model doesn't restrict network.
- The dashboard trusts `Tailscale-User-Login`. A local process running as the same user could forge it, but it could also read `~/.swarmbase` directly.
