// Command router for the control chat ("Message Yourself" — see index.js for
// how that's detected). Every command that sends somewhere else resolves its
// target through targets.js, so the bot can never reach anyone off the
// allow-list in targets.json.

const { resolveTarget, listTargets } = require('./targets')
const { sendImageFromUrl, sendStickerFromUrl, sendImageFromCandidates, sendStickerFromCandidates } = require('./media')
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
const { safeSend } = require('./safeSend')

const HELP_TEXT = `*Your WhatsApp bot — commands*

*Messaging (allow-listed friends/groups only)*
/list — show who's on your allow-list
/groups — list every group you're in, with IDs (use this to fill targets.json)
/send <name> <message> — send text to an allow-listed friend/group
/image <name> <url> [caption] — send an image from a URL
/sticker <description> — find an image for it and send it as a sticker here
/sticker <name> <url> — or convert an image URL you have into a sticker for someone on your allow-list
/schedule <name> <YYYY-MM-DDTHH:MM> <message> — send a message once, later

*Search & links (replies here, in this chat)*
/song <query> — Spotify track link, with preview (needs SPOTIFY_CLIENT_ID/SECRET)
/yt <query> — top YouTube video, with preview (needs SERPAPI_KEY, otherwise a search link)
/search <query> — top Google results with snippets & links (needs SERPAPI_KEY, otherwise a search link)
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
    const answer = await askAI(text.slice(4))
    return safeSend(sock, chatId, { text: answer })
  }

  // Anything else typed in the control chat that isn't a recognized command
  // is treated as a plain question for the AI.
  const answer = await askAI(text)
  return safeSend(sock, chatId, { text: answer })
}

module.exports = { handleCommand }
