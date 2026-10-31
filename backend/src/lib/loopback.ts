/** URL hostnames (as `new URL().hostname` spells them) where plain http is acceptable: a local engine or mock. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
