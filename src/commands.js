// Command router for the control chat ("Message Yourself" — see index.js for
// how that's detected). Every command that sends somewhere else resolves its
// target through targets.js, so the bot can never reach anyone off the
// allow-list in targets.json. Group-management/profile/account commands are
// owner-only by construction — see groupChat.js for how that's enforced.

const { resolveTarget, listTargets } = require('./targets')
const {
  sendImageFromUrl,
  sendStickerFromUrl,
  sendImageFromCandidates,
  sendStickerFromCandidates,
  sendStickerFromQuoted,
} = require('./media')
const {
  youtubeSearchLink,
  googleSearchLink,
  googleImagesLink,
  imageSearchCandidates,
  youtubeTopVideo,
  googleSearchResults,
} = require('./search')
const { askAI } = require('./ai')
const { searchTrack } = require('./spotify')
const { addOneOff } = require('./scheduler')
const { safeSend, withTyping, getLastSentKey } = require('./safeSend')
const {
  createGroup,
  updateMembers,
  setGroupName,
  setGroupDescription,
  setGroupIcon,
  getInviteLink,
  resetInviteLink,
  setLocked,
  leaveGroup,
} = require('./groupAdmin')
const {
  isOnWhatsApp,
  getProfilePictureUrl,
  getAboutText,
  setBlocked,
  setOwnProfilePicture,
  setOwnName,
  setOwnStatus,
} = require('./profile')
const { postTextStatus, postImageStatus } = require('./status')
const settings = require('./settings')

const HELP_TEXT = `*Your WhatsApp bot — commands*

*Messaging (allow-listed friends/groups only)*
/list — show who's on your allow-list
/groups — list every group you're in, with IDs (use this to fill targets.json)
/send <name> <message> — send text to an allow-listed friend/group
/image <name> <url> [caption] — send an image from a URL
/sticker <description> — find an image for it and send it as a sticker here
/sticker <name> <url> — or convert an image URL you have into a sticker for someone on your allow-list
/sticker or /make (as a reply to a photo, GIF, video, or sticker) — turn that media into a sticker
/voice <name> <url> — send an audio file as a voice note
/contact <name> — share an allow-listed contact's info as a vCard
/schedule <name> <YYYY-MM-DDTHH:MM> <message> — send a message once, later

*Search & links (replies here, in this chat)*
/song <query> — Spotify track link, with preview (needs SPOTIFY_CLIENT_ID/SECRET)
/yt <query> — top YouTube video, with preview (needs SERPAPI_KEY, otherwise a search link)
/search <query> — top Google results with snippets & links (needs SERPAPI_KEY, otherwise a search link)
/img <query> — an image (real result if SERPAPI_KEY is set, otherwise a search link)

*In-chat tools*
/react <emoji> (as a reply) — react to that message
/star (as a reply) — star that message
/poll <question> | <option1> | <option2> | ... — create a poll here
/edit <new text> — edit the bot's own last message in this chat
/readreceipts on|off — toggle whether the bot marks messages as read

*Group management (run inside the group you want to manage)*
/creategroup <name> | <number1,number2,...> — create a new group
/addmember <number> — add someone to this group
/removemember <number> — remove someone from this group
/promote <number> — make someone an admin
/demote <number> — remove someone's admin
/groupname <new name>
/groupdesc <new description>
/groupicon <image-url>
/invitelink — get this group's invite link
/resetlink — revoke and get a new invite link
/lockgroup — only admins can send messages
/unlockgroup — everyone can send messages
/leavegroup — the bot leaves this group

*Contacts & profile*
/checknumber <number> — check if a number is on WhatsApp
/pfp <name> — get an allow-listed contact's profile picture
/about <name> — get their About/status text
/block <name> / /unblock <name>
/setpfp <url> — set the bot's own profile picture
/setname <text> — set the bot's own display name
/setstatus <text> — set the bot's own About/status text
/poststatus <text> — post a text update to WhatsApp Status
/poststatus <image-url> [caption] — post an image update to WhatsApp Status
(Status updates are only visible to friends on your allow-list.)

*AI*
/ai <question> — ask the AI directly
(anything else you type here that isn't a command above is sent to the AI too)`

