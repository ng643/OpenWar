import { emit, setOwner } from './world.js';
import { recount } from './buildings.js';
import { allied } from './teams.js';

/**
 * Peaceful area cession: hand every tile `playerId` owns inside `rect` to their teammate `to`.
 *
 * The rectangle is [x0, y0, x1, y1] in inclusive tile coordinates. Reversed drag corners are
 * normalised, so the caller may send the two corners in either order. It must be exactly four
 * finite integers and both corners must land inside the map, so a whole swath costs one small
 * command instead of an id per tile.
 *
 * Only the sender's own tiles change hands: neutral ground, other allies and enemy land inside the
 * rectangle are ignored. The transfer goes through the normal ownership path (setOwner with
 * capture=false), so player tallies, city ownership, the snapshot change log and the ownership
 * version all stay in sync, while cities, buildings (including unfinished deadlines) and roads
 * survive untouched. Nothing is charged or minted, and units keep their owners - only ground moves.
 * A rectangle holding none of the sender's tiles is a harmless no-op. After a non-empty transfer
 * `recount` refreshes built/active/fort metadata immediately, and a `landCeded` event with the
 * authoritative count is emitted.
 *
 * @param {object} world
 * @param {number} playerId sender, an enabled alive player id
 * @param {number} to recipient, a different enabled alive player on the sender's team
 * @param {number[]} rect [x0, y0, x1, y1], inclusive tile coordinates
 * @returns {{ok:boolean, ceded:number}} ceded = tiles whose owner changed (0 whenever ok and none)
 */
export function cedeLand(world, playerId, to, rect) {
  const players = world.players;
  if (!Number.isInteger(playerId) || playerId < 1 || playerId > players.length) return { ok: false, ceded: 0 };
  const from = players[playerId - 1];
  if (!from.enabled || !from.alive) return { ok: false, ceded: 0 };
  if (!Number.isInteger(to) || to < 1 || to > players.length) return { ok: false, ceded: 0 };
  const recipient = players[to - 1];
  if (recipient === from || recipient.id === from.id || !recipient.enabled || !recipient.alive) return { ok: false, ceded: 0 };
  if (!allied(world, from.id, recipient.id)) return { ok: false, ceded: 0 };

  const box = normalizeRect(world, rect);
  if (!box) return { ok: false, ceded: 0 };

  const pid = from.id, w = world.w;
  const owned = [];
  for (let y = box.y0; y <= box.y1; y++) {
    const row = y * w;
    for (let x = box.x0; x <= box.x1; x++) {
      const i = row + x;
      if (world.owner[i] === pid) owned.push(i);
    }
  }
  if (!owned.length) return { ok: true, ceded: 0 };

  for (const i of owned) setOwner(world, i, recipient.id, false);
  recount(world);
  // Counts only; the ownership deltas themselves (and the city owner change) travel via world.changes.
  emit(world, 'landCeded', { from: pid, to: recipient.id, tiles: owned.length });
  return { ok: true, ceded: owned.length };
}

/** Inclusive tile rectangle [x0,y0,x1,y1] with reversed corners normalised, or null if malformed. */
function normalizeRect(world, rect) {
  if (!Array.isArray(rect) || rect.length !== 4) return null;
  for (const v of rect) if (!Number.isInteger(v)) return null;
  const [ax, ay, bx, by] = rect;
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
  if (x0 < 0 || y0 < 0 || x1 >= world.w || y1 >= world.h) return null;
  return { x0, y0, x1, y1 };
}
