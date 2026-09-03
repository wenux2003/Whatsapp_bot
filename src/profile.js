// Contact/profile lookups and the bot's own account settings. Owner-only
// (see commands.js routing) — these touch account-level state, not just chat.

function numberToJid(number) {
  return number.replace(/[^\d]/g, '') + '@s.whatsapp.net'
}

async function isOnWhatsApp(sock, number) {
  const [result] = await sock.onWhatsApp(numberToJid(number))
  return result?.exists ? result.jid : null
}

async function getProfilePictureUrl(sock, jid) {
  try {
    return await sock.profilePictureUrl(jid, 'image')
  } catch {
    return null // no picture set, or not visible to this account
  }
}

async function getAboutText(sock, jid) {
  const [status] = await sock.fetchStatus(jid)
  return status?.status || null
}

async function setBlocked(sock, jid, blocked) {
  await sock.updateBlockStatus(jid, blocked ? 'block' : 'unblock')
}

async function setOwnProfilePicture(sock, imageUrl) {
  await sock.updateProfilePicture(sock.user.id, { url: imageUrl })
}

async function setOwnName(sock, name) {
  await sock.updateProfileName(name)
}

async function setOwnStatus(sock, status) {
  await sock.updateProfileStatus(status)
}

module.exports = {
  numberToJid,
  isOnWhatsApp,
  getProfilePictureUrl,
  getAboutText,
  setBlocked,
  setOwnProfilePicture,
  setOwnName,
  setOwnStatus,
}
