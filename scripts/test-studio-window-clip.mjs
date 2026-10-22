#!/usr/bin/env node
import assert from 'node:assert/strict'

/**
 * Unit test for Fix 2: clipMatchToShortSegment
 * Verifies that a Studio match spanning across a 60s short-segment boundary
 * (e.g. 55s -> 70s) is clipped cleanly into two non-overlapping pieces
 * ([55, 60] for segment 0 and [60, 70] for segment 1) with shifted movieStart/movieEnd
 * and no duplicate unclipped candidates.
 */

function deriveChunkIndexForMovieTime(scan, movieStartSec, fallbackChunkIndexes) {
  const trimStart = scan.movieTrimStart ?? 0
  const rawIdx = Math.floor(Math.max(0, movieStartSec - trimStart) / 60)
  const maxChunk = Math.max(0, (scan.chunkCount || 1) - 1)
  const clamped = Math.min(maxChunk, Math.max(0, rawIdx))
  if (fallbackChunkIndexes && fallbackChunkIndexes.length > 0) {
    if (fallbackChunkIndexes.includes(clamped)) return clamped
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

function clipMatchToShortSegment(match, segStart, segEnd, scan, fallbackChunkIndexes) {
  const origShortDur = match.shortEnd - match.shortStart
  const origMovieDur = match.movieEnd - match.movieStart
  if (origShortDur <= 0 || match.shortEnd <= segStart || match.shortStart >= segEnd) {
    return null
  }

  const clippedShortStart = Math.max(segStart, match.shortStart)
  const clippedShortEnd = Math.min(segEnd, match.shortEnd)
  const clippedShortDur = clippedShortEnd - clippedShortStart

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

// 1. Test 1:1 speed match spanning 55s -> 70s across Segment 0 [0, 60] and Segment 1 [60, 120]
const mockScan = { movieTrimStart: 0, chunkCount: 120 }
const boundaryMatch = {
  shortStart: 55,
  shortEnd: 70,
  movieStart: 1255,
  movieEnd: 1270,
  chunkIndex: 20,
  confidence: 'high',
  description: 'Cross-boundary scene',
}

const pieceSeg0 = clipMatchToShortSegment(boundaryMatch, 0, 60, mockScan, [20, 21])
const pieceSeg1 = clipMatchToShortSegment(boundaryMatch, 60, 120, mockScan, [20, 21])
const pieceSeg2 = clipMatchToShortSegment(boundaryMatch, 120, 180, mockScan, [20, 21])

assert.ok(pieceSeg0, 'Segment 0 piece must exist')
assert.equal(pieceSeg0.shortStart, 55)
assert.equal(pieceSeg0.shortEnd, 60)
assert.equal(pieceSeg0.movieStart, 1255)
assert.equal(pieceSeg0.movieEnd, 1260)
assert.equal(pieceSeg0.chunkIndex, 20) // floor(1255 / 60) = 20

assert.ok(pieceSeg1, 'Segment 1 piece must exist')
assert.equal(pieceSeg1.shortStart, 60)
assert.equal(pieceSeg1.shortEnd, 70)
assert.equal(pieceSeg1.movieStart, 1260)
assert.equal(pieceSeg1.movieEnd, 1270)
assert.equal(pieceSeg1.chunkIndex, 21) // floor(1260 / 60) = 21

assert.equal(pieceSeg2, null, 'Segment 2 [120, 180] must not receive any piece')

// 2. Test proportional speed ratio != 1 (e.g. 1.2x speed: 15s short = 18s movie)
const spedUpMatch = {
  shortStart: 55,
  shortEnd: 70, // 15s
  movieStart: 600,
  movieEnd: 618, // 18s (ratio = 1.2)
  chunkIndex: 10,
  confidence: 'high',
  description: '1.2x sped-up scene',
}
const spedSeg0 = clipMatchToShortSegment(spedUpMatch, 0, 60, mockScan, [10])
const spedSeg1 = clipMatchToShortSegment(spedUpMatch, 60, 120, mockScan, [10])
assert.equal(spedSeg0.shortStart, 55)
assert.equal(spedSeg0.shortEnd, 60)
assert.equal(spedSeg0.movieStart, 600)
assert.equal(spedSeg0.movieEnd, 606) // 5s * 1.2 = 6s
assert.equal(spedSeg1.shortStart, 60)
assert.equal(spedSeg1.shortEnd, 70)
assert.equal(spedSeg1.movieStart, 606)
assert.equal(spedSeg1.movieEnd, 618) // 10s * 1.2 = 12s

// 3. Test tiny sliver < 0.05s is dropped
const tinySliverMatch = {
  shortStart: 59.97,
  shortEnd: 65.0,
  movieStart: 300,
  movieEnd: 305.03,
  chunkIndex: 5,
  confidence: 'high',
  description: 'Tiny 0.03s overlap with seg 0',
}
assert.equal(
  clipMatchToShortSegment(tinySliverMatch, 0, 60, mockScan, [5]),
  null,
  'Sliver < 0.05s in segment 0 must be dropped',
)
const sliverSeg1 = clipMatchToShortSegment(tinySliverMatch, 60, 120, mockScan, [5])
assert.ok(sliverSeg1, 'Main piece in segment 1 must be kept')
assert.equal(sliverSeg1.shortStart, 60)
assert.equal(sliverSeg1.shortEnd, 65)

console.log('PASS: All clipMatchToShortSegment boundary tests succeeded.')
