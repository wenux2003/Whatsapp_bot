// "Mini AI" chat replies via Groq's API (free tier, no card required to start).
// PLACEHOLDER — set GROQ_API_KEY in .env (see .env.example) to enable this.
// Until then, askAI() just tells you it's not configured instead of crashing.
//
// The model can also be given "tools" — /ai (and, with a safe read-only subset,
// group mentions/random replies) can trigger most of the bot's own commands
// from a plain-English request, and the reply matches what the equivalent
// slash/dot command would send. Full tool access (sending messages, managing
// groups, scheduling, downloads) is owner-only; group members' AI replies only
// get read-only lookups, so a prompt-injected message can't trigger real actions.

const Groq = require('groq-sdk')
// Groq's tool-calling schema uses plain lowercase JSON-Schema type strings —
// this just lets every tool below keep using the same Type.OBJECT/STRING/etc.
// spelling as before, with zero changes to the (large) tool definitions.
const Type = { OBJECT: 'object', STRING: 'string', ARRAY: 'array', BOOLEAN: 'boolean' }
const { groqApiKeys, serpApiKey, timezone } = require('./config')
const { googleSearchResults, youtubeTopVideo, youtubeSearchLink, googleSearchLink, googleImagesLink, imageSearchCandidates } = require('./search')
const { searchTrack } = require('./spotify')
const { sendImageFromCandidates } = require('./media')
const { resolveTarget, listTargets } = require('./targets')
const { addOneOff, addCronJob, dailyCron, weeklyCron, isValidTime, describeReminders, DAY_NUMBERS } = require('./scheduler')
const { safeSend } = require('./safeSend')
const {
  createGroup,
  updateMembers,
  setGroupName,
  setGroupDescription,
  getInviteLink,
  setLocked,
  leaveGroup,
} = require('./groupAdmin')
const { isOnWhatsApp, getProfilePictureUrl, getAboutText, setOwnName, setOwnStatus } = require('./profile')
const { postTextStatus } = require('./status')
const { searchYoutube, getVideoInfo, downloadAudio, downloadVideoAtQuality, downloadBest, sendDownloadResult } = require('./downloader')

const MODEL = 'llama-3.3-70b-versatile' // check https://console.groq.com/docs/models if this stops working
const SYSTEM_INSTRUCTION = 'You reply over WhatsApp chat. Use simple, easy English. ' +
  'When giving detailed answers or data (lists, facts, explanations), use relevant emojis ' +
  'to make it friendly and easy to scan. Keep it concise. ' +
  'Your own knowledge has a training cutoff and may be outdated, especially for recent products, ' +
  'prices, or events. If live search results are included with the question, trust those over your ' +
  'own memory and answer as of today — do not claim something "isn\'t out yet" if the search results say otherwise. ' +
  'If a tool is available and relevant to the request, call it rather than answering from memory or explaining ' +
  'how to do it manually — actually do it. If a request needs multiple tools (e.g. a reminder and a song), call all of them.'

// One client per key — rotated on quota errors so a single exhausted free-tier
// key doesn't take the whole bot down. See GROQ_API_KEY in .env.example.
const clients = groqApiKeys.map((apiKey) => new Groq({ apiKey }))
let currentClientIndex = 0

const RETRY_DELAYS_MS = [1000, 3000] // retry twice (per key) before giving up
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isOverloaded(err) {
  return err.status === 503 || err.status === 500 || err.status === 502
}

function isQuotaExceeded(err) {
  return err.status === 429
}

