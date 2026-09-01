// Command router for the control chat ("Message Yourself" — see index.js for
// how that's detected). Every command that sends somewhere else resolves its
// target through targets.js, so the bot can never reach anyone off the
// allow-list in targets.json.

const { resolveTarget, listTargets } = require('./targets')
const { sendImageFromUrl, sendStickerFromUrl } = require('./media')
const { youtubeSearchLink, googleSearchLink, googleImagesLink, realImageSearch } = require('./search')
const { askAI } = require('./ai')
const { addOneOff } = require('./scheduler')
const { safeSend } = require('./safeSend')

const HELP_TEXT = `*Your WhatsApp bot — commands*

*Messaging (allow-listed friends/groups only)*
/list — show who's on your allow-list
/groups — list every group you're in, with IDs (use this to fill targets.json)
/send <name> <message> — send text to an allow-listed friend/group
/image <name> <url> [caption] — send an image from a URL
/sticker <name> <url> — convert an image URL to a sticker and send it
/schedule <name> <YYYY-MM-DDTHH:MM> <message> — send a message once, later

*Search & links (replies here, in this chat)*
/yt <query> — YouTube search link
/search <query> — Google search link
/img <query> — an image (real result if SERPAPI_KEY is set, otherwise a search link)

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

async function handleCommand(sock, chatId, rawText) {
  const text = (rawText || '').trim()
  if (!text) return

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

  if (text.startsWith('/sticker ')) {
    const [, name, url] = splitCommand(text, 3)
    const jid = resolveTarget(name)
    if (!jid) return safeSend(sock, chatId, { text: `"${name}" isn't on your allow-list.` })
    if (!url) return safeSend(sock, chatId, { text: 'Usage: /sticker <name> <image-url>' })
    try {
      await sendStickerFromUrl(sock, jid, url)
      return safeSend(sock, chatId, { text: `✅ Sticker sent to ${name}.` })
    } catch (err) {
      return safeSend(sock, chatId, { text: `⚠️ Couldn't make that sticker: ${err.message}` })
    }
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

  if (text.startsWith('/yt ')) {
    return safeSend(sock, chatId, { text: youtubeSearchLink(text.slice(4)) })
  }

  if (text.startsWith('/search ')) {
    return safeSend(sock, chatId, { text: googleSearchLink(text.slice(8)) })
  }

  if (text.startsWith('/img ')) {
    const query = text.slice(5)
    const realUrl = await realImageSearch(query) // null if SERPAPI_KEY isn't set — see .env.example
    if (realUrl) {
      try {
        return sendImageFromUrl(sock, chatId, realUrl, query)
      } catch {
        // fall through to the plain link below
      }
    }
    return safeSend(sock, chatId, { text: googleImagesLink(query) })
  }

  if (text.startsWith('/ai ')) {
    const answer = await askAI(text.slice(4))
    return safeSend(sock, chatId, { text: answer })
  }

  // Anything else typed in the control chat that isn't a recognized command
  // is treated as a plain question for the AI.
  const answer = await askAI(text)
  return safeSend(sock, chatId, { text: answer })
}

module.exports = { handleCommand }
