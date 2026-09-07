// "Mini AI" chat replies via Google's Gemini API (free tier, no card required to start).
// PLACEHOLDER — set GEMINI_API_KEY in .env (see .env.example) to enable this.
// Until then, askAI() just tells you it's not configured instead of crashing.
//
// Gemini can also be given "tools" — /ai (and, with a safe read-only subset,
// group mentions/random replies) can trigger the bot's own song/video/search/
// image lookups and reminder scheduling from a plain-English request, and the
// reply matches exactly what the equivalent slash command would send.

const { GoogleGenAI, Type } = require('@google/genai')
const { geminiApiKeys, serpApiKey, timezone } = require('./config')
const { googleSearchResults, youtubeTopVideo, youtubeSearchLink, googleSearchLink, googleImagesLink, imageSearchCandidates } = require('./search')
const { searchTrack } = require('./spotify')
const { sendImageFromCandidates } = require('./media')
const { resolveTarget, listTargets } = require('./targets')
const { addOneOff, addCronJob, dailyCron, weeklyCron, isValidTime, DAY_NUMBERS } = require('./scheduler')

const MODEL = 'gemini-flash-latest' // check https://ai.google.dev/gemini-api/docs/models if this stops working
const SYSTEM_INSTRUCTION = 'You reply over WhatsApp chat. Use simple, easy English. ' +
  'When giving detailed answers or data (lists, facts, explanations), use relevant emojis ' +
  'to make it friendly and easy to scan. Keep it concise. ' +
  'Your own knowledge has a training cutoff and may be outdated, especially for recent products, ' +
  'prices, or events. If live search results are included with the question, trust those over your ' +
  'own memory and answer as of today — do not claim something "isn\'t out yet" if the search results say otherwise. ' +
  'If a tool is available and relevant to the request, call it rather than answering from memory — ' +
  'e.g. use get_song for song requests, set_reminder for anything about reminding/scheduling.'

// One client per key — rotated on quota errors so a single exhausted free-tier
// key doesn't take the whole bot down. See GEMINI_API_KEY in .env.example.
const clients = geminiApiKeys.map((apiKey) => new GoogleGenAI({ apiKey }))
let currentClientIndex = 0

const RETRY_DELAYS_MS = [1000, 3000] // retry twice (per key) before giving up
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isOverloaded(err) {
  return err.message?.includes('"code":503') || err.message?.includes('UNAVAILABLE')
}

function isQuotaExceeded(err) {
  return err.message?.includes('"code":429') || err.message?.includes('RESOURCE_EXHAUSTED') || err.message?.includes('quota')
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

// ---- Tools Gemini can call. See runTool() below for what each one does. ----

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

function reminderTool() {
  const { friends, groups } = listTargets()
  const names = [...friends, ...groups]
  return {
    name: 'set_reminder',
    description: 'Schedules a WhatsApp reminder message to an allow-listed friend or group — once at a specific time, or repeating daily/weekly.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: { type: Type.STRING, description: `Who to send it to. Must be exactly one of: ${names.join(', ') || '(no allow-listed names configured yet)'}` },
        type: { type: Type.STRING, description: 'One of: once, daily, weekly' },
        message: { type: Type.STRING, description: 'The reminder text to send' },
        datetime: { type: Type.STRING, description: 'Only for type=once: exact date/time as YYYY-MM-DDTHH:MM' },
        time: { type: Type.STRING, description: 'Only for type=daily or weekly: time of day as 24-hour HH:MM' },
        day: { type: Type.STRING, description: 'Only for type=weekly: day of the week, e.g. monday' },
      },
      required: ['target', 'type', 'message'],
    },
  }
}

function toolsForLevel(level) {
  if (level === 'full') return [...SAFE_TOOLS, reminderTool()]
  if (level === 'safe') return SAFE_TOOLS
  return null
}

async function runTool(call, ctx) {
  const { name, args } = call
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
        if (candidates.length && ctx.sock && ctx.chatId) {
          const sent = await sendImageFromCandidates(ctx.sock, ctx.chatId, candidates, `📷 ${args.query}`)
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
          addCronJob(ctx.sock, timezone, { name: `daily-${args.target}-${args.time}`, cron: dailyCron(args.time), target: args.target, message: args.message, type: 'daily', time: args.time })
          return `🔁 Daily reminder set for ${args.time}.`
        }
        if (args.type === 'weekly') {
          if (!args.day || DAY_NUMBERS[args.day.toLowerCase()] === undefined || !isValidTime(args.time)) {
            return "⚠️ Couldn't understand the day/time for the weekly reminder."
          }
          addCronJob(ctx.sock, timezone, { name: `weekly-${args.target}-${args.day}-${args.time}`, cron: weeklyCron(args.day, args.time), target: args.target, message: args.message, type: 'weekly', day: args.day, time: args.time })
          return `📅 Weekly reminder set for ${args.day} at ${args.time}.`
        }
        return '⚠️ Reminder type must be once, daily, or weekly.'
      }
      default:
        return null
    }
  } catch (err) {
    console.error(`AI tool "${name}" failed:`, err.message)
    return `⚠️ Something went wrong running that: ${err.message}`
  }
}

// opts.toolLevel: 'full' (owner — includes set_reminder), 'safe' (group members —
// read-only lookups only), or omitted (plain chat, no tools). opts.sock/chatId
// are required whenever toolLevel is set, so tools can act (e.g. send a photo).
async function askAI(question, opts = {}) {
  if (!clients.length) {
    return 'AI replies aren\'t set up yet — add a free GEMINI_API_KEY to .env (see README.md) and restart the bot.'
  }
  const tools = toolsForLevel(opts.toolLevel)
  const contents = await buildGroundedContents(question)

  while (currentClientIndex < clients.length) {
    const client = clients[currentClientIndex]
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await client.models.generateContent({
          model: MODEL,
          contents,
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            ...(tools ? { tools: [{ functionDeclarations: tools }] } : {}),
          },
        })
        const calls = response.functionCalls
        if (calls?.length) {
          const results = []
          for (const call of calls) {
            const result = await runTool(call, { sock: opts.sock, chatId: opts.chatId })
            if (result) results.push(result)
          }
          return results.length ? results.join('\n\n') : '✅ Done.'
        }
        return response.text || "(the AI didn't return anything)"
      } catch (err) {
        if (isQuotaExceeded(err)) {
          console.warn(`Gemini key #${currentClientIndex + 1} is over quota — switching to the next one.`)
          currentClientIndex++
          break // move to the next key
        }
        const canRetry = isOverloaded(err) && attempt < RETRY_DELAYS_MS.length
        if (!canRetry) {
          console.error('Gemini request failed:', err.message)
          return isOverloaded(err)
            ? '⚠️ The AI is a bit overloaded right now — try again in a moment.'
            : `⚠️ AI request failed: ${err.message}`
        }
        await sleep(RETRY_DELAYS_MS[attempt])
      }
    }
  }
  return '⚠️ All configured Gemini API keys are currently over quota — try again later or add another key.'
}

module.exports = { askAI }
