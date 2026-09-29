/**
 * Main menu.
 *
 * The landing screen. It doubles as the operator card: identity, lifetime stats
 * and connection state all live here, because a browser game has no launcher and
 * this is the only place a returning player naturally looks for them.
 */

import React, { useEffect, useState } from 'react';
import { useStore, net } from '../state/store.js';
import { GameClient } from '../game/GameClient.js';
import { Btn, Panel, Stat, TextInput, Badge, pingLabel, pingTone } from './common.jsx';

const NAV = [
  {
    id: 'play',
    label: 'Play Online',
    hint: 'Team deathmatch and free for all against real players, with bots filling the empty slots',
  },
  {
    id: 'campaign',
    label: 'Campaign',
    hint: 'Single-player mission with objectives, enemy waves and a save system',
  },
  {
    id: 'practice',
    label: 'Practice Range',
    hint: 'Targets, a movement course and adjustable difficulty bots',
  },
  {
    id: 'settings',
    label: 'Settings',
    hint: 'Controls, graphics and audio',
  },
];

const CONTROLS_HELP = [
  ['WASD', 'move'],
  ['Shift', 'sprint'],
  ['Ctrl', 'crouch'],
  ['Space', 'jump'],
  ['LMB', 'fire'],
  ['RMB', 'aim down sights'],
  ['R', 'reload'],
  ['1 / 2 / Q', 'weapons'],
  ['Tab', 'scoreboard'],
  ['M', 'map'],
  ['Esc', 'pause'],
];

