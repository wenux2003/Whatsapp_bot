// "Mini AI" chat replies via Google's Gemini API (free tier, no card required to start).
// PLACEHOLDER — set GEMINI_API_KEY in .env (see .env.example) to enable this.
// Until then, askAI() just tells you it's not configured instead of crashing.

const { geminiApiKey, serpApiKey } = require('./config')
const { googleSearchResults } = require('./search')

let ai = null
const MODEL = 'gemini-flash-latest' // check https://ai.google.dev/gemini-api/docs/models if this stops working
const SYSTEM_INSTRUCTION = 'You reply over WhatsApp chat. Use simple, easy English. ' +
  'When giving detailed answers or data (lists, facts, explanations), use relevant emojis ' +
  'to make it friendly and easy to scan. Keep it concise. ' +
  'Your own knowledge has a training cutoff and may be outdated, especially for recent products, ' +
  'prices, or events. If live search results are included with the question, trust those over your ' +
  'own memory and answer as of today — do not claim something "isn\'t out yet" if the search results say otherwise.'

if (geminiApiKey) {
  const { GoogleGenAI } = require('@google/genai')
  ai = new GoogleGenAI({ apiKey: geminiApiKey })
}

const RETRY_DELAYS_MS = [1000, 3000] // retry twice before giving up
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isOverloaded(err) {
  return err.message?.includes('"code":503') || err.message?.includes('UNAVAILABLE')
}

async function buildGroundedContents(question) {
  if (!serpApiKey) return question
  try {
    const results = await googleSearchResults(question, 3)
    if (!results) return question
    const context = results.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet || ''} (${r.link})`).join('\n')
    return `Today's date: ${new Date().toDateString()}.\n` +
      `Live Google search results for this question:\n${context}\n\nQuestion: ${question}`
  } catch (err) {
    console.error('AI grounding search failed:', err.message)
    return question
  }
}

async function askAI(question) {
  if (!ai) {
    return 'AI replies aren\'t set up yet — add a free GEMINI_API_KEY to .env (see README.md) and restart the bot.'
  }
  const contents = await buildGroundedContents(question)
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents,
        config: { systemInstruction: SYSTEM_INSTRUCTION },
      })
      return response.text || "(the AI didn't return anything)"
    } catch (err) {
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

module.exports = { askAI }
