import { createHash } from 'node:crypto';
// A nickname is only a room-scoped hint, never a verified user identity.
export function placeholderUid(nickname, { roomCode, room } = {}) {
  return 'n' + createHash('sha256').update(`${roomCode || room || 'unknown'}\0${nickname}`).digest('hex').slice(0, 24);
}
