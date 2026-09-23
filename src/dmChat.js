// Handles a direct 1-on-1 chat with the bot's number that ISN'T the owner's
// own self-chat — i.e. any other WhatsApp user who messages the bot directly.
// They get the same safe command subset group members get (see
// groupChat.js's SAFE_COMMAND_PREFIXES) — never owner-only/admin commands,
// and no free-form AI chat for arbitrary text (only via explicit /ai), to
// keep API usage bounded since anyone with the bot's number can reach this.

const { handleCommand } = require('./commands')
const { ownerJids } = require('./config')
const pendingActions = require('./pendingActions')
const { SAFE_COMMAND_PREFIXES } = require('./groupChat')

async function handleDirectMessage(sock, chatId, msg, text) {
  if (!text) return

  // The owner messaging the bot's number from a different linked number
  // (see OWNER_JID) still gets full access, same as in groups.
  const isOwner = ownerJids.includes(chatId)
  if (isOwner) {
    if (text.startsWith('/')) await handleCommand(sock, chatId, text, msg, { isOwner: true })
    return
  }

  const isBareStickerOrMake = /^\/(sticker|make)$/i.test(text)
  const hasPendingAction = !!pendingActions.get(chatId)
  if (isBareStickerOrMake || hasPendingAction || SAFE_COMMAND_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    await handleCommand(sock, chatId, text, msg, { isOwner: false })
  }
}

module.exports = { handleDirectMessage }
