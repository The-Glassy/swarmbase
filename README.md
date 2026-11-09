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
| `extend` | push a running run's deadline back: `{runId, hours}` |
| `list` | the caller's recent runs |
| `resume` | re-run a script; identical agent() calls that already succeeded replay from the journal for free |
| `guide` | the authoring reference (`src/guide.ts`) |

There are two feature sets. `swarmbase` uses `tools`. `swarmbase.notify` uses `pushEvents` and carries run-completion
notices: eventId `<runId>:end`, origin `{source: "swarmbase", kind: "run-end", runId}`, tags `surface:done`,
`swarmbase:run-end` and `swarmbase:<status>` (`completed`, `failed`, `cancelled` or `interrupted`). The feature set
declares these tags in an RFC-001 `tagOntology` that suggests waking immediately on `swarmbase:run-end`. A host offers
that suggestion to its agent or operator and applies it only on acceptance, so a host whose wake policy skips
unrecognized push events still needs a rule placed before the skips, for example on agent-framework:

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
  "runTimeoutMs": 86400000,                                     // a run's deadline; callers push it back with `extend`
  "agentTimeoutMs": null,                                       // default: none, the run's deadline still ends an agent
  "dashboard": {
    "viewerLogins": ["colleague@example.com"],                 // may view runs, prompts, transcripts
    "adminLogins": ["you@example.com"]                         // may view, cancel runs and skip agents
  },
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

## Isolating callers

On Linux, give each caller a distinct Unix account and set `runAs`. All profiles (`think`, `read`, `write`),
both engines, and the Codex outer bubblewrap then run as that account. The daemon remains an unprivileged service
user. Without `runAs`, the original daemon-user behavior is retained. When isolation is enabled, every `write`
caller must use `runAs`: a legacy write shell would have the daemon's access to all callers.

The security boundary for Claude's **unconfined write Bash is the Unix user**. It can read/write everything that
user can access, including that caller's other runs and credentials. It can use network and loopback services,
including this dashboard. The dashboard trusts Tailscale identity headers; a local write shell can forge a listed
login and read other callers' transcripts or issue admin actions. Unix file isolation does not isolate HTTP
services. Use network/service isolation or separate machines if callers must not share that access. Codex write
shells also have network; its existing bubblewrap and profile restrictions continue to apply.

Worked example for two callers, with daemon account `swarmbase` (run these provisioning commands as root):

```sh
useradd --create-home --user-group --shell /usr/sbin/nologin swarmbase
install -d -o root -g root -m 0755 /srv/swarmbase-callers /usr/local/libexec
useradd --create-home --user-group --home-dir /srv/swarmbase-callers/a --shell /usr/sbin/nologin swarm-a
useradd --create-home --user-group --home-dir /srv/swarmbase-callers/b --shell /usr/sbin/nologin swarm-b
chmod 2750 /srv/swarmbase-callers/a /srv/swarmbase-callers/b
usermod -aG swarm-a,swarm-b swarmbase
install -d -o swarm-a -g swarm-a -m 2750 /srv/swarmbase-callers/a/projects
install -d -o swarm-b -g swarm-b -m 2750 /srv/swarmbase-callers/b/projects
install -d -o swarmbase -g swarmbase -m 0700 /var/lib/swarmbase
install -o swarmbase -g swarmbase -m 0600 /secure/source/a.key /var/lib/swarmbase/a.key
install -o swarmbase -g swarmbase -m 0600 /secure/source/b.key /var/lib/swarmbase/b.key
install -o root -g root -m 0755 scripts/swarmbase-user /usr/local/libexec/swarmbase-user
```

Install `sudo` and Python 3. Put this **exact command path** rule in `/etc/sudoers.d/swarmbase-users`, root-owned
mode `0440`, and validate with `visudo -cf /etc/sudoers.d/swarmbase-users`:

```sudoers
swarmbase ALL=(swarm-a,swarm-b) NOPASSWD: /usr/local/libexec/swarmbase-user
```

The helper is never run as root. Its file and every parent must be root-owned, not group/world writable, and
contain no symlinks. Do not grant callers sudo rights or membership in each other's private groups. Restart the
daemon service/login after changing its supplementary groups. Keep the daemon's own home and other secret
directories private too; globally installed CLIs/toolchains must be executable by the caller accounts.

Relevant config (replace the token hashes; store this config as `swarmbase`, mode `0600`):

```jsonc
{
  "dataDir": "/var/lib/swarmbase",
  "userHelper": "/usr/local/libexec/swarmbase-user",
  "engines": {
    "claude": { "bin": "/usr/local/bin/claude", "baseUrl": "https://gateway.example/anthropic" },
    "codex": { "bin": "/usr/local/bin/codex", "baseUrl": "https://gateway.example/codex", "sandbox": "bwrap" }
  },
  "callers": [
    {
      "name": "a", "tokenSha256": "<64 hex digits>", "apiKeyFile": "/var/lib/swarmbase/a.key",
      "runAs": "swarm-a", "homeDir": "/srv/swarmbase-callers/a",
      "cwdRoots": ["/srv/swarmbase-callers/a/projects"], "maxProfile": "write", "engines": ["claude", "codex"]
    },
    {
      "name": "b", "tokenSha256": "<64 hex digits>", "apiKeyFile": "/var/lib/swarmbase/b.key",
      "runAs": "swarm-b", "homeDir": "/srv/swarmbase-callers/b",
      "cwdRoots": ["/srv/swarmbase-callers/b/projects"], "maxProfile": "write", "engines": ["claude", "codex"]
    }
  ]
}
```

