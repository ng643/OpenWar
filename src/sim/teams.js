/**
 * Team relations: the one place the sim asks whether two owners are on the same side.
 *
 * Players carry a canonical numeric `team` on `world.players[id - 1].team`. Enabled players on a
 * real team share a non-zero team id; FFA worlds use each enabled player's own id as its team, so
 * `allied` there is true exactly for a player and itself. Disabled slots have team 0, and neutral
 * ground (owner 0) is never allied to anyone.
 *
 * The relation includes a player with itself: callers replace bare `ownerA === ownerB` checks with
 * `allied(world, ownerA, ownerB)` — same-owner is a same-team case — and ask for a specifically
 * other-side comparison by excluding self on their own. All source callers must use this helper
 * (never their own team comparison) so FFA and team worlds share exactly one interpretation.
 *
 * @param {object} world
 * @param {number} ownerA player id (0 = neutral)
 * @param {number} ownerB player id (0 = neutral)
 * @returns {boolean} true when both owners are enabled players on the same non-zero team
 */
export function allied(world, ownerA, ownerB) {
  const a = ownerA | 0, b = ownerB | 0;
  if (!a || !b) return false;
  const players = world.players;
  const pa = players[a - 1], pb = players[b - 1];
  if (!pa || !pb || !pa.enabled || !pb.enabled) return false;
  const ta = pa.team | 0;
  return ta !== 0 && ta === (pb.team | 0);
}
