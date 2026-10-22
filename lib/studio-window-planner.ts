import { chunkAbsWindow } from './segment-range'
import { fmtTime } from './format'
import type { ChunkMatch, Scan, ShortSegmentState } from './types'

export interface StudioShortPart {
  partIndex: number
  /** Start offset in seconds within the short video */
  startSec: number
  /** End offset in seconds within the short video */
  endSec: number
  /** Duration in seconds */
  durationSec: number
  /** Underlying 1-minute shortSegments[i].index values grouped into this part */
  segmentIndexes: number[]
  label: string
}

export interface StudioMovieBlock {
  blockIndex: number
  /** Start offset in seconds within the full movie */
  startSec: number
  /** End offset in seconds within the full movie */
  endSec: number
  /** Duration in seconds */
  durationSec: number
  /** 1-based movie minutes covered by this block (for human-readable logs) */
  movieMinutes: number[]
  /** 0-based 60s chunk indexes covered by this block (for UI timeline & status updates) */
  chunkIndexes: number[]
  label: string
}

export interface StudioScanJobPlan {
  jobIndex: number
  shortPart: StudioShortPart
  movieBlock: StudioMovieBlock
  /** Number of times this job's movieBlock has been split due to exceeding maxInputTokens (max 3) */
  shrinkLevel?: number
}

export interface WindowPlannerOptions {
  /** Max movie window duration in minutes (default 5) */
  windowMinutes: number
  /** Max short part duration in minutes (default 3) */
  shortPartMinutes: number
  /** Optional overlap in seconds added to the end of each movie block (default 0) */
  windowOverlapSec: number
}

/**
 * Derive the 0-based 60-second chunk index for a given absolute movie timestamp:
 * floor((movieStart - trimStart) / 60), clamped to valid chunk range.
 */
export function deriveChunkIndexForMovieTime(
  scan: Pick<Scan, 'movieTrimStart' | 'chunkCount'>,
  movieStartSec: number,
  fallbackChunkIndexes?: number[],
): number {
  const trimStart = scan.movieTrimStart ?? 0
  const rawIdx = Math.floor(Math.max(0, movieStartSec - trimStart) / 60)
  const maxChunk = Math.max(0, (scan.chunkCount || 1) - 1)
  const clamped = Math.min(maxChunk, Math.max(0, rawIdx))
  if (fallbackChunkIndexes && fallbackChunkIndexes.length > 0) {
    if (fallbackChunkIndexes.includes(clamped)) return clamped
    // Find closest chunk in the block
    let best = fallbackChunkIndexes[0]
    let bestDist = Math.abs(best - clamped)
    for (const ci of fallbackChunkIndexes) {
      const d = Math.abs(ci - clamped)
      if (d < bestDist) {
        best = ci
        bestDist = d
      }
    }
    return best
  }
  return clamped
}

/**
 * Clip a ChunkMatch to a 60s short segment boundary [segStart, segEnd] and shift
 * movieStart / movieEnd by the corresponding amount (1:1 when speed ratio is 1,
 * or proportional to movieDuration / shortDuration when ratio != 1).
 * Returns null if the match does not overlap [segStart, segEnd] or the clipped piece is < 0.05s.
 */
export function clipMatchToShortSegment(
  match: ChunkMatch,
  segStart: number,
  segEnd: number,
  scan?: Pick<Scan, 'movieTrimStart' | 'chunkCount'>,
  fallbackChunkIndexes?: number[],
): ChunkMatch | null {
  const origShortDur = match.shortEnd - match.shortStart
  const origMovieDur = match.movieEnd - match.movieStart
  if (origShortDur <= 0 || match.shortEnd <= segStart || match.shortStart >= segEnd) {
    return null
  }

  const clippedShortStart = Math.max(segStart, match.shortStart)
  const clippedShortEnd = Math.min(segEnd, match.shortEnd)
  const clippedShortDur = clippedShortEnd - clippedShortStart

  // Drop pieces shorter than ~0.05 s
  if (clippedShortDur < 0.05) {
    return null
  }

  const deltaStart = clippedShortStart - match.shortStart
  const deltaEnd = match.shortEnd - clippedShortEnd
  const speedRatio =
    origShortDur > 0 && origMovieDur > 0
      ? Math.abs(origMovieDur - origShortDur) < 1e-6
        ? 1
        : origMovieDur / origShortDur
      : 1

  const clippedMovieStart = Number((match.movieStart + deltaStart * speedRatio).toFixed(3))
  const clippedMovieEnd = Number((match.movieEnd - deltaEnd * speedRatio).toFixed(3))
  if (clippedMovieEnd - clippedMovieStart < 0.02) {
    return null
  }

  const updatedChunkIndex = scan
    ? deriveChunkIndexForMovieTime(scan, clippedMovieStart, fallbackChunkIndexes)
    : match.chunkIndex

  return {
    ...match,
    shortStart: Number(clippedShortStart.toFixed(3)),
    shortEnd: Number(clippedShortEnd.toFixed(3)),
    movieStart: clippedMovieStart,
    movieEnd: clippedMovieEnd,
    chunkIndex: updatedChunkIndex,
  }
}

