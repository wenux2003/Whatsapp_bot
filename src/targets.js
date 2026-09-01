// The allow-list: the ONLY chats the bot is allowed to send into.
// See README.md for how to populate targets.json with real numbers/group IDs.

const fs = require('fs')
const path = require('path')

const TARGETS_PATH = path.join(__dirname, '..', 'targets.json')

function loadTargets() {
  const raw = fs.readFileSync(TARGETS_PATH, 'utf-8')
  const data = JSON.parse(raw)
  return {
    friends: data.friends || {},
    groups: data.groups || {},
  }
}

// Resolve a friendly name (from targets.json) to a WhatsApp JID.
// Returns null if the name isn't on the allow-list — callers MUST treat
// null as "refuse to send," never fall back to guessing a JID.
function resolveTarget(name) {
  if (!name) return null
  const targets = loadTargets()
  return targets.friends[name] || targets.groups[name] || null
}

function listTargets() {
  const targets = loadTargets()
  return {
    friends: Object.keys(targets.friends),
    groups: Object.keys(targets.groups),
  }
}

module.exports = { loadTargets, resolveTarget, listTargets }
