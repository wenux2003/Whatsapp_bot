// Group-chat behavior — separate from the self-chat control channel (see index.js).
// In any group the bot's number is a member of:
//   - the owner (you) can still run any command directly in the group
//   - other members can use a safe subset: /yt /search /img /ai
//   - the bot occasionally joins in — always when @mentioned or replied to,
//     otherwise a small random chance — using AI-generated replies
//   - if a message sits unanswered (by anyone) for 30 minutes, the bot nudges in

const { askAI } = require('./ai')
const { safeSend } = require('./safeSend')
const { handleCommand } = require('./commands')

const IDLE_CHECK_MS = 5 * 60 * 1000 // how often to scan for unanswered messages
const IDLE_THRESHOLD_MS = 30 * 60 * 1000 // how long a message can sit unanswered
const RANDOM_REPLY_CHANCE = 1 / 15

const SAFE_COMMAND_PREFIXES = ['/song ', '/yt ', '/search ', '/img ', '/ai ']

// groupId -> { text, time, answered }
const groupActivity = new Map()

function noteGroupActivity(groupId, text) {
  groupActivity.set(groupId, { text, time: Date.now(), answered: false })
}

function markAnswered(groupId) {
  const entry = groupActivity.get(groupId)
  if (entry) entry.answered = true
}

function isBotJid(jid, { myNumberJid, myLidJid }) {
  return jid === myNumberJid || jid === myLidJid
}

async function handleGroupMessage(sock, chatId, msg, text, botJids) {
  if (text) noteGroupActivity(chatId, text)
  if (!text) return

  const isOwner = msg.key.fromMe

  if (isOwner) {
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
