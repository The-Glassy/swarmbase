#!/bin/sh
# Throwaway Debian container only. Run as root, from any working directory.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run this setup as root in a throwaway Debian container.' >&2; exit 1; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
apt-get update
apt-get install -y sudo python3 bubblewrap acl procps
bwrap_help=$(bwrap --help)
case "$bwrap_help" in
  *--ro-bind-fd*) ;;
  *) echo 'Upgrade bubblewrap: --bind-fd/--ro-bind-fd are required (0.10+ or a distro backport).' >&2; exit 1 ;;
esac
for account in swarmbase-test-daemon swarmbase-test-a swarmbase-test-b; do
  if ! id "$account" >/dev/null 2>&1; then
    useradd --create-home --user-group --shell /bin/sh "$account"
  fi
done
usermod -aG swarmbase-test-a,swarmbase-test-b swarmbase-test-daemon
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$script_dir/swarmbase-user" /usr/local/libexec/swarmbase-user
install -o root -g root -m 0755 "$script_dir/test-user-agent.py" /usr/local/libexec/swarmbase-test-agent
for suffix in a b; do
  account=swarmbase-test-$suffix
  chown "$account:$account" "/home/$account"
  setfacl -b "/home/$account"
  chmod 2750 "/home/$account"
  install -d -o "$account" -g "$account" -m 2750 "/home/$account/projects"
done
for suffix in a b; do
  account=swarmbase-test-$suffix
  getent group "$account-workspace" >/dev/null || groupadd "$account-workspace"
  usermod -aG "$account-workspace" "$account"
  usermod -aG "$account-workspace" swarmbase-test-daemon
  install -d -o root -g "$account-workspace" -m 2750 "/srv/$account"
  install -d -o root -g "$account-workspace" -m 2770 "/srv/$account/workspace"
done
install -d -o swarmbase-test-daemon -g swarmbase-test-daemon -m 0700 /home/swarmbase-test-daemon/state
for suffix in a b; do
  key=/home/swarmbase-test-daemon/state/$suffix.key
  printf 'test-key-%s\n' "$suffix" > "$key"
  chown swarmbase-test-daemon:swarmbase-test-daemon "$key"
  chmod 0600 "$key"
done
rule=$(mktemp)
trap 'rm -f "$rule"' EXIT HUP INT TERM
printf '%s\n' 'swarmbase-test-daemon ALL=(swarmbase-test-a,swarmbase-test-b) NOPASSWD: /usr/local/libexec/swarmbase-user' > "$rule"
visudo -cf "$rule"
install -o root -g root -m 0440 "$rule" /etc/sudoers.d/swarmbase-test-users
cat <<'EOF'
Setup complete. Build in a checkout readable by the test daemon, then run as it:
  npm run clean && npm run build
  sudo -u swarmbase-test-daemon env SWARMBASE_TEST_USERS=1 node --test dist/test/users.integration.test.js
Full suite (same daemon account):
  sudo -u swarmbase-test-daemon env SWARMBASE_TEST_USERS=1 node --test dist/test/*.test.js
The integration test needs unprivileged user namespaces for its bubblewrap case;
run the throwaway container with the required user-namespace/seccomp permissions.
EOF
