// Wraps the standalone yt-dlp.exe binary (downloaded once into bin/, see
// README.md) for searching/downloading YouTube audio & video, and pulling
// videos directly from TikTok/Instagram/Facebook URLs. Uses the ffmpeg
// binary already bundled via ffmpeg-static for format conversion/merging.
//
// PLACEHOLDER — if bin/yt-dlp.exe is missing, every function here throws a
// clear error instead of crashing; callers should catch and report it.

const { execFile } = require('child_process')
const { promisify } = require('util')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { safeSend } = require('./safeSend')

const execFileAsync = promisify(execFile)

const YTDLP_PATH = path.join(__dirname, '..', 'bin', 'yt-dlp.exe')
const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads')
const FFMPEG_PATH = require('ffmpeg-static')

const MAX_BUFFER = 200 * 1024 * 1024 // 200MB of stdout/stderr text, not the media itself

function ensureBinary() {
  if (!fs.existsSync(YTDLP_PATH)) {
    throw new Error('yt-dlp.exe is missing from bin/ — see README.md for how to download it.')
  }
}

function ensureDownloadsDir() {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true })
}

// Runs yt-dlp with the given args, returns { file, cleanup } for the single
// resulting media file (there should only ever be exactly one per call, since
// each call uses a fresh random output-file prefix).
async function runDownload(url, formatArgs) {
  ensureBinary()
  ensureDownloadsDir()
  const id = crypto.randomBytes(8).toString('hex')
  const outputTemplate = path.join(DOWNLOADS_DIR, `${id}.%(ext)s`)

  await execFileAsync(YTDLP_PATH, [
    ...formatArgs,
    '--ffmpeg-location', FFMPEG_PATH,
    '--no-playlist',
    '--no-warnings',
    '-o', outputTemplate,
    url,
  ], { maxBuffer: MAX_BUFFER })

  const match = fs.readdirSync(DOWNLOADS_DIR).find((f) => f.startsWith(id))
  if (!match) throw new Error('yt-dlp finished but no output file was found.')
  const file = path.join(DOWNLOADS_DIR, match)
  return {
    file,
    cleanup: () => {
      try {
        fs.unlinkSync(file)
      } catch { /* already gone, or in use — not worth failing over */ }
    },
  }
}

// Returns up to `limit` { id, url, title, channel, duration } for a YouTube search.
async function searchYoutube(query, limit = 5) {
  ensureBinary()
  const { stdout } = await execFileAsync(YTDLP_PATH, [
    `ytsearch${limit}:${query}`,
    '--flat-playlist',
    '-J',
    '--no-warnings',
  ], { maxBuffer: MAX_BUFFER })
  const data = JSON.parse(stdout)
  return (data.entries || []).map((e) => ({ id: e.id, url: e.url, title: e.title, channel: e.channel, duration: e.duration }))
}

// Looks up a single video's title/id directly from its URL — used when the
// caller already has a link instead of a search phrase.
async function getVideoInfo(url) {
  ensureBinary()
  const { stdout } = await execFileAsync(YTDLP_PATH, [
    url,
    '--flat-playlist',
    '-J',
    '--no-warnings',
    '--no-playlist',
  ], { maxBuffer: MAX_BUFFER })
  const data = JSON.parse(stdout)
  return { id: data.id, url: data.webpage_url || url, title: data.title, channel: data.channel || data.uploader, duration: data.duration }
}

// Downloads the best available audio for a URL. Returns { file, cleanup, title }.
async function downloadAudio(url) {
  const { file, cleanup } = await runDownload(url, ['-f', 'bestaudio', '-x', '--audio-format', 'mp3', '--audio-quality', '0'])
  return { file, cleanup }
}

// H.264 video + AAC audio plays on every WhatsApp client (phone included).
// YouTube's higher-res streams are often VP9/AV1-in-mp4 instead, which WhatsApp
// Desktop's software player can handle but the mobile apps often can't — so
// prefer avc1/mp4a explicitly, only falling back to "whatever's best" if no
// such stream exists at that height.
function mobileSafeFormat(maxHeight) {
  return [
    `bestvideo[vcodec^=avc1][height<=${maxHeight}]+bestaudio[acodec^=mp4a]`,
    `best[vcodec^=avc1][height<=${maxHeight}]`,
    `bestvideo[height<=${maxHeight}]+bestaudio`,
    `best[height<=${maxHeight}]`,
  ].join('/')
}

// Downloads video capped at maxHeight (e.g. 360/480/720/1080). Returns { file, cleanup }.
async function downloadVideoAtQuality(url, maxHeight) {
  const { file, cleanup } = await runDownload(url, [
    '-f', mobileSafeFormat(maxHeight),
    '--merge-output-format', 'mp4',
  ])
  return { file, cleanup }
}

// Downloads the best available video from a direct URL (TikTok/Instagram/Facebook/etc).
// These platforms already serve H.264/AAC almost universally, so no codec
// constraint is needed here the way it is for YouTube.
async function downloadBest(url) {
  const { file, cleanup } = await runDownload(url, ['-f', 'best', '--merge-output-format', 'mp4'])
  return { file, cleanup }
}

// Runs a download and either sends the result or a friendly error — always
// cleans up the temp file afterward, and never throws back to the caller.
// Shared by commands.js (slash/dot commands) and ai.js (AI tool-calling).
async function sendDownloadResult(sock, chatId, downloadFn, mediaKey, extraFields = {}) {
  let result
  try {
    result = await downloadFn()
  } catch (err) {
    await safeSend(sock, chatId, { text: `⚠️ Couldn't download that: ${err.message}` })
    return false
  }
  try {
    const buffer = fs.readFileSync(result.file)
    await safeSend(sock, chatId, { [mediaKey]: buffer, ...extraFields })
    return true
  } catch (err) {
    await safeSend(sock, chatId, { text: `⚠️ Downloaded it, but couldn't send it (probably too large for WhatsApp): ${err.message}` })
    return false
  } finally {
    result.cleanup()
  }
}

module.exports = { searchYoutube, getVideoInfo, downloadAudio, downloadVideoAtQuality, downloadBest, sendDownloadResult }
