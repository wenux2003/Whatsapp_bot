// "Search" comes in two tiers (see WHATSAPP_BOT_GUIDE.md §2):
//   1. Free, zero-setup: construct a direct search-page link (always works).
//   2. Optional, paid-beyond-trial: fetch a real top result via SerpApi,
//      only if SERPAPI_KEY is set in .env — otherwise callers should fall
//      back to tier 1 automatically.

const axios = require('axios')
const { serpApiKey } = require('./config')

function youtubeSearchLink(query) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
}

function googleSearchLink(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`
}

function googleImagesLink(query) {
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`
}

// Returns up to `limit` direct image URLs (best match first), or [] if no
// SERPAPI_KEY is configured (PLACEHOLDER — see .env.example) or the call fails.
// Multiple candidates let callers fall back if one host blocks the download.
async function imageSearchCandidates(query, limit = 5) {
  if (!serpApiKey) return []
  try {
    const res = await axios.get('https://serpapi.com/search.json', {
      params: { engine: 'google_images', q: query, api_key: serpApiKey },
    })
    return (res.data?.images_results || []).slice(0, limit).map((r) => r.original).filter(Boolean)
  } catch (err) {
    console.error('SerpApi image search failed:', err.message)
    return []
  }
}

// Returns a direct image URL for the top image result, or null — see above.
async function realImageSearch(query) {
  const [first] = await imageSearchCandidates(query, 1)
  return first || null
}

// Returns { link, title, thumbnail, channel } for the top YouTube result, or
// null if no SERPAPI_KEY is configured or the call fails.
async function youtubeTopVideo(query) {
  if (!serpApiKey) return null
  try {
    const res = await axios.get('https://serpapi.com/search.json', {
      params: { engine: 'youtube', search_query: query, api_key: serpApiKey },
    })
    const top = res.data?.video_results?.[0]
    if (!top?.link) return null
    return { link: top.link, title: top.title, thumbnail: top.thumbnail?.static, channel: top.channel?.name }
  } catch (err) {
    console.error('SerpApi YouTube search failed:', err.message)
    return null
  }
}

// Returns up to `limit` { title, snippet, link } organic results, or null if
// no SERPAPI_KEY is configured or the call fails.
async function googleSearchResults(query, limit = 3) {
  if (!serpApiKey) return null
  try {
    const res = await axios.get('https://serpapi.com/search.json', {
      params: { engine: 'google', q: query, api_key: serpApiKey },
    })
    const results = res.data?.organic_results?.slice(0, limit).map((r) => ({
      title: r.title,
      snippet: r.snippet,
      link: r.link,
    }))
    return results?.length ? results : null
  } catch (err) {
    console.error('SerpApi Google search failed:', err.message)
    return null
  }
}

module.exports = {
  youtubeSearchLink,
  googleSearchLink,
  googleImagesLink,
  realImageSearch,
  imageSearchCandidates,
  youtubeTopVideo,
  googleSearchResults,
}
