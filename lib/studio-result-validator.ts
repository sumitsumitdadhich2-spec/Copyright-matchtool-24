import { parseChunkMatches } from './gemini'

export interface StudioValidationStats {
  rawLength: number
  cleanedLength: number
  matchLineCount: number
  notFoundLineCount: number
  totalValidHissa2Lines: number
  maxShortEndSec: number | null
  reachedShortEnd?: boolean
  softWarning?: string
}

export interface StudioValidationResult {
  ok: boolean
  reason: string
  cleanedText: string
  stats: StudioValidationStats
}

const SPECIFIC_ERROR_PHRASES: readonly string[] = [
  'an internal error has occurred',
  'internal error',
  'failed to generate content',
  'something went wrong',
  'permission denied',
  'caller does not have permission',
  'quota exceeded',
  'resource exhausted',
  'rate limit',
  'try again later',
  'prohibited_content',
  'blocked due to safety',
  'model is overloaded',
]

/** Parse "h:mm:ss(.mmm)" / "mm:ss(.mmm)" into seconds. */
function parseClockSec(ts: string): number | null {
  const t = ts.trim()
  const m3 = t.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/)
  if (m3) return Number(m3[1]) * 3600 + Number(m3[2]) * 60 + Number(m3[3])
  const m2 = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/)
  if (m2) return Number(m2[1]) * 60 + Number(m2[2])
  return null
}

/**
 * Check if a timestamp token has a truncated millisecond part (e.g. "00:13.0" or "00:13.")
 * instead of full 3-digit milliseconds ("00:13.000") or clean integer seconds ("00:13").
 */
function hasTruncatedTimestampToken(line: string): boolean {
  const tokens = line.match(/\b(?:\d+:)?\d{1,2}:\d{1,2}\.\d*\b|\b(?:\d+:)?\d{1,2}:\d{1,2}\./g)
  if (!tokens) return false
  for (const tok of tokens) {
    const dotIdx = tok.indexOf('.')
    if (dotIdx >= 0) {
      const decimals = tok.slice(dotIdx + 1)
      if (decimals.length !== 3) {
        return true
      }
    }
  }
  return false
}

/**
 * Check whether the tail of HISSA 2 looks cut off / truncated mid-stream.
 * Examines the final non-empty portion of normalized text, checking for:
 * 1. Dangling connectors / arrows / hyphens / colons at the end of the text.
 * 2. Incomplete millisecond timestamp at the end (e.g. "00:13.0" or "00:13.").
 * 3. An incomplete final "Short" entry that was cut off before its arrow or target.
 */
