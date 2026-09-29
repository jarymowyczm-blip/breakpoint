import foundry from './maps/foundry.js';
import range from './maps/range.js';
import compound from './maps/compound.js';

/**
 * Level registry. Adding a map means dropping a module in `maps/` and listing
 * it here -- the client renders it, the server collides with it and the AI
 * navigates it with no further wiring.
 */
export const LEVELS = { foundry, range, compound };

export const LEVEL_LIST = [foundry, range, compound].map((l) => ({
  id: l.id,
  name: l.name,
  subtitle: l.subtitle,
  modes: l.modes,
  recommended: l.recommended,
  spawnPoints: Object.keys(l.spawns),
}));

export function getLevel(id) {
  return LEVELS[id] || foundry;
}

/** Levels that support a given game mode. */
export function levelsForMode(mode) {
  return LEVEL_LIST.filter((l) => l.modes.includes(mode));
}