function splitCommand(text, maxParts) {
  // Splits into at most maxParts pieces, the last piece keeping the rest of the string intact.
  return text.trim().split(/\s+/).reduce((acc, word, i) => {
    if (i < maxParts - 1) acc.push(word)
    else acc[maxParts - 1] = acc[maxParts - 1] ? `${acc[maxParts - 1]} ${word}` : word
    return acc
  }, [])
}

async function handleCommand(sock, chatId, rawText, msg = null) {
  const text = (rawText || '').trim()
  if (!text) return

  if (/^\/(sticker|make)$/i.test(text)) {
    const quotedMessage = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage
    if (quotedMessage) {
      const sent = await sendStickerFromQuoted(sock, chatId, quotedMessage)
      if (sent) return
    }
    return safeSend(sock, chatId, { text: '😕 Reply to a photo, GIF, video, or sticker with /sticker (or /make) to turn it into a sticker.' })
  }

  if (text.startsWith('/react ')) {
    const emoji = text.slice(7).trim()
    const contextInfo = msg?.message?.extendedTextMessage?.contextInfo
    if (!contextInfo?.stanzaId) return safeSend(sock, chatId, { text: 'Reply to a message with /react <emoji> to react to it.' })
    const key = { remoteJid: chatId, id: contextInfo.stanzaId, fromMe: false, participant: contextInfo.participant }
    await sock.sendMessage(chatId, { react: { text: emoji, key } })
    return
  }

  if (text === '/star') {
    const contextInfo = msg?.message?.extendedTextMessage?.contextInfo
    if (!contextInfo?.stanzaId) return safeSend(sock, chatId, { text: 'Reply to a message with /star to star it.' })
    await sock.star(chatId, [{ id: contextInfo.stanzaId, fromMe: false }], true)
    return
  }

  if (text.startsWith('/poll ')) {
    const parts = text.slice(6).split('|').map((p) => p.trim()).filter(Boolean)
    const [question, ...options] = parts
    if (!question || options.length < 2) {
      return safeSend(sock, chatId, { text: 'Usage: /poll <question> | <option1> | <option2> | ...' })
    }
    await sock.sendMessage(chatId, { poll: { name: question, values: options, selectableCount: 1 } })
    return
  }

  if (text.startsWith('/edit ')) {
    const newText = text.slice(6)
    const lastKey = getLastSentKey(chatId)
    if (!lastKey) return safeSend(sock, chatId, { text: "I haven't sent anything in this chat yet to edit." })
    await sock.sendMessage(chatId, { text: newText, edit: lastKey })
    return
  }

  if (text.startsWith('/readreceipts ')) {
    const value = text.slice(14).trim().toLowerCase()
    if (value !== 'on' && value !== 'off') return safeSend(sock, chatId, { text: 'Usage: /readreceipts on|off' })
    settings.set('readReceipts', value === 'on')
    return safeSend(sock, chatId, { text: `👁️ Read receipts turned ${value}.` })
  }

  if (text === '/help') {
    return safeSend(sock, chatId, { text: HELP_TEXT })
  }

  if (text === '/list') {
    const { friends, groups } = listTargets()
    return safeSend(sock, chatId, {
      text: `*Friends:* ${friends.join(', ') || '(none yet)'}\n*Groups:* ${groups.join(', ') || '(none yet)'}\n\nEdit targets.json to add more.`,
    })
  }

  if (text === '/groups') {
    const groups = await sock.groupFetchAllParticipating()
    const lines = Object.values(groups).map((g) => `${g.subject} → ${g.id}`)
    const body = lines.length ? lines.join('\n') : "You're not in any groups on this account yet."
    return safeSend(sock, chatId, { text: `*Groups this number is in:*\n${body}\n\nCopy an ID into targets.json to allow-list it.` })
  }

  if (text.startsWith('/send ')) {
    const [, name, message] = splitCommand(text, 3)
    const jid = resolveTarget(name)
    if (!jid) return safeSend(sock, chatId, { text: `"${name}" isn't on your allow-list. Add it to targets.json first, or run /list to see who's on it.` })
    if (!message) return safeSend(sock, chatId, { text: 'Usage: /send <name> <message>' })
    await safeSend(sock, jid, { text: message })
    return safeSend(sock, chatId, { text: `✅ Sent to ${name}.` })
  }

  if (text.startsWith('/image ')) {
    const [, name, rest] = splitCommand(text, 3)
    const jid = resolveTarget(name)
    if (!jid) return safeSend(sock, chatId, { text: `"${name}" isn't on your allow-list.` })
    const [url, ...captionParts] = (rest || '').split(' ')
    if (!url) return safeSend(sock, chatId, { text: 'Usage: /image <name> <image-url> [caption]' })
    try {
      await sendImageFromUrl(sock, jid, url, captionParts.join(' '))
      return safeSend(sock, chatId, { text: `✅ Image sent to ${name}.` })
    } catch (err) {
      return safeSend(sock, chatId, { text: `⚠️ Couldn't send that image: ${err.message}` })
    }
  }

  if (text.startsWith('/voice ')) {
    const [, name, url] = splitCommand(text, 3)
    const jid = resolveTarget(name)
    if (!jid) return safeSend(sock, chatId, { text: `"${name}" isn't on your allow-list.` })
    if (!url) return safeSend(sock, chatId, { text: 'Usage: /voice <name> <audio-url>' })
    try {
      await safeSend(sock, jid, { audio: { url }, mimetype: 'audio/mp4', ptt: true })
      return safeSend(sock, chatId, { text: `✅ Voice note sent to ${name}.` })
    } catch (err) {
      return safeSend(sock, chatId, { text: `⚠️ Couldn't send that voice note: ${err.message}` })
    }
  }

  if (text.startsWith('/contact ')) {
    const name = text.slice(9).trim()
    const jid = resolveTarget(name)
    if (!jid) return safeSend(sock, chatId, { text: `"${name}" isn't on your allow-list.` })
    const number = jid.split('@')[0]
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL;waid=${number}:+${number}\nEND:VCARD`
    await safeSend(sock, chatId, { contacts: { displayName: name, contacts: [{ displayName: name, vcard }] } })
    return
  }

  if (text.startsWith('/sticker ')) {
    const rest = text.slice(9)
    const [maybeName, maybeUrl] = splitCommand(rest, 2)
    const jid = resolveTarget(maybeName)

    // "/sticker <allow-listed name> <image-url>" — send a sticker you already have a link for, to someone else.
    if (jid && /^https?:\/\//i.test(maybeUrl || '')) {
      try {
        await sendStickerFromUrl(sock, jid, maybeUrl)
        return safeSend(sock, chatId, { text: `✅ Sticker sent to ${maybeName}.` })
      } catch (err) {
        return safeSend(sock, chatId, { text: `⚠️ Couldn't make that sticker: ${err.message}` })
      }
    }

    // "/sticker <description>" — find an image for it and send the sticker right here.
    // Tries a few candidates since some hosts block hotlinked/bot downloads.
    const candidates = await imageSearchCandidates(rest)
    if (!candidates.length) {
      return safeSend(sock, chatId, { text: `😕 Couldn't find an image for "${rest}" — try a different description.` })
    }
    const sent = await sendStickerFromCandidates(sock, chatId, candidates)
    if (!sent) {
      return safeSend(sock, chatId, { text: `⚠️ Found images for "${rest}" but couldn't download any of them — try a different description.` })
    }
    return
  }

  if (text.startsWith('/schedule ')) {
    const [, name, atISO, message] = splitCommand(text, 4)
    if (!resolveTarget(name)) return safeSend(sock, chatId, { text: `"${name}" isn't on your allow-list.` })
    const when = new Date(atISO)
    if (isNaN(when.getTime()) || !message) {
      return safeSend(sock, chatId, { text: 'Usage: /schedule <name> <YYYY-MM-DDTHH:MM> <message>\ne.g. /schedule sarah 2026-09-05T18:00 Running late, sorry!' })
    }
    addOneOff({ atISO: when.toISOString(), target: name, message })
    return safeSend(sock, chatId, { text: `⏰ Scheduled for ${when.toLocaleString()}.` })
  }

  // ---- Group management (must be run inside the group being managed) ----

  if (text.startsWith('/creategroup ')) {
    const [namePart, numbersPart] = text.slice(13).split('|').map((p) => p.trim())
    const numbers = (numbersPart || '').split(',').map((n) => n.trim()).filter(Boolean)
    if (!namePart || !numbers.length) {
      return safeSend(sock, chatId, { text: 'Usage: /creategroup <name> | <number1,number2,...>' })
    }
    try {
      const group = await createGroup(sock, namePart, numbers)
      return safeSend(sock, chatId, { text: `✅ Created "${namePart}" — ${group.id}` })
    } catch (err) {
      return safeSend(sock, chatId, { text: `⚠️ Couldn't create the group: ${err.message}` })
    }
  }

  if (text.startsWith('/addmember ') || text.startsWith('/removemember ') || text.startsWith('/promote ') || text.startsWith('/demote ')) {
    const [cmd, number] = splitCommand(text, 2)
    const action = { '/addmember': 'add', '/removemember': 'remove', '/promote': 'promote', '/demote': 'demote' }[cmd]
    if (!number) return safeSend(sock, chatId, { text: `Usage: ${cmd} <number>` })
    try {
      await updateMembers(sock, chatId, [number], action)
      return safeSend(sock, chatId, { text: `✅ Done.` })
    } catch (err) {
      return safeSend(sock, chatId, { text: `⚠️ ${err.message}` })
    }
  }

  if (text.startsWith('/groupname ')) {
    try {
      await setGroupName(sock, chatId, text.slice(11))
      return safeSend(sock, chatId, { text: '✅ Group name updated.' })
    } catch (err) {
      return safeSend(sock, chatId, { text: `⚠️ ${err.message}` })
    }
  }

  if (text.startsWith('/groupdesc ')) {
    try {
      await setGroupDescription(sock, chatId, text.slice(11))
      return safeSend(sock, chatId, { text: '✅ Group description updated.' })
    } catch (err) {
      return safeSend(sock, chatId, { text: `⚠️ ${err.message}` })
    }
  }

  if (text.startsWith('/groupicon ')) {
    try {
      await setGroupIcon(sock, chatId, text.slice(11).trim())
      return safeSend(sock, chatId, { text: '✅ Group icon updated.' })
    } catch (err) {
      return safeSend(sock, chatId, { text: `⚠️ ${err.message}` })
    }
  }

  if (text === '/invitelink') {
    try {
      return safeSend(sock, chatId, { text: await getInviteLink(sock, chatId) })
    } catch (err) {
      return safeSend(sock, chatId, { text: `⚠️ ${err.message}` })
    }
  }

  if (text === '/resetlink') {
    try {
      return safeSend(sock, chatId, { text: await resetInviteLink(sock, chatId) })
    } catch (err) {
      return safeSend(sock, chatId, { text: `⚠️ ${err.message}` })
    }
  }

  if (text === '/lockgroup' || text === '/unlockgroup') {
    try {
      await setLocked(sock, chatId, text === '/lockgroup')
      return safeSend(sock, chatId, { text: text === '/lockgroup' ? '🔒 Only admins can send messages now.' : '🔓 Everyone can send messages now.' })
    } catch (err) {
      return safeSend(sock, chatId, { text: `⚠️ ${err.message}` })
    }
  }

  if (text === '/leavegroup') {
    try {
      await leaveGroup(sock, chatId)
      return
    } catch (err) {
      return safeSend(sock, chatId, { text: `⚠️ ${err.message}` })
    }
  }

  // ---- Contacts & profile ----

  if (text.startsWith('/checknumber ')) {
    const jid = await isOnWhatsApp(sock, text.slice(13))
    return safeSend(sock, chatId, { text: jid ? `✅ Yes, that number is on WhatsApp (${jid}).` : "❌ That number isn't on WhatsApp." })
  }

  if (text.startsWith('/pfp ')) {
    const name = text.slice(5).trim()
    const jid = resolveTarget(name)
    if (!jid) return safeSend(sock, chatId, { text: `"${name}" isn't on your allow-list.` })
    const url = await getProfilePictureUrl(sock, jid)
    if (!url) return safeSend(sock, chatId, { text: `😕 No profile picture visible for ${name}.` })
    try {
      await sendImageFromUrl(sock, chatId, url, `📷 ${name}'s profile picture`)
    } catch (err) {
      return safeSend(sock, chatId, { text: `⚠️ Couldn't fetch that picture: ${err.message}` })
    }
    return
  }

  if (text.startsWith('/about ')) {
    const name = text.slice(7).trim()
    const jid = resolveTarget(name)
    if (!jid) return safeSend(sock, chatId, { text: `"${name}" isn't on your allow-list.` })
    const about = await getAboutText(sock, jid)
    return safeSend(sock, chatId, { text: about ? `📝 ${name}: ${about}` : `😕 No About text visible for ${name}.` })
  }

  if (text.startsWith('/block ') || text.startsWith('/unblock ')) {
    const block = text.startsWith('/block ')
    const name = text.slice(block ? 7 : 9).trim()
    const jid = resolveTarget(name)
    if (!jid) return safeSend(sock, chatId, { text: `"${name}" isn't on your allow-list.` })
    await setBlocked(sock, jid, block)
    return safeSend(sock, chatId, { text: block ? `🚫 Blocked ${name}.` : `✅ Unblocked ${name}.` })
  }

  if (text.startsWith('/setpfp ')) {
    try {
      await setOwnProfilePicture(sock, text.slice(8).trim())
      return safeSend(sock, chatId, { text: '✅ Profile picture updated.' })
    } catch (err) {
      return safeSend(sock, chatId, { text: `⚠️ ${err.message}` })
    }
  }

  if (text.startsWith('/setname ')) {
    await setOwnName(sock, text.slice(9))
    return safeSend(sock, chatId, { text: '✅ Name updated.' })
  }

  if (text.startsWith('/setstatus ')) {
    await setOwnStatus(sock, text.slice(11))
    return safeSend(sock, chatId, { text: '✅ Status updated.' })
  }

  if (text.startsWith('/poststatus ')) {
    const rest = text.slice(12).trim()
    const [maybeUrl, ...captionParts] = rest.split(' ')
    try {
      if (/^https?:\/\//i.test(maybeUrl)) {
        await postImageStatus(sock, maybeUrl, captionParts.join(' '))
      } else {
        await postTextStatus(sock, rest)
      }
      return safeSend(sock, chatId, { text: '✅ Posted to Status.' })
    } catch (err) {
      return safeSend(sock, chatId, { text: `⚠️ Couldn't post that: ${err.message}` })
    }
  }

  // ---- Search & links ----

  if (text.startsWith('/song ')) {
    const query = text.slice(6)
    const track = await searchTrack(query)
    if (track) {
      return safeSend(sock, chatId, { text: `🎵 *${track.name}* — ${track.artists}\n${track.link}` })
    }
    return safeSend(sock, chatId, { text: '🎵 Spotify search isn\'t set up yet — add SPOTIFY_CLIENT_ID/SECRET to .env (see README.md).' })
  }

  if (text.startsWith('/yt ')) {
    const query = text.slice(4)
    const top = await youtubeTopVideo(query)
    if (top) {
      const who = top.channel ? ` — ${top.channel}` : ''
      return safeSend(sock, chatId, { text: `🎬 *${top.title}*${who}\n${top.link}` })
    }
    return safeSend(sock, chatId, { text: `🔎 ${youtubeSearchLink(query)}` })
  }

  if (text.startsWith('/search ')) {
    const query = text.slice(8)
    const results = await googleSearchResults(query)
    if (results) {
      const body = results
        .map((r, i) => `${i + 1}️⃣ *${r.title}*\n${r.snippet ? r.snippet + '\n' : ''}🔗 ${r.link}`)
        .join('\n\n')
      return safeSend(sock, chatId, { text: `🔎 Top results for "${query}":\n\n${body}` })
    }
    return safeSend(sock, chatId, { text: `🔎 ${googleSearchLink(query)}` })
  }

  if (text.startsWith('/img ')) {
    const query = text.slice(5)
    const candidates = await imageSearchCandidates(query) // [] if SERPAPI_KEY isn't set — see .env.example
    if (candidates.length) {
      const sent = await sendImageFromCandidates(sock, chatId, candidates, `📷 ${query}`)
      if (sent) return
    }
    return safeSend(sock, chatId, { text: `🔎 ${googleImagesLink(query)}` })
  }

  if (text.startsWith('/ai ')) {
    const answer = await withTyping(sock, chatId, () => askAI(text.slice(4)))
    return safeSend(sock, chatId, { text: answer })
  }

  // Anything else typed in the control chat that isn't a recognized command
  // is treated as a plain question for the AI.
  const answer = await withTyping(sock, chatId, () => askAI(text))
  return safeSend(sock, chatId, { text: answer })
}

module.exports = { handleCommand }
