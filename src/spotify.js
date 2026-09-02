// Spotify track search, via the Client Credentials flow (app-only access, no
// user login needed). PLACEHOLDER — set SPOTIFY_CLIENT_ID/SECRET in .env
// (see .env.example) to enable /song — otherwise it just says so.

const axios = require('axios')
const { spotifyClientId, spotifyClientSecret } = require('./config')

let cachedToken = null
let tokenExpiresAt = 0

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken
  const basicAuth = Buffer.from(`${spotifyClientId}:${spotifyClientSecret}`).toString('base64')
  const res = await axios.post(
    'https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    { headers: { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' } },
  )
  cachedToken = res.data.access_token
  tokenExpiresAt = Date.now() + (res.data.expires_in - 60) * 1000 // refresh a minute early
  return cachedToken
}

// Returns { name, artists, link } for the top track result, or null if no
// SPOTIFY_CLIENT_ID/SECRET is configured or the call fails.
async function searchTrack(query) {
  if (!spotifyClientId || !spotifyClientSecret) return null
  try {
    const token = await getAccessToken()
    const res = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: { q: query, type: 'track', limit: 1 },
    })
    const track = res.data?.tracks?.items?.[0]
    if (!track) return null
    return { name: track.name, artists: track.artists.map((a) => a.name).join(', '), link: track.external_urls.spotify }
  } catch (err) {
    console.error('Spotify search failed:', err.message)
    return null
  }
}

module.exports = { searchTrack }