/**
 * Group selected 1-minute shortSegments into contiguous parts of <= shortPartMinutes (default 3 min).
 */
export function groupShortSegmentsIntoParts(
  scan: Scan,
  selectedSegments: ShortSegmentState[],
  shortPartMinutes: number = 3,
): StudioShortPart[] {
  const maxPartSec = Math.max(60, shortPartMinutes * 60)
  const sorted = [...selectedSegments].sort((a, b) => a.index - b.index)

  if (sorted.length === 0) {
    const dur = scan.shortDuration || 60
    const parts: StudioShortPart[] = []
    let pIdx = 0
    for (let s = 0; s < dur; s += maxPartSec) {
      const e = Math.min(dur, s + maxPartSec)
      parts.push({
        partIndex: pIdx++,
        startSec: s,
        endSec: e,
        durationSec: e - s,
        segmentIndexes: [0],
        label: `Short ${fmtTime(s)}–${fmtTime(e)}`,
      })
    }
    return parts
  }

  const parts: StudioShortPart[] = []
  let currentSegs: ShortSegmentState[] = []
  let partStart = 0
  let partEnd = 0

  const flush = () => {
    if (currentSegs.length === 0) return
    const pIdx = parts.length
    parts.push({
      partIndex: pIdx,
      startSec: partStart,
      endSec: partEnd,
      durationSec: Math.max(1, partEnd - partStart),
      segmentIndexes: currentSegs.map((s) => s.index),
      label: `Part ${pIdx + 1} (${fmtTime(partStart)}–${fmtTime(partEnd)})`,
    })
    currentSegs = []
  }

  for (const seg of sorted) {
    if (currentSegs.length === 0) {
      currentSegs.push(seg)
      partStart = seg.start
      partEnd = seg.end
      continue
    }

    const isContiguous = Math.abs(seg.start - partEnd) < 1.0
    const newDuration = seg.end - partStart
    if (isContiguous && newDuration <= maxPartSec + 0.5) {
      currentSegs.push(seg)
      partEnd = seg.end
    } else {
      flush()
      currentSegs.push(seg)
      partStart = seg.start
      partEnd = seg.end
    }
  }
  flush()

  return parts
}

/**
 * Build contiguous movie blocks of up to `windowMinutes` (default 5 min) for a given ShortPart.
 * - Uses the union of approved `movieMinutes` (from lib/minute-ranges.ts applyApprovedMinutes)
 *   and pending chunk indexes across the short segments in this part.
 * - Skips minute gaps (e.g. minutes 32..40 -> 32-37, 37-40).
 * - If no minute list exists (manual Full scan), covers the pending chunks in the trimmed movie range in 5-min blocks.
 */
