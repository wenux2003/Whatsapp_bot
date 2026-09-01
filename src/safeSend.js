// Wraps sock.sendMessage with a small random delay before every send.
// Purely a ban-risk mitigation (see WHATSAPP_BOT_GUIDE.md §Phase 7) — instant,
// machine-gun-fast replies are one of the patterns WhatsApp's automation
// detection looks for. This does not fix everything, just reduces the risk.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function safeSend(sock, jid, content) {
  const delay = 300 + Math.random() * 1200 // 300ms–1.5s
  await sleep(delay)
  return sock.sendMessage(jid, content)
}

module.exports = { safeSend }