async function buildGroundedContents(question) {
  const dateLine = `Today's date: ${new Date().toDateString()}.`
  if (!serpApiKey) return `${dateLine}\n\nQuestion: ${question}`
  try {
    const results = await googleSearchResults(question, 3)
    if (!results) return `${dateLine}\n\nQuestion: ${question}`
    const context = results.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet || ''} (${r.link})`).join('\n')
    return `${dateLine}\nLive Google search results for this question:\n${context}\n\nQuestion: ${question}`
  } catch (err) {
    console.error('AI grounding search failed:', err.message)
    return `${dateLine}\n\nQuestion: ${question}`
  }
}

// ---- Tools the model can call. See runTool() below for what each one does. ----

const SAFE_TOOLS = [
  {
    name: 'get_song',
    description: "Finds a song on Spotify and returns its title, artist, and link — same as the bot's /song command.",
    parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: 'Song name and/or artist' } }, required: ['query'] },
  },
  {
    name: 'get_youtube_video',
    description: "Finds the top YouTube video for a query and returns it with a preview — same as the bot's /yt command.",
    parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING } }, required: ['query'] },
  },
  {
    name: 'google_search',
    description: "Runs a real Google search and returns the top results with snippets and links — same as the bot's /search command.",
    parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING } }, required: ['query'] },
  },
  {
    name: 'get_image',
    description: "Finds and sends a real photo for a description — same as the bot's /img command.",
    parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: 'What the image should show' } }, required: ['query'] },
  },
]

function targetNames() {
  const { friends, groups } = listTargets()
  return [...friends, ...groups]
}

function targetDescription() {
  const names = targetNames()
  return `Must be exactly one of: ${names.join(', ') || '(no allow-listed names configured yet)'}`
}

const FULL_ONLY_TOOLS = [
  {
    name: 'set_reminder',
    description: 'Schedules a WhatsApp reminder message to an allow-listed friend or group — once at a specific time, or repeating daily/weekly.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: { type: Type.STRING, description: `Who to send it to. ${targetDescription()}` },
        type: { type: Type.STRING, description: 'One of: once, daily, weekly' },
        message: { type: Type.STRING, description: 'The reminder text to send' },
        datetime: { type: Type.STRING, description: 'Only for type=once: exact date/time as YYYY-MM-DDTHH:MM' },
        time: { type: Type.STRING, description: 'Only for type=daily or weekly: time of day as 24-hour HH:MM' },
        day: { type: Type.STRING, description: 'Only for type=weekly: day of the week, e.g. monday' },
      },
      required: ['target', 'type', 'message'],
    },
  },
  {
    name: 'list_reminders',
    description: "Lists every reminder currently scheduled (one-time, daily, weekly) — same as the bot's /reminders command.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'create_poll',
    description: 'Creates a real WhatsApp poll in this chat with a question and 2+ options.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        question: { type: Type.STRING },
        options: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'At least 2 poll options' },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'send_message',
    description: 'Sends a plain text WhatsApp message to an allow-listed friend or group.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: { type: Type.STRING, description: targetDescription() },
        message: { type: Type.STRING },
      },
      required: ['target', 'message'],
    },
  },
  {
    name: 'download_song',
    description: 'Finds and downloads the actual audio for a song (or a given URL) and sends it as a real audio file in this chat — different from get_song, which only sends a Spotify link.',
    parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: 'Song name/artist, or a direct video URL' } }, required: ['query'] },
  },
  {
    name: 'download_youtube_video',
    description: 'Finds a YouTube video by name (or takes a direct YouTube URL) and downloads + sends the actual video file in this chat at the given quality.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Video name/description, or a direct YouTube URL' },
        quality: { type: Type.STRING, description: 'One of: 360p, 480p, 720p, 1080p. Default 480p if not specified.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'download_social_video',
    description: 'Downloads a video from a direct TikTok, Instagram, or Facebook URL and sends it in this chat.',
    parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING } }, required: ['url'] },
  },
  {
    name: 'create_group',
    description: 'Creates a new WhatsApp group with the given name and member phone numbers.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        numbers: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Phone numbers with country code, no + or spaces' },
      },
      required: ['name', 'numbers'],
    },
  },
  {
    name: 'manage_group_member',
    description: 'Adds, removes, promotes, or demotes a member of THIS group (only works when called from inside the group being managed).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        number: { type: Type.STRING, description: 'Phone number with country code, no + or spaces' },
        action: { type: Type.STRING, description: 'One of: add, remove, promote, demote' },
      },
      required: ['number', 'action'],
    },
  },
  {
    name: 'set_group_info',
    description: "Changes THIS group's name and/or description (only works when called from inside the group).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: 'New group name, if changing it' },
        description: { type: Type.STRING, description: 'New group description, if changing it' },
      },
    },
  },
  {
    name: 'set_group_lock',
    description: 'Locks (only admins can send messages) or unlocks THIS group.',
    parameters: { type: Type.OBJECT, properties: { locked: { type: Type.BOOLEAN } }, required: ['locked'] },
  },
  {
    name: 'get_group_invite_link',
    description: "Gets THIS group's invite link.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'leave_group',
    description: 'Makes the bot leave THIS group.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'check_number_on_whatsapp',
    description: 'Checks whether a phone number is registered on WhatsApp.',
    parameters: { type: Type.OBJECT, properties: { number: { type: Type.STRING } }, required: ['number'] },
  },
  {
    name: 'get_contact_info',
    description: "Gets an allow-listed contact's profile picture and/or About/status text.",
    parameters: { type: Type.OBJECT, properties: { target: { type: Type.STRING, description: targetDescription() } }, required: ['target'] },
  },
  {
    name: 'set_own_profile',
    description: "Changes the bot's own WhatsApp display name and/or About/status text.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: 'New display name, if changing it' },
        status: { type: Type.STRING, description: 'New About/status text, if changing it' },
      },
    },
  },
  {
    name: 'post_status_update',
    description: 'Posts a text update to the WhatsApp Status (visible to allow-listed friends only).',
    parameters: { type: Type.OBJECT, properties: { text: { type: Type.STRING } }, required: ['text'] },
  },
]

function toolsForLevel(level) {
  if (level === 'full') return [...SAFE_TOOLS, ...FULL_ONLY_TOOLS]
  if (level === 'safe') return SAFE_TOOLS
  return null
}

async function runTool(call, ctx) {
  const { name, args } = call
  const { sock, chatId } = ctx
  try {
    switch (name) {
      case 'get_song': {
        const track = await searchTrack(args.query)
        return track
          ? `🎵 *${track.name}* — ${track.artists}\n${track.link}`
          : '🎵 Spotify search isn\'t set up yet — add SPOTIFY_CLIENT_ID/SECRET to .env (see README.md).'
      }
      case 'get_youtube_video': {
        const top = await youtubeTopVideo(args.query)
        if (top) return `🎬 *${top.title}*${top.channel ? ` — ${top.channel}` : ''}\n${top.link}`
        return `🔎 ${youtubeSearchLink(args.query)}`
      }
      case 'google_search': {
        const results = await googleSearchResults(args.query)
        if (results) {
          const body = results.map((r, i) => `${i + 1}️⃣ *${r.title}*\n${r.snippet ? r.snippet + '\n' : ''}🔗 ${r.link}`).join('\n\n')
          return `🔎 Top results for "${args.query}":\n\n${body}`
        }
        return `🔎 ${googleSearchLink(args.query)}`
      }
      case 'get_image': {
        const candidates = await imageSearchCandidates(args.query)
        if (candidates.length && sock && chatId) {
          const sent = await sendImageFromCandidates(sock, chatId, candidates, `📷 ${args.query}`)
          if (sent) return null // the photo itself is the reply — nothing more to say
        }
        return `🔎 ${googleImagesLink(args.query)}`
      }
      case 'set_reminder': {
        if (!resolveTarget(args.target)) return `⚠️ "${args.target}" isn't on the allow-list, so I couldn't set that reminder.`
        if (args.type === 'once') {
          const when = new Date(args.datetime)
          if (isNaN(when.getTime())) return "⚠️ Couldn't understand that date/time for the reminder."
          addOneOff({ atISO: when.toISOString(), target: args.target, message: args.message })
          return `⏰ Scheduled for ${when.toLocaleString()}.`
        }
        if (args.type === 'daily') {
          if (!isValidTime(args.time)) return "⚠️ Couldn't understand that time for the daily reminder."
          addCronJob(sock, timezone, { name: `daily-${args.target}-${args.time}`, cron: dailyCron(args.time), target: args.target, message: args.message, type: 'daily', time: args.time })
          return `🔁 Daily reminder set for ${args.time}.`
        }
        if (args.type === 'weekly') {
          if (!args.day || DAY_NUMBERS[args.day.toLowerCase()] === undefined || !isValidTime(args.time)) {
            return "⚠️ Couldn't understand the day/time for the weekly reminder."
          }
          addCronJob(sock, timezone, { name: `weekly-${args.target}-${args.day}-${args.time}`, cron: weeklyCron(args.day, args.time), target: args.target, message: args.message, type: 'weekly', day: args.day, time: args.time })
          return `📅 Weekly reminder set for ${args.day} at ${args.time}.`
        }
        return '⚠️ Reminder type must be once, daily, or weekly.'
      }
      case 'list_reminders':
        return describeReminders()
      case 'create_poll': {
        if (!args.options || args.options.length < 2) return '⚠️ A poll needs at least 2 options.'
        await sock.sendMessage(chatId, { poll: { name: args.question, values: args.options, selectableCount: 1 } })
        return null
      }
      case 'send_message': {
        const jid = resolveTarget(args.target)
        if (!jid) return `⚠️ "${args.target}" isn't on the allow-list.`
        await safeSend(sock, jid, { text: args.message })
        return `✅ Sent to ${args.target}.`
      }
      case 'download_song': {
        const isUrl = /^https?:\/\//i.test(args.query)
        const top = isUrl ? await getVideoInfo(args.query) : (await searchYoutube(args.query, 1))[0]
        if (!top) return `😕 Couldn't find "${args.query}".`
        await safeSend(sock, chatId, { text: `⏳ Downloading audio for "${top.title}"...` })
        await sendDownloadResult(sock, chatId, () => downloadAudio(top.url), 'audio', { mimetype: 'audio/mpeg' })
        return null
      }
      case 'download_youtube_video': {
        const heightByLabel = { '360p': 360, '480p': 480, '720p': 720, '1080p': 1080 }
        const height = heightByLabel[args.quality] || 480
        const isUrl = /^https?:\/\//i.test(args.query)
        const video = isUrl ? await getVideoInfo(args.query) : (await searchYoutube(args.query, 1))[0]
        if (!video) return `😕 Couldn't find "${args.query}".`
        await safeSend(sock, chatId, { text: `⏳ Downloading "${video.title}" at ${args.quality || '480p'}...` })
        await sendDownloadResult(sock, chatId, () => downloadVideoAtQuality(video.url, height), 'video', { caption: video.title })
        return null
      }
      case 'download_social_video': {
        await safeSend(sock, chatId, { text: '⏳ Downloading...' })
        await sendDownloadResult(sock, chatId, () => downloadBest(args.url), 'video')
        return null
      }
      case 'create_group': {
        if (!args.numbers?.length) return '⚠️ Need at least one phone number to create a group.'
        const group = await createGroup(sock, args.name, args.numbers)
        return `✅ Created "${args.name}" — ${group.id}`
      }
      case 'manage_group_member': {
        try {
          await updateMembers(sock, chatId, [args.number], args.action)
          return '✅ Done.'
        } catch (err) {
          return `⚠️ ${err.message}`
        }
      }
      case 'set_group_info': {
        try {
          if (args.name) await setGroupName(sock, chatId, args.name)
          if (args.description) await setGroupDescription(sock, chatId, args.description)
          return '✅ Group updated.'
        } catch (err) {
          return `⚠️ ${err.message}`
        }
      }
      case 'set_group_lock': {
        try {
          await setLocked(sock, chatId, !!args.locked)
          return args.locked ? '🔒 Only admins can send messages now.' : '🔓 Everyone can send messages now.'
        } catch (err) {
          return `⚠️ ${err.message}`
        }
      }
      case 'get_group_invite_link': {
        try {
          return await getInviteLink(sock, chatId)
        } catch (err) {
          return `⚠️ ${err.message}`
        }
      }
      case 'leave_group': {
        try {
          await leaveGroup(sock, chatId)
          return null
        } catch (err) {
          return `⚠️ ${err.message}`
        }
      }
      case 'check_number_on_whatsapp': {
        const jid = await isOnWhatsApp(sock, args.number)
        return jid ? `✅ Yes, that number is on WhatsApp (${jid}).` : "❌ That number isn't on WhatsApp."
      }
      case 'get_contact_info': {
        const jid = resolveTarget(args.target)
        if (!jid) return `⚠️ "${args.target}" isn't on the allow-list.`
        const [pic, about] = await Promise.all([getProfilePictureUrl(sock, jid), getAboutText(sock, jid)])
        if (pic) await sendImageFromCandidates(sock, chatId, [pic], `📷 ${args.target}'s profile picture`)
        return about ? `📝 ${args.target}: ${about}` : (pic ? null : `😕 No info visible for ${args.target}.`)
      }
      case 'set_own_profile': {
        if (args.name) await setOwnName(sock, args.name)
        if (args.status) await setOwnStatus(sock, args.status)
        return '✅ Profile updated.'
      }
      case 'post_status_update': {
        await postTextStatus(sock, args.text)
        return '✅ Posted to Status.'
      }
      default:
        return null
    }
  } catch (err) {
    console.error(`AI tool "${name}" failed:`, err.message)
    return `⚠️ Something went wrong running that: ${err.message}`
  }
}