function isTailTruncated(normalizedHissa2: string): boolean {
  const trimmed = normalizedHissa2.trim().replace(/[\])]+$/, '').trim()
  if (!trimmed) return false

  // Dangling connector or incomplete timestamp token at the very end
  if (/(?:-->|->|—>|=>|→|-|–|—|:|\.\d{0,2})$/.test(trimmed)) {
    return true
  }

  const lastToken = trimmed.split(' ').pop() || ''
  if (hasTruncatedTimestampToken(lastToken)) {
    return true
  }

  // Find the last "Short" entry in normalized text
  const allShorts = [...trimmed.matchAll(/\bShort\b/gi)]
  const lastShortMatch = allShorts.pop()
  if (lastShortMatch && lastShortMatch.index !== undefined) {
    const lastEntry = trimmed.slice(lastShortMatch.index)

    // Complete match entry: Short <start> - <end> --> Movie <start> - <end>
    const hasCompleteMatch =
      /\bShort[:\s]+(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?\s*(?:-|–|—|to)\s*(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?\s*(?:-->|->|—>|=>|→)\s*Movie[:\s]+(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?\s*(?:-|–|—|to)\s*(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?/i.test(
        lastEntry,
      )

    // Complete not-found entry: Short <start> - <end> --> NOT FOUND
    const hasCompleteNotFound =
      /\bShort[:\s]+(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?\s*(?:-|–|—|to)\s*(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?\s*(?:-->|->|—>|=>|→|:|-|–|—)?\s*NOT[\s_]*FOUND\b/i.test(
        lastEntry,
      )

    if (!hasCompleteMatch && !hasCompleteNotFound) {
      return true
    }
  }

  return false
}

/**
 * Pure, synchronous validator for AI Studio chunk-map answers.
 * Runs immediately after fetching the answer (zero sleep/await).
 * Normalizes text to tolerate wrapped lines, multi-line entries, and annotations.
 */
export function validateStudioAnswer(
  text: string,
  options?: { shortWindowSec?: number },
): StudioValidationResult {
  const raw = typeof text === 'string' ? text : ''
  const trimmed = raw.trim()

  const emptyStats: StudioValidationStats = {
    rawLength: raw.length,
    cleanedLength: 0,
    matchLineCount: 0,
    notFoundLineCount: 0,
    totalValidHissa2Lines: 0,
    maxShortEndSec: null,
  }

  if (!trimmed) {
    return {
      ok: false,
      reason: 'empty',
      cleanedText: '',
      stats: emptyStats,
    }
  }

  // Check 3: Specific internal/error phrases (checked early so short error messages report the exact phrase)
  const lower = trimmed.toLowerCase()
  for (const phrase of SPECIFIC_ERROR_PHRASES) {
    if (lower.includes(phrase)) {
      return {
        ok: false,
        reason: `error_message:${phrase}`,
        cleanedText: '',
        stats: emptyStats,
      }
    }
  }

  // Check 1: Too short (< 100 chars)
  if (trimmed.length < 100) {
    return {
      ok: false,
      reason: 'empty',
      cleanedText: '',
      stats: emptyStats,
    }
  }

  // Check 2: Both "HISSA 1" and "HISSA 2" must be present, and HISSA 1 must appear before HISSA 2
  const hissa1Match = /HISSA\s*1\b/i.exec(trimmed)
  const hissa2Match = /HISSA\s*2\b/i.exec(trimmed)
  if (!hissa1Match || !hissa2Match || hissa1Match.index >= hissa2Match.index) {
    return {
      ok: false,
      reason: 'missing_hissa',
      cleanedText: '',
      stats: emptyStats,
    }
  }

  // Check 6: Strip any thinking leak / preamble before "HISSA 1"
  const cleanedText = trimmed.slice(hissa1Match.index).trim()

  // Extract HISSA 2 body (everything after the HISSA 2 heading line)
  const hissa2InCleaned = /HISSA\s*2\b[^\n]*\n?/i.exec(cleanedText)
  const hissa2Body = hissa2InCleaned
    ? cleanedText.slice(hissa2InCleaned.index + hissa2InCleaned[0].length).trim()
    : ''

  if (!hissa2Body) {
    return {
      ok: false,
      reason: 'empty_hissa2',
      cleanedText,
      stats: {
        ...emptyStats,
        cleanedLength: cleanedText.length,
      },
    }
  }

  // Normalize HISSA 2 body: replace line breaks with spaces and collapse consecutive whitespace
  const normalizedHissa2 = hissa2Body.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()

  if (!normalizedHissa2) {
    return {
      ok: false,
      reason: 'empty_hissa2',
      cleanedText,
      stats: {
        ...emptyStats,
        cleanedLength: cleanedText.length,
      },
    }
  }

  // Check 4: HISSA 2 must have at least one valid match line (via parseChunkMatches) or NOT FOUND line
  const parsedMatches = parseChunkMatches(normalizedHissa2, 0, 0, 'studio')
  const matchLineCount = parsedMatches.length

  let notFoundLineCount = 0
  let maxShortEndSec: number | null = null

  for (const m of parsedMatches) {
    if (maxShortEndSec === null || m.shortEnd > maxShortEndSec) {
      maxShortEndSec = m.shortEnd
    }
  }

  // Match NOT FOUND entries in normalized text
  const notFoundPattern =
    /\bShort[:\s]+((?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?)\s*(?:-|–|—|to)\s*((?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?)\s*(?:-->|->|—>|=>|→|:|-|–|—)?\s*NOT[\s_]*FOUND\b/gi
  let nfMatch: RegExpExecArray | null
  while ((nfMatch = notFoundPattern.exec(normalizedHissa2)) !== null) {
    notFoundLineCount += 1
    const endSec = parseClockSec(nfMatch[2])
    if (endSec !== null && (maxShortEndSec === null || endSec > maxShortEndSec)) {
      maxShortEndSec = endSec
    }
  }

  // Fallback: If no "Short ... --> NOT FOUND" matched but "NOT FOUND" is present in text
  if (notFoundLineCount === 0 && /\bNOT[\s_]*FOUND\b/i.test(normalizedHissa2)) {
    const rawMatches = normalizedHissa2.match(/\bNOT[\s_]*FOUND\b/gi)
    if (rawMatches) {
      notFoundLineCount = rawMatches.length
    }
  }

  const totalValidHissa2Lines = matchLineCount + notFoundLineCount
  if (totalValidHissa2Lines === 0) {
    return {
      ok: false,
      reason: 'empty_hissa2',
      cleanedText,
      stats: {
        rawLength: raw.length,
        cleanedLength: cleanedText.length,
        matchLineCount: 0,
        notFoundLineCount: 0,
        totalValidHissa2Lines: 0,
        maxShortEndSec,
      },
    }
  }

  // Check 5: Truncation check on the tail of HISSA 2
  if (isTailTruncated(normalizedHissa2)) {
    return {
      ok: false,
      reason: 'truncated_last_line',
      cleanedText,
      stats: {
        rawLength: raw.length,
        cleanedLength: cleanedText.length,
        matchLineCount,
        notFoundLineCount,
        totalValidHissa2Lines,
        maxShortEndSec,
      },
    }
  }

  // Check 7: Soft warning (never rejects) if HISSA 2 lines did not reach near the end of the short window
  let reachedShortEnd: boolean | undefined
  let softWarning: string | undefined
  if (options?.shortWindowSec && options.shortWindowSec > 0) {
    if (maxShortEndSec !== null && maxShortEndSec >= options.shortWindowSec - 3) {
      reachedShortEnd = true
    } else {
      reachedShortEnd = false
      softWarning = `HISSA 2 max short end (${maxShortEndSec !== null ? `${maxShortEndSec.toFixed(1)}s` : 'none'}) is before short window end (${options.shortWindowSec.toFixed(1)}s)`
    }
  }

  return {
    ok: true,
    reason: 'ok',
    cleanedText,
    stats: {
      rawLength: raw.length,
      cleanedLength: cleanedText.length,
      matchLineCount,
      notFoundLineCount,
      totalValidHissa2Lines,
      maxShortEndSec,
      reachedShortEnd,
      softWarning,
    },
  }
}
