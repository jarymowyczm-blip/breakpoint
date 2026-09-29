/**
 * Multiplayer screens: the lobby browser and the lobby room.
 *
 * The browser is a server list with three ways in -- quick match, a join code,
 * or clicking a specific lobby -- because those cover the three real situations:
 * "I just want to play", "my friend gave me a code", and "I want that map".
 *
 * The room is host-controlled. Configuration is only rendered as interactive for
 * the host, but everyone sees the current settings, which avoids the classic
 * confusion of clicking a control that silently does nothing.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, net } from '../state/store.js';
import { LEVEL_LIST } from '../net/shared/levels.js';
import { NET } from '../net/shared/constants.js';
import { MODE_LABELS } from '../net/protocol.js';
import { Btn, Panel, Chips, Field, TextInput, Badge, TopBar, Toggle, Slider, pingLabel, pingTone } from './common.jsx';
import { DIFFICULTIES } from './ModeScreens.jsx';

const MAX_PLAYERS = NET.maxPlayersPerLobby;

/** Loading a lobby list is cheap; polling is the simplest correct approach. */
const POLL_MS = 3000;

export function PlayMenu() {
  const go = useStore((s) => s.go);
  const lobbies = useStore((s) => s.lobbies);
  const netStatus = useStore((s) => s.netStatus);
  const netError = useStore((s) => s.netError);
  const draft = useStore((s) => s.createDraft);
  const updateDraft = useStore((s) => s.updateDraft);
  const joinCode = useStore((s) => s.joinCode);
  const setJoinCode = useStore((s) => s.setJoinCode);
  const profile = useStore((s) => s.profile);
  const [filter, setFilter] = useState('all');
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    net.refreshLobbies();
    const timer = setInterval(() => net.refreshLobbies(), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const visible = useMemo(
    () => lobbies.filter((l) => (filter === 'all' ? true : l.mode === filter)),
    [lobbies, filter],
  );

  const mapsForMode = (mode) => LEVEL_LIST.filter((l) => l.modes.includes(mode));

  const create = () => {
    net.createLobby({
      name: draft.name || `${profile?.name || 'Operator'}'s match`,
      mode: draft.mode,
      mapId: draft.mapId,
      maxPlayers: draft.maxPlayers,
      botFill: draft.botFill,
      difficulty: draft.difficulty,
      isPrivate: draft.isPrivate,
    });
  };

  const quickMatch = (mode) => net.quickJoin(mode);

  return (
    <div className="screen">
      <TopBar title="Play" onBack={() => go('menu')}>
        <Badge tone={netStatus === 'online' ? 'good' : 'bad'}>
          <span className={`dot ${netStatus === 'online' ? '' : 'bad'}`} />
          {netStatus}
        </Badge>
      </TopBar>

      {netError && (
        <div className="panel mt-8" style={{ borderColor: '#6b2f2a', background: '#1b100f' }}>
          <span className="text-bad">{netError}</span>
        </div>
      )}

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Panel title="Jump in" subtitle="Quick match drops you into the fullest open server">
          <div className="row wrap">
            {Object.entries(MODE_LABELS).map(([mode, label]) => (
              <Btn key={mode} variant="primary" onClick={() => quickMatch(mode)} disabled={netStatus !== 'online'}>
                {label}
              </Btn>
            ))}
          </div>

          <div className="divider" />

          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <TextInput
                label="Join with a code"
                placeholder="ABCDE"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                maxLength={5}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && joinCode.length === 5) net.joinLobby({ code: joinCode });
                }}
                hint="Five characters, readable over voice chat."
              />
            </div>
            <Btn
              onClick={() => net.joinLobby({ code: joinCode })}
              disabled={joinCode.length !== 5 || netStatus !== 'online'}
            >
              Join
            </Btn>
          </div>

          <div className="divider" />

          <Btn variant={showCreate ? '' : 'primary'} block onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? 'Cancel' : 'Create a lobby'}
          </Btn>

          {showCreate && (
            <div className="stack fade-in mt-16">
              <TextInput
                label="Lobby name"
                placeholder="Sunday night breach"
                value={draft.name}
                onChange={(e) => updateDraft({ name: e.target.value })}
                maxLength={28}
              />

              <Field label="Mode">
                <Chips
                  options={Object.entries(MODE_LABELS).map(([value, label]) => ({ value, label }))}
                  value={draft.mode}
                  onChange={(mode) => {
                    // A map that does not support the mode would be unplayable,
                    // so the map follows the mode automatically.
                    const maps = mapsForMode(mode);
                    const mapId = maps.some((m) => m.id === draft.mapId) ? draft.mapId : maps[0]?.id;
                    updateDraft({ mode, mapId });
                  }}
                />
              </Field>

              <Field label="Map">
                <Chips
                  options={mapsForMode(draft.mode).map((m) => ({ value: m.id, label: m.name, title: m.subtitle }))}
                  value={draft.mapId}
                  onChange={(mapId) => updateDraft({ mapId })}
                />
              </Field>

              <Slider
                label="Bots filling empty slots"
                min={0}
                max={MAX_PLAYERS - 1}
                value={draft.botFill}
                onChange={(botFill) => updateDraft({ botFill })}
                format={(v) => `${v}`}
                hint="Bots keep a small match full and are replaced by players as they join."
              />

              <Field label="Bot difficulty">
                <Chips options={DIFFICULTIES} value={draft.difficulty} onChange={(difficulty) => updateDraft({ difficulty })} />
              </Field>

              <Slider
                label="Maximum players"
                min={2}
                max={MAX_PLAYERS}
                value={draft.maxPlayers}
                onChange={(maxPlayers) => updateDraft({ maxPlayers })}
              />

              <Toggle
                label="Private lobby"
                checked={draft.isPrivate}
                onChange={(isPrivate) => updateDraft({ isPrivate })}
                hint="Hidden from the browser; joinable by code only."
              />

              <Btn variant="primary" block onClick={create} disabled={netStatus !== 'online'}>
                Create lobby
              </Btn>
            </div>
          )}
        </Panel>

        <Panel
          title="Server browser"
          subtitle={`${visible.length} open`}
          actions={
            <>
              <Chips
                options={[{ value: 'all', label: 'All' }, ...Object.entries(MODE_LABELS).map(([value, label]) => ({ value, label }))]}
                value={filter}
                onChange={setFilter}
              />
              <Btn size="tiny" variant="ghost" onClick={() => net.refreshLobbies()}>
                Refresh
              </Btn>
            </>
          }
        >
          {visible.length === 0 ? (
            <div className="text-faint mono-small">
              No open lobbies right now. Create one, or use quick match to start a fresh server with bots.
            </div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {visible.map((lobby) => (
                <div key={lobby.id} className="lobby-card">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {lobby.name}
                      </span>
                      {lobby.status !== 'open' && <Badge tone="accent">in progress</Badge>}
                    </div>
                    <div className="meta">
                      <span>{lobby.modeLabel}</span>
                      <span>·</span>
                      <span>{lobby.mapName}</span>
                      <span>·</span>
                      <span>host {lobby.hostName}</span>
                      {lobby.bots > 0 && (
                        <>
                          <span>·</span>
                          <span>+{lobby.bots} bots</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <Badge tone={pingTone(lobby.avgPing)}>{pingLabel(lobby.avgPing)}</Badge>
                    <Badge>
                      {lobby.players}/{lobby.maxPlayers}
                    </Badge>
                    <Btn
                      size="tiny"
                      variant="primary"
                      disabled={netStatus !== 'online' || lobby.status === 'playing' || lobby.players >= lobby.maxPlayers}
                      onClick={() => net.joinLobby({ lobbyId: lobby.id })}
                    >
                      Join
                    </Btn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

export function LobbyRoom() {
  const go = useStore((s) => s.go);
  const lobby = useStore((s) => s.lobby);
  const profile = useStore((s) => s.profile);
  const netMatch = useStore((s) => s.netMatch);
  const chatMessages = useStore((s) => s.chatMessages);
  const [message, setMessage] = useState('');
  const chatRef = useRef(null);

  const isHost = lobby && profile && lobby.hostId === profile.id;
  const me = lobby?.roster?.find((r) => r.id === profile?.id);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [chatMessages.length]);

  // The server starts the match and sends MATCH_START; the game view takes over
  // from here. Doing this in an effect keeps the navigation out of render.
  useEffect(() => {
    if (netMatch) {
      useStore.getState().launchMatch({ mode: netMatch.mode, levelId: netMatch.levelId, online: true, match: netMatch });
    }
  }, [netMatch]);

  if (!lobby) {
    return (
      <div className="screen">
        <TopBar title="Lobby" onBack={() => go('play')} />
        <Panel>Left the lobby.</Panel>
      </div>
    );
  }

  const mapsForMode = LEVEL_LIST.filter((l) => l.modes.includes(lobby.mode));

  const teamCount = (team) => (lobby.roster || []).filter((r) => r.team === team).length;

  return (
    <div className="screen">
      <TopBar title="Lobby" onBack={() => net.leaveLobby()}>
        <Badge tone="accent">{lobby.code}</Badge>
        <Badge>
          {lobby.players}/{lobby.maxPlayers}
        </Badge>
        {netMatch && <Badge tone="good">starting…</Badge>}
      </TopBar>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          <Panel title={lobby.name} subtitle={`${lobby.modeLabel} · ${lobby.mapName}`}>
            <div className="row wrap" style={{ gap: 8 }}>
              <Badge>host {lobby.roster.find((r) => r.isHost)?.name || '—'}</Badge>
              {lobby.bots > 0 && <Badge>{lobby.bots} bots</Badge>}
              <Badge>{lobby.difficulty}</Badge>
              {lobby.isPrivate && <Badge tone="accent">private</Badge>}
            </div>

            <div className="divider" />

            <div className="roster-row" style={{ borderBottom: '1px solid var(--line)', color: 'var(--text-faint)' }}>
              <span className="num">#</span>
              <span className="hud-label">player</span>
              <span className="hud-label">team</span>
              <span className="hud-label">ping</span>
            </div>
            {(lobby.roster || []).map((player, index) => (
              <div key={player.id} className={`roster-row ${player.id === profile?.id ? 'me' : ''}`}>
                <span className="num">{index + 1}</span>
                <span>
                  {player.name}
                  {player.isHost && <span className="text-faint mono-small"> · host</span>}
                  {player.id === profile?.id && <span className="text-accent mono-small"> · you</span>}
                </span>
                <span className={`badge ${player.team === 'a' ? 'team-a' : 'team-b'}`}>
                  {lobby.mode === 'ffa' ? 'solo' : String(player.team || '?').toUpperCase()}
                </span>
                <span className="mono-small text-faint">{player.ping ? `${Math.round(player.ping)} ms` : '—'}</span>
              </div>
            ))}

            <div className="row between mt-16">
              {lobby.mode !== 'ffa' ? (
                <div className="row" style={{ gap: 8 }}>
                  <span className="hud-label">your team</span>
                  <Chips
                    options={[
                      { value: 'a', label: `A (${teamCount('a')})` },
                      { value: 'b', label: `B (${teamCount('b')})` },
                    ]}
                    value={me?.team}
                    onChange={(team) => net.setTeam(team)}
                  />
                </div>
              ) : (
                <span className="hud-label">free for all</span>
              )}

              <Toggle
                label={netMatch ? 'Match starting' : 'Ready'}
                checked={!!me?.ready || isHost}
                onChange={(v) => net.setReady(v)}
              />
            </div>

            <div className="divider" />

            <div className="row" style={{ gap: 10 }}>
              {isHost ? (
                <Btn variant="primary" size="large" onClick={() => net.startMatch()} disabled={!!netMatch}>
                  Start match
                </Btn>
              ) : (
                <span className="mono-small text-faint">Waiting for the host to start the match…</span>
              )}
              <Btn variant="danger" onClick={() => net.leaveLobby()}>
                Leave
              </Btn>
            </div>
          </Panel>

          <Panel title="Chat">
            <div className="chat-log" ref={chatRef}>
              {chatMessages.length === 0 && <span className="sys">Say hello. Everything here is relayed to the lobby.</span>}
              {chatMessages.map((entry, i) => (
                <div key={`${entry.at}-${i}`}>
                  <span className="from">{entry.from}</span>
                  <span className="text-faint">: </span>
                  <span>{entry.text}</span>
                </div>
              ))}
            </div>
            <div className="row mt-8">
              <input
                type="text"
                placeholder="Message the lobby…"
                value={message}
                maxLength={160}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || !message.trim()) return;
                  net.say(message.trim());
                  setMessage('');
                }}
              />
              <Btn
                onClick={() => {
                  if (!message.trim()) return;
                  net.say(message.trim());
                  setMessage('');
                }}
              >
                Send
              </Btn>
            </div>
          </Panel>
        </div>

        <Panel
          title="Match settings"
          subtitle={isHost ? 'You are the host' : 'Only the host can change these'}
        >
          <div className="stack">
            <Field label="Mode">
              <Chips
                options={Object.entries(MODE_LABELS).map(([value, label]) => ({ value, label }))}
                value={lobby.mode}
                disabled={!isHost}
                onChange={(mode) => {
                  const maps = LEVEL_LIST.filter((l) => l.modes.includes(mode));
                  const mapId = maps.some((m) => m.id === lobby.mapId) ? lobby.mapId : maps[0]?.id;
                  net.configureLobby({ mode, mapId });
                }}
              />
            </Field>

            <Field label="Map">
              <Chips
                options={mapsForMode.map((m) => ({ value: m.id, label: m.name, title: m.subtitle }))}
                value={lobby.mapId}
                disabled={!isHost}
                onChange={(mapId) => net.configureLobby({ mapId })}
              />
            </Field>

            <Field label="Recommended size" hint={`${lobby.modeLabel} plays best with ${recommended(lobby)}`}>
              <div className="mono-small text-faint">
                {LEVEL_LIST.find((l) => l.id === lobby.mapId)?.subtitle || ''}
              </div>
            </Field>

            <Slider
              label="Bots"
              min={0}
              max={MAX_PLAYERS - 1}
              value={lobby.bots}
              onChange={(bots) => isHost && net.configureLobby({ botFill: bots })}
              hint={isHost ? 'Bots occupy slots until players take them.' : 'Only the host can change this.'}
            />

            <Field label="Bot difficulty">
              <Chips
                options={DIFFICULTIES}
                value={lobby.difficulty}
                disabled={!isHost}
                onChange={(difficulty) => net.configureLobby({ difficulty })}
              />
            </Field>

            {lobby.mode !== 'ffa' && (
              <div className="mono-small text-faint">
                Teams are kept within one player of each other, so nobody can stack a side.
              </div>
            )}

            <div className="divider" />

            <div className="mono-small text-faint">
              The server simulates the match at 30 Hz and sends 20 snapshots a second. Your client predicts
              its own movement and interpolates everyone else, and shots are rewound to the moment you
              pulled the trigger.
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function recommended(lobby) {
  const level = LEVEL_LIST.find((l) => l.id === lobby.mapId);
  const range = level?.recommended?.[lobby.mode];
  if (!range) return '4–8 players';
  return `${range[0]}–${range[1]} players`;
}