export default function MainMenu() {
  const go = useStore((s) => s.go);
  const profile = useStore((s) => s.profile);
  const stats = useStore((s) => s.stats);
  const netStatus = useStore((s) => s.netStatus);
  const netError = useStore((s) => s.netError);
  const ping = useStore((s) => s.ping);
  const lobbies = useStore((s) => s.lobbies);
  const setState = useStore.setState;

  const [name, setName] = useState(profile?.name || '');
  const [editing, setEditing] = useState(false);
  const [hovered, setHovered] = useState('play');
  const [save, setSave] = useState(() => GameClient.loadCampaignSave());

  useEffect(() => {
    if (profile?.name && !editing) setName(profile.name);
  }, [profile?.name, editing]);

  const status = netStatus === 'online' ? 'online' : netStatus === 'connecting' ? 'connecting' : 'offline';

  const commitName = () => {
    const trimmed = name.trim();
    setEditing(false);
    if (trimmed && trimmed !== profile?.name) net.setName(trimmed);
    else setName(profile?.name || '');
  };

  const clearSave = () => {
    GameClient.clearCampaignSave();
    setSave(null);
  };

  return (
    <div className="screen">
      <div className="topbar">
        <div className="brand">
          <h1>BREACHPOINT</h1>
          <span>browser tactical shooter</span>
        </div>
        <div className="row">
          <Badge tone={status === 'online' ? 'good' : status === 'connecting' ? '' : 'bad'}>
            <span className={`dot ${status === 'online' ? '' : status === 'connecting' ? 'warn' : 'bad'}`} />
            {status}
          </Badge>
          {ping > 0 && <Badge tone={pingTone(ping)}>{pingLabel(ping)}</Badge>}
          <Badge>{lobbies.length} lobby{lobbies.length === 1 ? '' : 'ies'}</Badge>
        </div>
      </div>

      {netError && (
        <div className="panel fade-in mt-8" style={{ borderColor: '#6b2f2a', background: '#1b100f' }}>
          <div className="row between">
            <span className="text-bad">{netError}</span>
            <Btn size="tiny" variant="ghost" onClick={() => setState({ netError: null })}>
              Dismiss
            </Btn>
          </div>
        </div>
      )}

      <div className="grid cols-2" style={{ marginTop: 16, alignItems: 'start' }}>
        <Panel title="Deploy" subtitle="Choose a mode">
          <div className="stack">
            {NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                className="lobby-card"
                style={{ textAlign: 'left', cursor: 'pointer' }}
                onClick={() => go(item.id)}
                onMouseEnter={() => setHovered(item.id)}
              >
                <div style={{ minWidth: 132 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                    {item.label}
                  </div>
                </div>
                <div className="text-faint mono-small" style={{ flex: 1 }}>
                  {item.hint}
                </div>
                <span className="text-accent">→</span>
              </button>
            ))}
          </div>

          <div className="divider" />

          <div className="hud-label" style={{ marginBottom: 10 }}>
            {hovered === 'play' ? 'Multiplayer' : 'Controls'}
          </div>

          {hovered === 'play' ? (
            <p className="mono-small text-dim" style={{ margin: 0 }}>
              Create a lobby and pick your map and mode, join with a five-character code, or hit quick
              match to drop into the fullest server. Bots fill any empty slots, so a match always starts
              at full strength.
            </p>
          ) : (
            <div className="grid cols-3" style={{ gap: 8 }}>
              {CONTROLS_HELP.map(([key, action]) => (
                <div key={key} className="row" style={{ gap: 8 }}>
                  <span className="keycap">{key}</span>
                  <span className="mono-small text-faint">{action}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <div className="stack">
          <Panel
            title="Operator"
            actions={
              editing ? (
                <Btn size="tiny" variant="primary" onClick={commitName}>
                  Save
                </Btn>
              ) : (
                <Btn size="tiny" variant="ghost" onClick={() => setEditing(true)} disabled={!profile}>
                  Rename
                </Btn>
              )
            }
          >
            {editing ? (
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitName();
                  if (e.key === 'Escape') {
                    setEditing(false);
                    setName(profile?.name || '');
                  }
                }}
                maxLength={18}
                hint="Shown in the kill feed and on the scoreboard. Press Enter to save."
                autoFocus
              />
            ) : (
              <div className="row between" style={{ marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{profile?.name || 'Connecting…'}</div>
                  <div className="panel-sub">
                    {profile ? (profile.guest ? 'Guest session — progress is kept on this device' : 'Registered account') : 'Waiting for the server'}
                  </div>
                </div>
                <div className="center">
                  <div className="hud-number" style={{ fontSize: 22 }}>
                    {stats?.wins ?? 0}
                  </div>
                  <div className="hud-label">wins</div>
                </div>
              </div>
            )}

            <div className="divider" />

            <div className="stat-grid">
              <Stat label="Kills" value={stats?.kills ?? 0} />
              <Stat label="Deaths" value={stats?.deaths ?? 0} />
              <Stat label="K/D" value={ratio(stats?.kills, stats?.deaths)} />
              <Stat label="Headshots" value={stats?.headshots ?? 0} />
              <Stat label="Matches" value={stats?.matches ?? 0} />
              <Stat label="Accuracy" value={accuracy(stats)} />
            </div>
          </Panel>

          <Panel title="Campaign checkpoint">
            {save ? (
              <div className="row between">
                <div>
                  <div style={{ fontSize: 14 }}>Coldstore Compound</div>
                  <div className="mono-small text-faint">
                    Phase {save.phase ?? 0} · {save.cleared ?? 0} cleared · saved{' '}
                    {save.savedAt ? new Date(save.savedAt).toLocaleString() : 'unknown'}
                  </div>
                </div>
                <Btn size="tiny" variant="danger" onClick={clearSave}>
                  Clear
                </Btn>
              </div>
            ) : (
              <div className="mono-small text-faint">
                No checkpoint yet. Campaign progress saves automatically at every objective.
              </div>
            )}
          </Panel>
        </div>
      </div>

      <footer className="row between mt-24" style={{ paddingBottom: 24 }}>
        <span className="mono-small text-faint">React · Three.js · WebGL · WebSocket · authoritative server</span>
        <span className="mono-small text-faint">v1.0.0</span>
      </footer>
    </div>
  );
}

function ratio(kills = 0, deaths = 0) {
  if (!deaths) return kills ? kills.toFixed(2) : '—';
  return (kills / deaths).toFixed(2);
}

function accuracy(stats) {
  if (!stats || !stats.shots_fired) return '—';
  return `${Math.round((stats.shots_hit / stats.shots_fired) * 100)}%`;
}