// opts.toolLevel: 'full' (owner — every tool) or 'safe' (group members —
// read-only lookups only), or omitted (plain chat, no tools). opts.sock/chatId
// are required whenever toolLevel is set, so tools can act (e.g. send a photo).
async function askAI(question, opts = {}) {
  if (!clients.length) {
    return 'AI replies aren\'t set up yet — add a free GROQ_API_KEY to .env (see README.md) and restart the bot.'
  }
  const tools = toolsForLevel(opts.toolLevel)
  const contents = await buildGroundedContents(question)
  const messages = [
    { role: 'system', content: SYSTEM_INSTRUCTION },
    { role: 'user', content: contents },
  ]

  while (currentClientIndex < clients.length) {
    const client = clients[currentClientIndex]
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await client.chat.completions.create({
          model: MODEL,
          messages,
          ...(tools ? { tools: tools.map((t) => ({ type: 'function', function: t })), tool_choice: 'auto' } : {}),
        })
        const message = response.choices[0].message
        const calls = message.tool_calls
        if (calls?.length) {
          const results = []
          for (const call of calls) {
            let args = {}
            try {
              args = JSON.parse(call.function.arguments || '{}')
            } catch { /* leave args empty if the model sent malformed JSON */ }
            const result = await runTool({ name: call.function.name, args }, { sock: opts.sock, chatId: opts.chatId })
            if (result) results.push(result)
          }
          return results.length ? results.join('\n\n') : null
        }
        return message.content || "(the AI didn't return anything)"
      } catch (err) {
        if (isQuotaExceeded(err)) {
          console.warn(`Groq key #${currentClientIndex + 1} is over quota — switching to the next one.`)
          currentClientIndex++
          break // move to the next key
        }
        const canRetry = isOverloaded(err) && attempt < RETRY_DELAYS_MS.length
        if (!canRetry) {
          console.error('Groq request failed:', err.message)
          return isOverloaded(err)
            ? '⚠️ The AI is a bit overloaded right now — try again in a moment.'
            : `⚠️ AI request failed: ${err.message}`
        }
        await sleep(RETRY_DELAYS_MS[attempt])
      }
    }
  }
  return '⚠️ All configured Groq API keys are currently over quota — try again later or add another key.'
}

module.exports = { askAI }
