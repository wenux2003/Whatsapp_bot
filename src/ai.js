// "Mini AI" chat replies via Google's Gemini API (free tier, no card required to start).
// PLACEHOLDER — set GEMINI_API_KEY in .env (see .env.example) to enable this.
// Until then, askAI() just tells you it's not configured instead of crashing.

const { geminiApiKey } = require('./config')

let ai = null
const MODEL = 'gemini-flash-latest' // check https://ai.google.dev/gemini-api/docs/models if this stops working

if (geminiApiKey) {
  const { GoogleGenAI } = require('@google/genai')
  ai = new GoogleGenAI({ apiKey: geminiApiKey })
}

async function askAI(question) {
  if (!ai) {
    return 'AI replies aren\'t set up yet — add a free GEMINI_API_KEY to .env (see README.md) and restart the bot.'
  }
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: question,
    })
    return response.text || "(the AI didn't return anything)"
  } catch (err) {
    console.error('Gemini request failed:', err.message)
    return `⚠️ AI request failed: ${err.message}`
  }
}

module.exports = { askAI }
