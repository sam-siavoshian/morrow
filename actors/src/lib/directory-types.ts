// TeamDirectory's public types, in a file with no imports so the client type bundle can compile it as is.

export type DirectoryEntry = { teamId: string; gen: number }
export type DirectoryPage = { teams: DirectoryEntry[]; next: string | null }
export type NoteTeamResult = { ok: true; created: boolean }
export type NoteWorkResult = { ok: true; gen: number }
export type NoteIdleResult = { ok: true; cleared: boolean }
export type DirectoryStats = { teams: number; active: number }
