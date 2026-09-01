require('dotenv').config()

module.exports = {
  // PLACEHOLDER — free key, see .env.example for where to get it.
  geminiApiKey: process.env.GEMINI_API_KEY || null,
  // PLACEHOLDER — optional, paid beyond a trial credit, see .env.example.
  serpApiKey: process.env.SERPAPI_KEY || null,
  timezone: process.env.TZ || 'Asia/Colombo',
}
