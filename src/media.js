// Sending images/stickers pulled from the internet (a URL), never from your phone's gallery.

const axios = require('axios')
const { Sticker } = require('wa-sticker-formatter')
const { downloadContentFromMessage } = require('@whiskeysockets/baileys')
const { safeSend } = require('./safeSend')

// Some hosts (e.g. Wikimedia) block requests without a browser-like User-Agent.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
}

async function fetchImageBuffer(imageUrl) {
  const res = await axios.get(imageUrl, { responseType: 'arraybuffer', headers: BROWSER_HEADERS, timeout: 10000 })
  return Buffer.from(res.data)
}

function makeSticker(buffer) {
  return new Sticker(buffer, {
    pack: 'wenux_ai',
    author: 'Made with ❤️ by AI',
    type: 'full', // 'full' keeps the whole image; use 'crop' to force a square crop
    quality: 70,
  })
}

async function sendImageFromUrl(sock, jid, imageUrl, caption = '') {
  const buffer = await fetchImageBuffer(imageUrl)
  await safeSend(sock, jid, { image: buffer, caption })
}

async function sendStickerFromUrl(sock, jid, imageUrl) {
  const buffer = await fetchImageBuffer(imageUrl)
  const stickerMessage = await makeSticker(buffer).toMessage()
  await safeSend(sock, jid, stickerMessage)
}

// Tries each URL in order (e.g. multiple search results) until one downloads
// successfully, since some hosts block hotlinking/bots. Returns true if any worked.
async function withFirstWorkingImage(urls, handler) {
  for (const url of urls) {
    try {
      const buffer = await fetchImageBuffer(url)
      await handler(buffer)
      return true
    } catch (err) {
      console.error(`Image fetch failed (${url}):`, err.message)
    }
  }
  return false
}

async function sendImageFromCandidates(sock, jid, urls, caption = '') {
  return withFirstWorkingImage(urls, (buffer) => safeSend(sock, jid, { image: buffer, caption }))
}

async function sendStickerFromCandidates(sock, jid, urls) {
  return withFirstWorkingImage(urls, async (buffer) => {
    const stickerMessage = await makeSticker(buffer).toMessage()
    await safeSend(sock, jid, stickerMessage)
  })
}

// Reads the pack name/publisher a sticker was made with, from the EXIF
// metadata WhatsApp embeds in the .webp file. Returns null if it can't be
// read (e.g. no metadata present).
async function getStickerPackInfo(stickerMessage) {
  try {
    const stream = await downloadContentFromMessage(stickerMessage, 'sticker')
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const buffer = Buffer.concat(chunks)
    const text = buffer.toString('latin1')
    // Field order/presence varies by app — some omit "sticker-pack-id" entirely.
    const startMatch = text.match(/\{"(?:sticker-pack-id|sticker-pack-name|sticker-pack-publisher|is-from-sticker-maker)"/)
    if (!startMatch) return null
    const start = startMatch.index
    let depth = 0
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) return JSON.parse(text.slice(start, i + 1))
      }
    }
    return null
  } catch (err) {
    console.error('Sticker metadata read failed:', err.message)
    return null
  }
}

module.exports = {
  sendImageFromUrl,
  sendStickerFromUrl,
  sendImageFromCandidates,
  sendStickerFromCandidates,
  getStickerPackInfo,
}
