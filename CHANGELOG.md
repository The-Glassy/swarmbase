# Changelog

## Unreleased

- Add optional Linux per-caller `runAs` and `homeDir`, with a narrow sudo helper that runs all Claude/Codex profiles
  and the Codex outer bubblewrap as that caller. Existing configurations retain daemon-user execution.
- Keep daemon records and secrets private; create workspaces and temporary homes as caller users, pass an explicit
  environment, and keep Codex gateway keys in the daemon meter. Validate identities, helper ownership/sudo access,
  root ownership and actual cross-caller permissions at startup, including ACLs and supplementary groups.
- Supervise caller processes over a control pipe, reap escaped descendants on cancellation or daemon loss, and
  clean caller-owned files under the caller uid. Document Unix-user and network boundaries, two-caller deployment,
  and a gated offline Debian integration test with a provisioning script.
