// A repo name in a big centered heading has to wrap somewhere when it is wider than the column.
// Browsers already break after a hyphen; these are the other word edges a name uses.

/** Splits `name` after `_` and `.` and at camelCase edges (`fooBar`, `APIServer`), so a heading can wrap there first. */
export function repoNameParts(name: string): string[] {
  return name.split(/(?<=[._])(?=.)|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
}
