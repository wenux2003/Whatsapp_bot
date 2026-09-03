// Posting to the bot's own WhatsApp Status (Stories). Visible only to the
// friends on your allow-list (targets.json) — WhatsApp requires an explicit
// audience list for status updates, so this reuses the same trusted circle
// the rest of the bot is restricted to.

const { loadTargets } = require('./targets')

function statusAudience() {
  return Object.values(loadTargets().friends)
}

async function postTextStatus(sock, text) {
  await sock.sendMessage('status@broadcast', { text }, { statusJidList: statusAudience() })
}

async function postImageStatus(sock, imageUrl, caption = '') {
  await sock.sendMessage('status@broadcast', { image: { url: imageUrl }, caption }, { statusJidList: statusAudience() })
}

module.exports = { postTextStatus, postImageStatus }
