// Tracks per-chat multi-step conversations (e.g. ".yt" video → quality
// selection, "/pin" duration selection) — a bare numbered reply only means
// something once one of these is waiting. Expires after 5 minutes so a stale
// "1" typed hours later doesn't accidentally trigger an old flow.

const TIMEOUT_MS = 5 * 60 * 1000
const pending = new Map() // chatId -> { type, data, expiresAt }

function set(chatId, type, data) {
  pending.set(chatId, { type, data, expiresAt: Date.now() + TIMEOUT_MS })
}

function get(chatId) {
  const entry = pending.get(chatId)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    pending.delete(chatId)
    return null
  }
  return entry
}

function clear(chatId) {
  pending.delete(chatId)
}

module.exports = { set, get, clear }
