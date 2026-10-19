export const TICK_MS = 5000
// The status line only needs the registry; git and token reads run only while the pane is open.
export const STATUS_EVERY_TICKS = 3
// Outside the pane, which processes are alive is checked at most this often (one PowerShell start each).
export const ALIVE_TTL_MS = 60_000
export const STALE_MS = 7 * 24 * 60 * 60 * 1000
// Prompt-cache lifetime: 5 minutes on the API by default, 1 hour on some plans.
// Past it, resuming a session pays to cache its whole context again.
export const CACHE_TTL_MS = 60 * 60 * 1000
// The helper looks for the last reply's usage in this much of a transcript's end, then 4x more, up to the max.
export const TOKENS_WINDOW_BYTES = 512 * 1024
export const TOKENS_MAX_BYTES = 8 * 1024 * 1024
// Session titles: the opening prompts come from the head, the latest from the tail.
export const HEAD_BYTES = 200_000
export const TAIL_BYTES = 200_000
export const TITLES_KEY = 'titles'
export const TITLES_PER_SCAN = 2
// A transcript that couldn't be found is looked for again after this long.
export const MISSING_RETRY_MS = 60_000
// The registry's procStart and the running process's start time agree to the 100 ns tick; allow 2 s.
export const START_TOLERANCE = 20_000_000

// Claude Code writes one <pid>.json per running session here, under its config folder. It is an
// internal file, not an API: read only the fields parseRegistryEntry names, never the rest.
export const REGISTRY_DIR = 'sessions'
export const PROJECTS_DIR = 'projects'

// Demo sessions' ids start with this; no action touches them.
export const DEMO_PREFIX = 'demo-'
