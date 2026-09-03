// Group management commands. Owner-only (see commands.js routing). Commands that
// act "on this group" only work when run from inside the target group itself —
// self-chat has no group to act on.

function numberToJid(number) {
  return number.replace(/[^\d]/g, '') + '@s.whatsapp.net'
}

function requireGroup(chatId) {
  if (!chatId.endsWith('@g.us')) {
    throw new Error('This only works inside the group you want to manage — run it there, not in your self-chat.')
  }
}

async function createGroup(sock, subject, numbers) {
  const participants = numbers.map(numberToJid)
  const group = await sock.groupCreate(subject, participants)
  return group
}

async function updateMembers(sock, chatId, numbers, action) {
  requireGroup(chatId)
  const participants = numbers.map(numberToJid)
  return sock.groupParticipantsUpdate(chatId, participants, action)
}

async function setGroupName(sock, chatId, name) {
  requireGroup(chatId)
  await sock.groupUpdateSubject(chatId, name)
}

async function setGroupDescription(sock, chatId, description) {
  requireGroup(chatId)
  await sock.groupUpdateDescription(chatId, description)
}

async function setGroupIcon(sock, chatId, imageUrl) {
  requireGroup(chatId)
  await sock.updateProfilePicture(chatId, { url: imageUrl })
}

async function getInviteLink(sock, chatId) {
  requireGroup(chatId)
  const code = await sock.groupInviteCode(chatId)
  return `https://chat.whatsapp.com/${code}`
}

async function resetInviteLink(sock, chatId) {
  requireGroup(chatId)
  const code = await sock.groupRevokeInvite(chatId)
  return `https://chat.whatsapp.com/${code}`
}

async function setLocked(sock, chatId, locked) {
  requireGroup(chatId)
  await sock.groupSettingUpdate(chatId, locked ? 'announcement' : 'not_announcement')
}

async function leaveGroup(sock, chatId) {
  requireGroup(chatId)
  await sock.groupLeave(chatId)
}

module.exports = {
  createGroup,
  updateMembers,
  setGroupName,
  setGroupDescription,
  setGroupIcon,
  getInviteLink,
  resetInviteLink,
  setLocked,
  leaveGroup,
}
