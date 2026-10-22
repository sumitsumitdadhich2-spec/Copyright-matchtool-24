import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getFfmpegPath } from './ffmpeg-bin'

export function isValidYoutubeUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl.trim())
    const host = u.hostname.toLowerCase()
    return (
      host === 'youtu.be' ||
      host.endsWith('.youtube.com') ||
      host === 'youtube.com' ||
      host === 'm.youtube.com'
    )
  } catch {
    return false
  }
}

/**
 * Download a YouTube Short or video to a local MP4 file using yt-dlp.
 * Uses ffmpeg-static / system ffmpeg for merging video+audio streams into MP4.
 */
export async function downloadYoutubeVideo(
  youtubeUrl: string,
  destPath: string,
  onProgress?: (pct: number) => void,
): Promise<{ filePath: string; sizeBytes: number }> {
  if (!isValidYoutubeUrl(youtubeUrl)) {
    throw new Error('Invalid YouTube URL. Please enter a valid youtube.com or youtu.be link.')
  }

  const dir = path.dirname(destPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmpOut = `${destPath}.ytdlp.mp4`
  try {
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut)
  } catch {
    /* ignore */
  }

  const ffmpeg = await getFfmpegPath().catch(() => '')
  const ffmpegDir = ffmpeg ? path.dirname(ffmpeg) : ''

  const args = [
    '--no-playlist',
    '--newline',
    '-f',
    'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[ext=mp4]/best',
    '--merge-output-format',
    'mp4',
    ...(ffmpegDir && ffmpegDir !== '.' ? ['--ffmpeg-location', ffmpeg] : []),
    '-o',
    tmpOut,
    youtubeUrl.trim(),
  ]

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''

    const handleLine = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      const m = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/)
      if (m && onProgress) {
        const pct = Math.min(99, Math.max(0, Math.round( parseFloat(m[1]) )))
        onProgress(pct)
      }
    }

    proc.stdout.on('data', handleLine)
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
      handleLine(d)
    })

    proc.on('error', (err) => {
      reject(
        new Error(
          `yt-dlp failed to launch (${err.message}). Make sure yt-dlp is installed in the container/host.`,
        ),
      )
    })

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(tmpOut)) {
        resolve()
      } else {
        reject(
          new Error(
            `yt-dlp exited with code ${code}: ${stderr.slice(-400) || 'Failed to download YouTube video'}`,
          ),
        )
      }
    })
  })

  if (fs.existsSync(destPath)) {
    try {
      fs.unlinkSync(destPath)
    } catch {
      /* ignore */
    }
  }
  fs.renameSync(tmpOut, destPath)
  const stat = fs.statSync(destPath)
  onProgress?.(100)
  return { filePath: destPath, sizeBytes: stat.size }
}
