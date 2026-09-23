require('dotenv').config()

module.exports = {
  // PLACEHOLDER — free key, see .env.example for where to get it. Comma-separated
  // for more than one — the bot rotates to the next one when a key's free-tier
  // quota runs out, instead of failing.
  groqApiKeys: (process.env.GROQ_API_KEY || '').split(',').map((s) => s.trim()).filter(Boolean),
  // PLACEHOLDER — optional, paid beyond a trial credit, see .env.example.
  serpApiKey: process.env.SERPAPI_KEY || null,
  // PLACEHOLDER — optional, free, see .env.example for where to get these.
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || null,
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || null,
  // PLACEHOLDER — optional, free trial credit then paid. Preferred TTS voice
  // for /voice and voice replies when set (better quality than Groq's), see
  // .env.example. Falls back to Groq's TTS automatically if unset/failing.
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || null,
  // PLACEHOLDER — your personal WhatsApp JID(s) (not the bot's own number), so
  // owner-only group commands work no matter which of your accounts you type
  // from. Comma-separated for more than one number. Send /whoami in a group
  // to find each one, see .env.example.
  ownerJids: (process.env.OWNER_JID || '').split(',').map((s) => s.trim()).filter(Boolean),
  timezone: process.env.TZ || 'Asia/Colombo',
}
