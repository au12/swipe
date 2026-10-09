// All configuration comes from environment variables so the same image runs
// anywhere. Every value has a sensible default.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

const int = (name, fallback, min, max) => {
  const n = Number.parseInt(env[name] ?? '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

/** "/games/swipe/" -> "/games/swipe"; "" or "/" -> "" */
const cleanBase = (value) => {
  const trimmed = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
};

export const config = {
  root,
  host: env.HOST || '0.0.0.0',
  port: int('PORT', 3000, 1, 65535),
  siteName: (env.SITE_NAME || 'Swipe').slice(0, 40),
  basePath: cleanBase(env.BASE_PATH),
  publicDir: path.join(root, 'public'),
  dataDir: env.DATA_DIR || path.join(root, 'data'),
  persist: env.PERSIST !== 'false',
  // If set, people must enter this to create a room. Joining is never gated.
  createPassword: env.CREATE_PASSWORD || '',
  roomTtlHours: int('ROOM_TTL_HOURS', 48, 1, 24 * 90),
  maxRooms: int('MAX_ROOMS', 500, 1, 100000),
  maxPlayers: int('MAX_PLAYERS_PER_ROOM', 64, 2, 256),
  // Comma-separated list of allowed Origin headers for the WebSocket. Empty = any.
  allowedOrigins: (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean),
  // Pacing. The deal sequence is as long as the shuffle animation in the
  // browser; computer players wait about this long before each move.
  dealMs: int('DEAL_MS', 8400, 0, 20000),
  botDelayMs: int('BOT_DELAY_MS', 1000, 0, 10000),
  // Turn notifications (Web Push). The key pair lives in DATA_DIR/vapid.json.
  push: env.PUSH !== 'false',
  // Who a push service should contact about this server: a mailto: or https: address.
  // Left empty, the site's own address is used.
  pushContact: (env.PUSH_CONTACT || '').trim(),
  // Extra push-service hosts to accept besides Apple, Google, Mozilla and Microsoft.
  pushExtraHosts: (env.PUSH_EXTRA_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // Someone who looks away during their own turn is reminded after this long.
  pushRemindMs: int('PUSH_REMIND_MS', 20000, 0, 600000),
  // Messages one connection may send every five seconds before it is told to slow down.
  messageBudget: int('MESSAGE_BUDGET', 40, 5, 100000),
  logLevel: env.LOG_LEVEL || 'info',
};

export const log = {
  info: (...a) => config.logLevel !== 'silent' && console.log(new Date().toISOString(), ...a),
  warn: (...a) => config.logLevel !== 'silent' && console.warn(new Date().toISOString(), 'WARN', ...a),
  debug: (...a) => config.logLevel === 'debug' && console.log(new Date().toISOString(), 'DEBUG', ...a),
};