`homeDir` is the per-caller storage root; if omitted, it defaults to the account's passwd home. The default work
directory is `<homeDir>/.swarmbase/<runId>/work`; each agent gets a fresh sibling `<n>-home` for its temporary HOME
and CODEX_HOME. New directories are caller-owned `0750`, initial files `0640`, under the private caller group.
Only the daemon joins all those groups. Records, transcripts, outbox and key files stay under the daemon's `0700`
data directory. The helper creates and cleans caller files under the caller uid, so caller-controlled symlinks
never give a daemon filesystem operation extra authority. `keepWork` and work sweeps retain their existing meaning.
Changing/removing a caller identity or storage root requires cleaning its old runs under the old identity first.

Credentials travel to the helper over stdin, separate from the process arguments. Claude receives only its own key
in `ANTHROPIC_API_KEY`. Codex's gateway key stays in the daemon's loopback usage meter; the CLI gets only its own
per-agent bearer in its private config. Only an explicit environment reaches either CLI. No existing Claude/Codex
login state is copied from the daemon. Caller users can access their own sibling agents' state: this is isolation
between callers, not between a caller's agents.

Startup refuses nonexistent/root/duplicate identities, missing or unsafe helpers, missing noninteractive sudo
rules, incorrect root ownership, roots the daemon cannot traverse, a non-private data directory, and access to
another caller's roots/key or daemon config/data. Access probes run as each real caller, including supplementary
groups and ACLs; failures include the path and repair commands. Configured cwd roots must be caller-owned private
directories. The helper checks ownership and allowed roots again when starting the CLI and pins cwd with a directory
fd. Keep ownership, modes and group/ACL assignments private after startup; a write caller can deliberately share its
own files, and Unix uids do not restrict shared writable locations such as `/tmp`.
Protected path checks include symlink targets and writable ancestors, to prevent replacement of an otherwise private
config or key. The helper also sets Linux `no_new_privs` before launching an agent, preventing setuid/file-capability
elevation; bubblewrap therefore requires working unprivileged user namespaces rather than a setuid fallback.
For `runAs` with Codex bubblewrap, `/usr/bin/bwrap` must have `--bind-fd`/`--ro-bind-fd` support (bubblewrap 0.10+ or
a distro backport; checked by capability). These options consume the pinned fd before executing the CLI, so it
cannot use that fd to reach host paths outside the mounts. See the [upstream release notes](https://github.com/containers/bubblewrap/releases/tag/v0.10.0).

Cancellation and shutdown use a control pipe to a caller-user supervisor, rather than trying to signal a foreign
uid from the daemon. It terminates the CLI group, then kills/reaps descendants with a Linux child subreaper,
including processes that double-fork or call `setsid`. Closing the pipe on daemon death also triggers cleanup.
The supervisor has the same uid as its caller; a malicious same-uid process can tamper with it. For containment
against deliberate supervisor kills, fork bombs, resource exhaustion or processes launched through external
services, use service-managed cgroups/containers in addition to these file permissions.

For offline integration checks on a **throwaway Debian container**, run `scripts/setup-test-users.sh` as root,
build in a checkout readable by the test daemon, then run:

```sh
sudo -u swarmbase-test-daemon env SWARMBASE_TEST_USERS=1 node --test dist/test/users.integration.test.js
```

This uses two real caller users and fake CLIs (no paid API calls) to check uid, cross-caller `EACCES`, own writes,
daemon-secret exclusion, both engines, bubblewrap, profiles, cleanup, cancelled process trees and daemon loss.
The bubblewrap case requires working unprivileged user namespaces; provide suitable container seccomp settings.
The full suite is `npm test`; the real-user test skips unless `SWARMBASE_TEST_USERS=1`.

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

Each started agent reserves its cap, `opts.maxUsd` (default `max($0.50, budget/8)`, at most $10,000), and runs with
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

Publish it tailnet-only with `tailscale serve --bg --https=7360 http://127.0.0.1:7360`; never use Funnel.

Being on the tailnet is not enough to view. The dashboard shows subagent prompts, transcripts, scripts and results, so
every page, API route and event stream requires a `Tailscale-User-Login` listed in `dashboard.viewerLogins` or
`dashboard.adminLogins`. Everyone else gets a 403, including tagged nodes and Funnel traffic, which carry no user
identity. Only `/api/health` (run counts) and `/api/whoami` answer anyone. Both lists are re-read when the config file
changes, so adding or removing a viewer needs no restart. A file that fails to parse keeps the last good lists, so
after removing someone, check the log for `dashboard access reloaded`.

Cancel and skip require an admin login plus an `X-SwarmBase: 1` header, which blocks cross-site POSTs. A Host
allowlist blocks DNS rebinding.

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
  `sandbox: "none"` other runs' work dirs are readable without `runAs`; with `runAs`, Unix permissions isolate callers
  but a caller's own sibling runs share an identity.
  A `think` codex agent still gets the CLI's own system prompt, which describes a coding assistant.
- An aborted claude stream is metered from what was streamed before the abort. A codex response cut off by a kill is
  not metered at all (the CLI's usage comes only with the terminal event); the gap is bounded by one response.
- `isolation: 'worktree'` and `workflow()` nesting aren't implemented and fail loudly.
- The runner sandbox is defense in depth. Node 20's permission model doesn't restrict network.
- On a machine without a tailnet tag, a request to its own tailnet name carries its owner's login, with no forging needed. Subagents' `WebFetch` is denied every `*.ts.net` host for this reason, but a `write` agent's Bash isn't confined. Tag the host if that matters to you: its own connections then carry no identity.
- The dashboard trusts `Tailscale-User-Login`, which `tailscale serve` sets itself and strips from clients. That holds only through serve: anything reaching the port directly can send the header. So keep `host` on loopback. A process on the machine can still forge a listed login, and that includes a subagent shell with network, even a wrapped codex shell that can't read `~/.swarmbase`. It's one more reason `write` is for trusted callers only.
- The dashboard trusts `Tailscale-User-Login`. A local process running as the same user could forge it, but it could also read `~/.swarmbase` directly.

### Codex with a ChatGPT login

A caller may set `codexAuthFile` to an absolute path containing a file-based
ChatGPT login produced by `codex login --device-auth`. That caller needs neither
an API key nor `engines.codex.baseUrl` for Codex; a mixed Claude/Codex caller still
needs Claude credentials. Login mode takes precedence if gateway settings are
also present. Claude's `agentMcp` remains Claude-only for mixed-engine callers.

Subscription agents use the default Codex backend without the usage proxy. Their
`agent_end` events carry `billing: "subscription"` and `costUsd: 0`; CLI JSON usage
is recorded when available. `maxUsd` cannot be enforced. Token reservations still
limit scheduling, but the CLI reports tokens at turn end, so neither a token nor
USD cap can interrupt an oversized turn in this mode. `timeoutMs` and cancellation
still kill the process group. Interrupted agents may report zero tokens.

For a `runAs` caller, the daemon reads the private master and passes its contents
on the helper's stdin. The helper creates a caller-owned 0600 `auth.json` in a
0700 throwaway Codex home, never a link or mount to the master. After exit, the
helper reads valid private JSON as the caller, returns it over a pipe, and the
daemon saves refreshes to the master before removing the home. Subscription runs
sharing a master are serialized to avoid refresh races. The caller can access its
own staged login; other callers cannot. Keep the master daemon-owned 0600 under
a daemon-owned 0700 directory. Routine deployment must preserve live refreshes.

For a legacy caller, the master login is mounted read-write at the throwaway `CODEX_HOME/auth.json`
under bwrap, or symlinked there with sandbox `none`, to preserve token refreshes.
Do not overwrite the live master on redeploy. Concurrent agents can race token
refresh; coordinate login replacement while idle. File mounts/symlinks require
the CLI's credential writer to update the file in place; atomic replacement
writers may fail on a file bind or replace a symlink instead of updating its
source. Verify refresh behavior with the pinned CLI before production use.

Every caller's login path is denied to Claude file tools and Codex shell
permission profiles, including the Codex agent's own `CODEX_HOME/auth.json` alias.
That alias deny is defense in depth, **not a proven credential boundary**: the
outer Codex process must access the login, and its outer bwrap mount also exposes
it to children. Do not assume a hostile Codex shell cannot obtain it, especially
with sandbox `none` or a write/network profile. Claude write-profile Bash is also
unconfined, as before. Think has no shell tools.

### Shared tenant workspaces and a private dashboard

`runAs` callers can opt into a tenant workspace group with `cwdGid`. Their
`cwdRoots` may then be foreign-owned setgid directories with that gid, mode 2770,
and no access for others. The caller must belong to that group. Keep caller homes
on a separate private group (2750); give the daemon traversal of homes/workspaces,
never give callers the daemon group. Startup probes still reject access to every
other caller's roots, every credential, and writable protected ancestors. The
helper pins a validated directory fd before launching either engine. Agent umask
0007 preserves workspace collaboration; staged auth/config files remain 0600 in
0700 homes. `maxConcurrentAgents` and `perRunConcurrency` on a caller override the
global scheduling defaults for that caller.

Set `dashboardSocket` to an absolute path in a daemon-owned runtime directory to
move all dashboard HTTP routes off TCP. The TCP listener then accepts MCPL
upgrades and public `/health` and `/metrics` only; a forged identity header cannot
retrieve dashboard content there. The Unix socket is 0660. A trusted proxy can
join the daemon group and connect to it, but agent users must never have that
group or a route to that proxy. Enforce the latter with a UID firewall covering
both the proxy's internal port and its externally published port. The homelab
role additionally binds the proxy to loopback and publishes only on NetBird.