export function buildMovieBlocksForShortPart(
  scan: Scan,
  part: StudioShortPart,
  allSegments: ShortSegmentState[],
  options: WindowPlannerOptions,
): StudioMovieBlock[] {
  const windowMinutes = Math.max(1, options.windowMinutes || 5)
  const overlapSec = Math.max(0, options.windowOverlapSec || 0)
  const movieDur = scan.movieDuration || 0
  const trimEnd = scan.movieTrimEnd ?? movieDur

  const partSegs = allSegments.filter((s) => part.segmentIndexes.includes(s.index))

  // Collect all pending 60s chunk indexes across the segments in this ShortPart.
  // Note: applyApprovedMinutes (from lib/minute-ranges.ts) already marks chunks inside
  // seg.movieMinutes as 'pending' and chunks outside as 'cancelled'.
  const pendingChunkSet = new Set<number>()

  if (partSegs.length > 0) {
    for (const seg of partSegs) {
      const hasApprovedMinutes = Array.isArray(seg.movieMinutes) && seg.movieMinutes.length > 0
      for (const ch of seg.chunks || []) {
        if (ch.status !== 'pending' && ch.status !== 'scanning') continue
        if (hasApprovedMinutes) {
          const { start: cs, end: ce } = chunkAbsWindow(scan, ch.index)
          const overlapsApproved = seg.movieMinutes!.some((m) => {
            const ms = (m - 1) * 60
            const me = m * 60
            return cs < me && ce > ms
          })
          if (!overlapsApproved) continue
        }
        pendingChunkSet.add(ch.index)
      }
    }
  } else {
    for (const ch of scan.chunks || []) {
      if (ch.status === 'pending' || ch.status === 'scanning') {
        pendingChunkSet.add(ch.index)
      }
    }
  }

  const sortedChunks = [...pendingChunkSet].sort((a, b) => a - b)
  if (sortedChunks.length === 0) return []

  // Group contiguous chunk indexes into blocks of at most `windowMinutes` chunks
  const blocks: StudioMovieBlock[] = []
  let currentGroup: number[] = []

  const flushBlock = () => {
    if (currentGroup.length === 0) return
    const firstCi = currentGroup[0]
    const lastCi = currentGroup[currentGroup.length - 1]
    const firstWin = chunkAbsWindow(scan, firstCi)
    const lastWin = chunkAbsWindow(scan, lastCi)
    const startSec = firstWin.start
    const endSec = Math.min(trimEnd > 0 ? trimEnd : lastWin.end, lastWin.end + overlapSec)
    const startMin = Math.floor(startSec / 60)
    const endMin = Math.ceil(endSec / 60)
    const movieMinutes: number[] = []
    for (let m = startMin + 1; m <= endMin; m++) movieMinutes.push(m)

    blocks.push({
      blockIndex: blocks.length,
      startSec,
      endSec,
      durationSec: Math.max(1, endSec - startSec),
      movieMinutes,
      chunkIndexes: [...currentGroup],
      label: `Min ${startMin}–${endMin} (${fmtTime(startSec)}–${fmtTime(endSec)})`,
    })
    currentGroup = []
  }

  for (const ci of sortedChunks) {
    if (currentGroup.length === 0) {
      currentGroup.push(ci)
      continue
    }
    const prevCi = currentGroup[currentGroup.length - 1]
    const isConsecutive = ci === prevCi + 1
    if (isConsecutive && currentGroup.length < windowMinutes) {
      currentGroup.push(ci)
    } else {
      flushBlock()
      currentGroup.push(ci)
    }
  }
  flushBlock()

  return blocks
}

/**
 * Split a movie block in half when AI Studio's token counter exceeds the maxInputTokens limit.
 */
export function splitMovieBlockInHalf(
  scan: Scan,
  block: StudioMovieBlock,
  overlapSec: number = 0,
): StudioMovieBlock[] {
  if (block.chunkIndexes.length <= 1) {
    // Even a single chunk can be split into two 30s halves if needed
    const mid = Math.round((block.startSec + block.endSec) / 2)
    if (mid <= block.startSec + 10 || mid >= block.endSec - 10) return [block]
    return [
      {
        ...block,
        endSec: mid,
        durationSec: mid - block.startSec,
        label: `${block.label} [A]`,
      },
      {
        ...block,
        startSec: mid,
        durationSec: block.endSec - mid,
        label: `${block.label} [B]`,
      },
    ]
  }

  const half = Math.ceil(block.chunkIndexes.length / 2)
  const leftChunks = block.chunkIndexes.slice(0, half)
  const rightChunks = block.chunkIndexes.slice(half)
  const trimEnd = scan.movieTrimEnd ?? scan.movieDuration ?? 0

  const makeSubBlock = (chunks: number[], suffix: string): StudioMovieBlock => {
    const firstWin = chunkAbsWindow(scan, chunks[0])
    const lastWin = chunkAbsWindow(scan, chunks[chunks.length - 1])
    const startSec = firstWin.start
    const endSec = Math.min(trimEnd > 0 ? trimEnd : lastWin.end, lastWin.end + overlapSec)
    const startMin = Math.floor(startSec / 60)
    const endMin = Math.ceil(endSec / 60)
    return {
      blockIndex: block.blockIndex,
      startSec,
      endSec,
      durationSec: Math.max(1, endSec - startSec),
      movieMinutes: block.movieMinutes,
      chunkIndexes: chunks,
      label: `Min ${startMin}–${endMin}${suffix} (${fmtTime(startSec)}–${fmtTime(endSec)})`,
    }
  }

  return [makeSubBlock(leftChunks, 'a'), makeSubBlock(rightChunks, 'b')]
}

/**
 * Build the complete ordered list of (shortPart, movieBlock) Studio scan jobs.
 */
export function buildStudioScanPlan(
  scan: Scan,
  selectedSegments: ShortSegmentState[],
  options: WindowPlannerOptions,
): StudioScanJobPlan[] {
  const parts = groupShortSegmentsIntoParts(scan, selectedSegments, options.shortPartMinutes)
  const jobs: StudioScanJobPlan[] = []

  for (const part of parts) {
    const blocks = buildMovieBlocksForShortPart(scan, part, selectedSegments, options)
    for (const block of blocks) {
      jobs.push({
        jobIndex: jobs.length,
        shortPart: part,
        movieBlock: block,
      })
    }
  }

  return jobs
}
