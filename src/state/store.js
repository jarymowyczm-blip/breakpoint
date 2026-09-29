/**
 * Application state.
 *
 * Two kinds of state live here and they are deliberately kept apart:
 *
 *   - durable user state (settings, identity), persisted to localStorage
 *   - ephemeral app state (which screen is open, the mirrored network state)
 *
 * The `NetClient` itself is a module-level singleton rather than store state.
 * Putting a live socket in a React store invites it being recreated on every
 * render, and the connection must outlive any single component.
 */

import { create } from 'zustand';
import { NetClient } from '../net/NetClient.js';

export const net = new NetClient();

const SETTINGS_KEY = 'breachpoint.settings';

export const DEFAULT_SETTINGS = {
  // Controls
  sensitivity: 1,
  invertY: false,
  fov: 88,
  scopeSensitivity: 0.75,
  // Graphics
  quality: 'high',
  shadows: true,
  bloom: true,
  ambientOcclusion: true,
  renderScale: 1,
  shadowQuality: 2048,
  // Audio
  masterVolume: 0.75,
  sfxVolume: 1,
  // HUD
  showMinimap: true,
  showNameplates: true,
  showFps: true,
  // Practice defaults
  practiceBots: 4,
  practiceDifficulty: 'regular',
  practiceDistance: 15,
  infiniteAmmo: true,
  // Campaign
  difficulty: 'regular',
};

/** Quality presets so a slow machine is one click away from playable. */
export const QUALITY_PRESETS = {
  low: { shadows: false, bloom: false, ambientOcclusion: false, renderScale: 0.72, shadowQuality: 1024 },
  medium: { shadows: true, bloom: true, ambientOcclusion: false, renderScale: 0.85, shadowQuality: 1024 },
  high: { shadows: true, bloom: true, ambientOcclusion: true, renderScale: 1, shadowQuality: 2048 },
  ultra: { shadows: true, bloom: true, ambientOcclusion: true, renderScale: 1, shadowQuality: 4096 },
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persistSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage disabled: settings simply do not persist */
  }
}

export const useStore = create((set, get) => ({
  // ---------------------------------------------------------------- routing
  screen: 'menu',
  /** Set while a match is running; drives the game view. */
  gameConfig: null,
  gameKey: 0,

  go(screen) {
    set({ screen });
  },

  launchMatch(config) {
    set({ screen: 'game', gameConfig: config, gameKey: get().gameKey + 1 });
  },

  // --------------------------------------------------------------- settings
  settings: loadSettings(),

  updateSettings(patch) {
    const settings = { ...get().settings, ...patch };
    persistSettings(settings);
    set({ settings });
  },

  applyQualityPreset(name) {
    const preset = QUALITY_PRESETS[name];
    if (!preset) return;
    get().updateSettings({ quality: name, ...preset });
  },

  resetSettings() {
    persistSettings(DEFAULT_SETTINGS);
    set({ settings: { ...DEFAULT_SETTINGS } });
  },

  // ------------------------------------------------------------------ lobby
  lobbyStatusFilter: 'all',
  setLobbyFilter(mode) {
    set({ lobbyStatusFilter: mode });
  },

  joinCode: '',
  setJoinCode(code) {
    set({ joinCode: code.toUpperCase().slice(0, 5) });
  },

  createDraft: {
    name: '',
    mode: 'tdm',
    mapId: 'foundry',
    maxPlayers: 16,
    botFill: 6,
    difficulty: 'regular',
    isPrivate: false,
  },

  updateDraft(patch) {
    set({ createDraft: { ...get().createDraft, ...patch } });
  },

  // ------------------------------------------------------------------- match
  hud: null,
  setHud(hud) {
    set({ hud });
  },

  scoreboardVisible: false,
  setScoreboardVisible(visible) {
    set({ scoreboardVisible: visible });
  },

  matchResult: null,
  setMatchResult(result) {
    set({ matchResult: result });
  },

  paused: false,
  setPaused(paused) {
    set({ paused });
  },

  /** Bumped to force the game view to remount after a network match starts. */
  matchStartedAt: 0,
}));

/**
 * Mirror the network client's observable state into the store so components can
 * read it declaratively. Subscribing once here keeps every screen free of
 * manual socket plumbing.
 */
let lastLobbyId = null;
net.subscribe((state) => {
  const patch = {
    netStatus: state.status,
    netError: state.error,
    profile: state.profile,
    lobbies: state.lobbies,
    lobby: state.lobby,
    chatMessages: state.chat,
    ping: state.ping,
    netMatch: state.match,
    stats: state.stats,
    netMetrics: { bytesIn: state.bytesIn, bytesOut: state.bytesOut, interpDelay: state.interpDelay },
  };

  // Joining a lobby should move the UI, but only on an actual transition --
  // otherwise a re-render storm would fight the user's navigation.
  if (state.lobby && state.lobby.id !== lastLobbyId) {
    lastLobbyId = state.lobby.id;
    patch.screen = 'lobby';
  }
  if (!state.lobby) lastLobbyId = null;

  useStore.setState(patch);
});

export { NetClient };
