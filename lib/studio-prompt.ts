import { CHUNK_MAP_PROMPT, CHUNK_MAP_SANITIZED_PROMPT } from './gemini'

function formatDurationClock(seconds: number): string {
  const totalSec = Math.max(1, Math.round(seconds))
  const mm = Math.floor(totalSec / 60)
  const ss = totalSec % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.000`
}

/**
 * Reuses CHUNK_MAP_PROMPT and CHUNK_MAP_SANITIZED_PROMPT from lib/gemini.ts via a builder
 * that only updates the 1-minute chunk wording to the actual window duration (e.g. 5-MINUTE WINDOW,
 * ~05:00.000) while keeping the prompt's meaning, rules, and output format ("Short X --> Movie Y")
 * 100% identical.
 */
export function buildStudioChunkPrompt(params: {
  movieWindowSec: number
  shortPartSec: number
  sanitized?: boolean
}): string {
  const { movieWindowSec, shortPartSec, sanitized = false } = params
  const winMinutes = Math.max(1, Math.round(movieWindowSec / 60))
  const shortMinutes = Math.max(1, Math.round(shortPartSec / 60))
  const winClock = formatDurationClock(movieWindowSec)

  const base = sanitized ? CHUNK_MAP_SANITIZED_PROMPT : CHUNK_MAP_PROMPT

  return base
    .replace(/a ONE-MINUTE CHUNK/g, `a ${winMinutes}-MINUTE WINDOW`)
    .replace(/ONE-MINUTE CHUNK/g, `${winMinutes}-MINUTE WINDOW`)
    .replace(/1-minute segment/g, `${shortMinutes}-minute segment`)
    .replace(/1-minute tukda/g, `${winMinutes}-minute window`)
    .replace(/~01:00\.000/g, `~${winClock}`)
    .replace(/chunk ka end/g, 'window ka end')
    .replace(/is chunk me/g, 'is window me')
    .replace(/\bCHUNK\b/g, 'WINDOW')
    .replace(/\bchunk\b/g, 'window')
}
