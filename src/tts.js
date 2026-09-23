// Text-to-speech, two tiers:
//   - textToSpeech()   — Groq only. Used for automatic voice replies (see
//                        sendAIAnswer in commands.js), which fire often, so
//                        they stay on the free provider.
//   - textToSpeechHQ() — prefers ElevenLabs (better quality) when
//                        ELEVENLABS_API_KEY is set, falling back to Groq.
//                        Used for the explicit /voice command only, since
//                        that's a deliberate one-off action.
// Off/unconfigured just means callers get null back — never throws.

const axios = require('axios')
const Groq = require('groq-sdk')
const { execFile } = require('child_process')
const { promisify } = require('util')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const ffmpegPath = require('ffmpeg-static')
const { groqApiKeys, elevenLabsApiKey } = require('./config')

const execFileAsync = promisify(execFile)

const ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM' // "Rachel" — a default ElevenLabs voice
// playai-tts was decommissioned by Groq — canopylabs/orpheus-v1-english is its
// replacement. Requires one-time terms acceptance at:
// https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english
const GROQ_TTS_MODEL = 'canopylabs/orpheus-v1-english' // check https://console.groq.com/docs/text-to-speech if this changes again
const GROQ_VOICE = 'autumn' // valid voices for this model: autumn, diana, hannah, austin, daniel, troy
const MAX_INPUT_CHARS = 2000 // keep replies well under either provider's input limit

const groqClients = groqApiKeys.map((apiKey) => new Groq({ apiKey }))

// WhatsApp only renders the proper mic-style "voice note" bubble for OGG/Opus
// audio — re-encode whatever a provider hands back into that format.
async function convertToOggOpus(buffer) {
  const id = crypto.randomBytes(8).toString('hex')
  const inputFile = path.join(os.tmpdir(), `${id}.in`)
  const outputFile = path.join(os.tmpdir(), `${id}.ogg`)
  fs.writeFileSync(inputFile, buffer)
  try {
    await execFileAsync(ffmpegPath, ['-i', inputFile, '-c:a', 'libopus', '-b:a', '64k', outputFile])
    return fs.readFileSync(outputFile)
  } finally {
    try { fs.unlinkSync(inputFile) } catch { /* already gone */ }
    try { fs.unlinkSync(outputFile) } catch { /* already gone, or conversion failed */ }
  }
}

async function elevenLabsSpeech(text) {
  if (!elevenLabsApiKey) return null
  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      { text: text.slice(0, MAX_INPUT_CHARS), model_id: 'eleven_multilingual_v2' },
      { headers: { 'xi-api-key': elevenLabsApiKey, 'Content-Type': 'application/json' }, responseType: 'arraybuffer' }
    )
    const ogg = await convertToOggOpus(Buffer.from(res.data))
    return { buffer: ogg, mimetype: 'audio/ogg; codecs=opus' }
  } catch (err) {
    const detail = err.response?.data ? Buffer.from(err.response.data).toString() : err.message
    console.error('ElevenLabs TTS failed (falling back to Groq if configured):', detail)
    return null
  }
}

async function groqSpeech(text) {
  const input = text.slice(0, MAX_INPUT_CHARS)
  for (const client of groqClients) {
    try {
      // Orpheus only supports wav output — convert to ogg/opus for a proper
      // WhatsApp voice-note bubble, same as the ElevenLabs path.
      const response = await client.audio.speech.create({ input, model: GROQ_TTS_MODEL, voice: GROQ_VOICE, response_format: 'wav' })
      const ogg = await convertToOggOpus(Buffer.from(await response.arrayBuffer()))
      return { buffer: ogg, mimetype: 'audio/ogg; codecs=opus' }
    } catch (err) {
      console.error('Groq TTS failed (trying next key if any):', err.message)
    }
  }
  return null
}

// Returns { buffer, mimetype } ready to send as a WhatsApp voice note (ptt),
// or null if no provider is configured/working.
async function textToSpeech(text) {
  return groqSpeech(text)
}

async function textToSpeechHQ(text) {
  return (await elevenLabsSpeech(text)) || (await groqSpeech(text))
}

module.exports = { textToSpeech, textToSpeechHQ }
