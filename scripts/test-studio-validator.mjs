import assert from 'node:assert/strict'
import { validateStudioAnswer } from '../lib/studio-result-validator.ts'

// 1. Good sample (with thinking leak before HISSA 1, valid HISSA 1 + HISSA 2, match lines + NOT FOUND lines)
const goodSample = `
Thinking Process:
Let's carefully analyze Video 1 (Short) and Video 2 (Movie chunk) at 24 fps.
=====================
HISSA 1 — SHORT VIDEO TIME MAP
=====================
00:00.000 - 00:04.500 (0-108 frames): Man walks into the room and looks at the table.
00:04.500 - 00:09.250 (108-222 frames): Close-up on the phone ringing: "Hello, kaun bol raha hai?"
00:09.250 - 00:15.000 (222-360 frames): Woman opens the door and steps outside into the rain.

=====================
HISSA 2 — MOVIE WINDOW ME HAR SEGMENT KI HUNT
=====================
- Short 00:00.000 - 00:04.500 --> Movie 01:12.000 - 01:16.500
- Short 00:04.500 - 00:09.250 --> Movie 02:05.125 - 02:09.875
- Short 00:09.250 - 00:15.000 --> NOT FOUND
`

const resGood = validateStudioAnswer(goodSample, { shortWindowSec: 15 })
assert.equal(resGood.ok, true, `Expected goodSample to pass, got reason=${resGood.reason}`)
assert.equal(resGood.reason, 'ok')
assert.equal(resGood.cleanedText.startsWith('HISSA 1'), true, 'Expected thinking leak before HISSA 1 to be stripped')
assert.equal(resGood.stats.matchLineCount, 2)
assert.equal(resGood.stats.notFoundLineCount, 1)
assert.equal(resGood.stats.totalValidHissa2Lines, 3)
assert.equal(resGood.stats.reachedShortEnd, true)

// 2. Bad sample: empty text
const resEmpty = validateStudioAnswer('   ')
assert.equal(resEmpty.ok, false)
assert.equal(resEmpty.reason, 'empty')

// 3. Bad sample: only thinking (no HISSA 1 / HISSA 2)
const onlyThinking =
  'Thinking about the video frames and comparing audio tracks across the two clips. '.repeat(6)
const resThinkingOnly = validateStudioAnswer(onlyThinking)
assert.equal(resThinkingOnly.ok, false)
assert.equal(resThinkingOnly.reason, 'missing_hissa')

// 4. Bad sample: HISSA 2 missing
const missingHissa2 = `
=====================
HISSA 1 — SHORT VIDEO TIME MAP
=====================
00:00.000 - 00:04.500 (0-108 frames): Man walks into the room and looks at the table.
00:04.500 - 00:09.250 (108-222 frames): Close-up on the phone ringing: "Hello, kaun bol raha hai?"
00:09.250 - 00:15.000 (222-360 frames): Woman opens the door and steps outside into the rain.
`
const resMissingHissa2 = validateStudioAnswer(missingHissa2)
assert.equal(resMissingHissa2.ok, false)
assert.equal(resMissingHissa2.reason, 'missing_hissa')

// 5. Bad sample: "An internal error has occurred"
const resInternalErr = validateStudioAnswer('An internal error has occurred. Please try again.')
assert.equal(resInternalErr.ok, false)
assert.equal(resInternalErr.reason.startsWith('error_message:'), true)

// 6. Bad sample: truncated last line ("Short 00:12.000 - 00:13.0")
const truncatedSample = `
=====================
HISSA 1 — SHORT VIDEO TIME MAP
=====================
00:00.000 - 00:04.500 (0-108 frames): Man walks into the room and looks at the table.
00:04.500 - 00:12.000 (108-288 frames): Close-up on the phone ringing: "Hello, kaun bol raha hai?"
00:12.000 - 00:15.000 (288-360 frames): Woman opens the door and steps outside into the rain.

=====================
HISSA 2 — MOVIE WINDOW ME HAR SEGMENT KI HUNT
=====================
- Short 00:00.000 - 00:04.500 --> Movie 01:12.000 - 01:16.500
- Short 00:04.500 - 00:12.000 --> NOT FOUND
- Short 00:12.000 - 00:13.0`

const resTruncated = validateStudioAnswer(truncatedSample)
assert.equal(resTruncated.ok, false)
assert.equal(resTruncated.reason, 'truncated_last_line')

// 7. Sahi Result Sample (wrapped text, leading '[', words split across newlines, multiple entries on one line, optional frames, NOT FOUND with explanations)
const wrappedValidSample = `
[===================== HISSA 1 — SHORT VIDEO TIME MAP
=====================
00:00.000 - 00:15.000 (0-360 frames): bluish green
background with main character speaking to crowd.
00:15.000 - 00:16.000 (360-384 frames): close up face shot.
00:16.000 - 00:17.000 (384-408 frames): car driving away down the street.

=====================
HISSA 2 — MOVIE WINDOW ME HAR SEGMENT KI HUNT
=====================
Short 00:00.000 - 00:15.000 --> NOT FOUND — Scene 16 aur Scene 17 movie window ke bahar hain (05:00.000 ke baad ke scenes) Short 00:15.000 - 00:16.000 --> Movie 01:07.250 - 01:08.250 (1614-1638 frames) Short 00:16.000 - 00:17.000 --> Movie 01:08.250 - 01:09.250 (1638-1662 frames)
`

const resWrapped = validateStudioAnswer(wrappedValidSample, { shortWindowSec: 17 })
assert.equal(resWrapped.ok, true, `Expected wrappedValidSample to pass, got reason=${resWrapped.reason}`)
assert.equal(resWrapped.reason, 'ok')
assert.equal(resWrapped.stats.matchLineCount, 2, 'Expected 2 match entries')
assert.equal(resWrapped.stats.notFoundLineCount, 1, 'Expected 1 NOT FOUND entry')
assert.equal(resWrapped.stats.totalValidHissa2Lines, 3, 'Expected 3 total valid entries')
assert.equal(resWrapped.stats.reachedShortEnd, true)

console.log('ALL studio-result-validator tests PASSED!')

