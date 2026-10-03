/**
 * Turn a workflow script into a classic script whose body
 * runs as an async function: top-level `await` and `return` work, and
 * `export const meta = {...}` is kept (captured as globalThis.__sb_meta).
 * Shared by the runner (execution) and the daemon (compile check only).
 */
export function wrapScript(script: string): string {
  const src = script.replace(/^(\s*)export\s+const\s+meta\s*=/m, '$1const meta = globalThis.__sb_meta =');
  return `(async () => {\n${src}\n})().then(globalThis.__sb_finish, globalThis.__sb_fail);`;
}
