// Wraps sock.sendMessage with a small random delay before every send.
// Purely a ban-risk mitigation (see WHATSAPP_BOT_GUIDE.md §Phase 7) — instant,
// machine-gun-fast replies are one of the patterns WhatsApp's automation
// detection looks for. This does not fix everything, just reduces the risk.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// jid -> key of the last message the bot sent there, for the /edit command.
const lastSentKeys = new Map()

async function safeSend(sock, jid, content) {
  const delay = 300 + Math.random() * 1200 // 300ms–1.5s
  await sleep(delay)
  const sent = await sock.sendMessage(jid, content)
  if (sent?.key) lastSentKeys.set(jid, sent.key)
  return sent
}

function getLastSentKey(jid) {
  return lastSentKeys.get(jid) || null
}

// Shows the "typing…" indicator while an async task (e.g. an AI call) runs,
// then clears it. Never lets a presence-update hiccup break the caller.
async function withTyping(sock, jid, task) {
  try {
    await sock.sendPresenceUpdate('composing', jid)
  } catch { /* presence updates are best-effort */ }
  try {
    return await task()
  } finally {
    try {
      await sock.sendPresenceUpdate('paused', jid)
    } catch { /* best-effort */ }
  }
}

module.exports = { safeSend, withTyping, getLastSentKey }
