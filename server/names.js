// Friendly, easy-to-say room codes: "lucky-riffle-42".

import { randomInt } from 'node:crypto';

const ADJECTIVES = `amber bold brass brisk calm cheeky clever cobalt copper coral crisp dapper dusty eager early fabled fancy fleet frosty gentle gilded golden hardy hazel humble indigo ivory jolly keen kindly lively lucky lunar marble mellow merry mighty misty nimble noble olive plucky polar proud quick quiet rapid rowdy rustic sandy scarlet shady silver sly snappy snowy steady sunny swift tidy velvet vivid wary wild witty zesty`.split(/\s+/);

const NOUNS = `ace ante bluff bridge cut dealer deck deuce diamond discard draw fan flush gambit hand heart jack joker kicker king kitty knave marker meld misdeal pair parlor pip pocket pot queen raise riffle river royal ruff runner shark shuffle spade stack stock streak suit swipe table tally ten trey trick trump wager whist wildcard`.split(/\s+/);

export function roomCode() {
  const pick = (list) => list[randomInt(list.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${String(randomInt(100)).padStart(2, '0')}`;
}

/**
 * Text that arrived from outside, as a string. Anything that is not a string
 * or a number counts as empty: String() throws on an object such as
 * {"toString":1}, and one bad message must never take the server down.
 */
export const text = (raw) => (typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '');

export function normalizeCode(raw) {
  return text(raw)
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
