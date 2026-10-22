# Test clip (Shiva MatchTool)

Files
- TEST_movie_360p.mp4: 7:00 "movie", 640x360, 24 fps, 21 scenes x 20 s, 6 MB. Burned-in timecode + scene number.
- TEST_short.mp4: 55 s short built from 3 movie ranges (out of order, watermark, one colour-graded) + 5 s title card that is NOT in the movie.
- TEST_expected.json: the correct answer.

Correct answer
00:00.000-00:15.000 --> 00:05:12.500-00:05:27.500
00:15.000-00:35.000 --> 00:01:07.250-00:01:27.250
00:35.000-00:50.000 --> 00:03:41.000-00:03:56.000
00:50.000-00:55.000 --> NOT FOUND

What it tests: 2 movie windows (0-5 min, 5-7 min), clips out of order, scene cut inside a match, NOT FOUND, watermark/colour change, frame-level boundaries.
