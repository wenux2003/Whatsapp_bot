// Sending images/stickers pulled from the internet (a URL), never from your phone's gallery.

const axios = require('axios')
const { Sticker } = require('wa-sticker-formatter')
const { safeSend } = require('./safeSend')

async function sendImageFromUrl(sock, jid, imageUrl, caption = '') {
  const res = await axios.get(imageUrl, { responseType: 'arraybuffer' })
  await safeSend(sock, jid, { image: Buffer.from(res.data), caption })
}

async function sendStickerFromUrl(sock, jid, imageUrl) {
  const sticker = new Sticker(imageUrl, {
    pack: 'Wenura Bot',
    author: 'Wenura',
    type: 'full', // 'full' keeps the whole image; use 'crop' to force a square crop
    quality: 70,
  })
  const stickerMessage = await sticker.toMessage()
  await safeSend(sock, jid, stickerMessage)
}

module.exports = { sendImageFromUrl, sendStickerFromUrl }
