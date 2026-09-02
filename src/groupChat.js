// Group-chat behavior — separate from the self-chat control channel (see index.js).
// In any group the bot's number is a member of:
//   - you (the owner) can run any command, including owner-only ones like
//     /delete — recognized whether you type from the bot's own linked number
//     or from your personal number (see ownerJid in config.js and /whoami below)
//   - other members can use a safe subset: /sticker /yt /search /img /song /ai
//   - the bot occasionally joins in — always when @mentioned or replied to,
//     otherwise a small random chance — using AI-generated replies
//   - if a message sits unanswered (by anyone) for 30 minutes, the bot nudges in
//
// /delete stickers <N> removes the last N sticker messages from the group
// (from anyone) using WhatsApp's admin delete-for-everyone — the bot's own
// number needs to be a group admin for that to work on stickers it didn't send.

const fs = require('fs')
const path = require('path')
const { askAI } = require('./ai')
const { safeSend } = require('./safeSend')
const { handleCommand } = require('./commands')
const { getStickerPackInfo } = require('./media')
const { ownerJids } = require('./config')

const IDLE_CHECK_MS = 5 * 60 * 1000 // how often to scan for unanswered messages
const IDLE_THRESHOLD_MS = 30 * 60 * 1000 // how long a message can sit unanswered
const RANDOM_REPLY_CHANCE = 1 / 15
const MAX_TRACKED_STICKERS = 200
const STICKER_LOG_PATH = path.join(__dirname, '..', 'stickerLog.json')

// Stickers whose pack name/publisher contains any of these (case-insensitive)
// get auto-deleted in every group, from the moment the bot starts watching —
// matches the "WhatsApp Sticker Maker" app specifically, from any sender/phone.
const BLOCKED_STICKER_PACK_KEYWORDS = ['whatsapp sticker maker']

const SAFE_COMMAND_PREFIXES = ['/sticker ', '/song ', '/yt ', '/search ', '/img ', '/ai ']

// groupId -> { text, time, answered }
const groupActivity = new Map()

// groupId -> array of message keys for recent sticker messages, oldest first.
// Persisted to disk so /delete still finds stickers sent before the bot's last restart.
function loadStickerLog() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(STICKER_LOG_PATH, 'utf-8'))))
  } catch {
    return new Map()
  }
}

function saveStickerLog() {
  fs.writeFileSync(STICKER_LOG_PATH, JSON.stringify(Object.fromEntries(stickerLog), null, 2))
}

const stickerLog = loadStickerLog()

function noteGroupActivity(groupId, text) {
  groupActivity.set(groupId, { text, time: Date.now(), answered: false })
}

function markAnswered(groupId) {
  const entry = groupActivity.get(groupId)
  if (entry) entry.answered = true
}

function trackSticker(groupId, key) {
  const log = stickerLog.get(groupId) || []
  log.push(key)
  if (log.length > MAX_TRACKED_STICKERS) log.shift()
  stickerLog.set(groupId, log)
  saveStickerLog()
}

async function deleteRecentStickers(sock, groupId, count) {
  const log = stickerLog.get(groupId) || []
  const toDelete = log.slice(-count)
  let deleted = 0
  for (const key of toDelete) {
    try {
      await sock.sendMessage(groupId, { delete: key })
      deleted++
    } catch (err) {
      console.error('Sticker delete failed:', err.message)
    }
  }
  stickerLog.set(groupId, log.slice(0, log.length - toDelete.length))
  saveStickerLog()
  return deleted
}

function isBotJid(jid, { myNumberJid, myLidJid }) {
  return jid === myNumberJid || jid === myLidJid
}

async function moderateSticker(sock, chatId, msg) {
  const info = await getStickerPackInfo(msg.message.stickerMessage)
  if (!info) return false
  const label = `${info['sticker-pack-name'] || ''} ${info['sticker-pack-publisher'] || ''}`.toLowerCase()
  const blocked = BLOCKED_STICKER_PACK_KEYWORDS.some((keyword) => label.includes(keyword))
  if (!blocked) return false
  try {
    await sock.sendMessage(chatId, { delete: msg.key })
  } catch (err) {
    console.error('Auto-delete sticker failed:', err.message)
  }
  return true
}

async function handleGroupMessage(sock, chatId, msg, text, botJids) {
  if (msg.message?.stickerMessage) {
    const removed = await moderateSticker(sock, chatId, msg)
    if (!removed) trackSticker(chatId, msg.key)
  }

  if (text) noteGroupActivity(chatId, text)
  if (!text) return

  const senderJid = msg.key.participant || msg.key.remoteJid
  const isOwner = msg.key.fromMe || ownerJids.includes(senderJid)

  if (text === '/whoami') {
    return safeSend(sock, chatId, { text: `Your JID here: ${senderJid}\n\nPaste this as OWNER_JID in .env to unlock owner-only commands for yourself in any group.` })
  }

  if (isOwner) {
    const deleteMatch = text.match(/^\/delete stickers (\d+)$/i)
    if (deleteMatch) {
      const count = Math.min(parseInt(deleteMatch[1], 10), MAX_TRACKED_STICKERS)
      const deleted = await deleteRecentStickers(sock, chatId, count)
      return safeSend(sock, chatId, { text: `🗑️ Deleted ${deleted} sticker(s).` })
    }
    if (text.startsWith('/')) await handleCommand(sock, chatId, text)
    return
  }

  if (SAFE_COMMAND_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    await handleCommand(sock, chatId, text)
    markAnswered(chatId)
    return
  }

  const contextInfo = msg.message.extendedTextMessage?.contextInfo
  const mentioned = contextInfo?.mentionedJid?.some((jid) => isBotJid(jid, botJids))
  const repliedToBot = contextInfo?.quotedMessage && isBotJid(contextInfo.participant, botJids)

  if (mentioned || repliedToBot) {
    const question = text.replace(/@\d+/g, '').trim() || text
    const answer = await askAI(question)
    await safeSend(sock, chatId, { text: answer })
    markAnswered(chatId)
    return
  }

  if (Math.random() < RANDOM_REPLY_CHANCE) {
    const answer = await askAI(text)
    await safeSend(sock, chatId, { text: answer })
    markAnswered(chatId)
  }
}

function startGroupIdleChecker(sock) {
  setInterval(async () => {
    const now = Date.now()
    for (const [groupId, entry] of groupActivity) {
      if (entry.answered || now - entry.time < IDLE_THRESHOLD_MS) continue
      try {
        const prompt = `Nobody in this WhatsApp group has replied to this message in 30 minutes: "${entry.text}". ` +
          `If you can genuinely help or answer it, do so briefly. If you can't really answer it, just send a short, ` +
          `friendly note saying no one's replied yet and they might be busy. Keep it simple and add an emoji.`
        const answer = await askAI(prompt)
        await safeSend(sock, groupId, { text: answer })
      } catch (err) {
        console.error('Group idle nudge failed:', err.message)
      } finally {
        markAnswered(groupId)
      }
    }
  }, IDLE_CHECK_MS)
}

module.exports = { handleGroupMessage, startGroupIdleChecker }
