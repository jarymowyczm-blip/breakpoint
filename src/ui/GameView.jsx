/**
 * In-game view.
 *
 * Owns three stacked canvases: the WebGL world, a 2D overlay for the crosshair
 * and other pixel-precise feedback, and the minimap. The React tree here renders
 * only the panels that change slowly (health, ammo, feed, scoreboard) -- the
 * per-frame work happens inside the canvases, which is what keeps a 200 km/h
 * firefight from re-rendering the component tree sixty times a second.
 *
 * Pointer lock is the gate for "playing": losing it pauses, which is both what
 * players expect from a browser game and what stops the mouse escaping the
 * window mid-fight.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, net } from '../state/store.js';
import { GameClient } from '../game/GameClient.js';
import { WEAPONS } from '../net/shared/weapons.js';
import { Btn, Badge, Chips, Slider, Toggle, pingLabel, pingTone } from './common.jsx';

export default function GameView() {
  const config = useStore((s) => s.gameConfig);
  const gameKey = useStore((s) => s.gameKey);
  const settings = useStore((s) => s.settings);
  const hud = useStore((s) => s.hud);
  const updateSettings = useStore((s) => s.updateSettings);
  const go = useStore((s) => s.go);

  const gameCanvas = useRef(null);
  const overlayCanvas = useRef(null);
  const minimapCanvas = useRef(null);
  const gameRef = useRef(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [paused, setPaused] = useState(false);
  const [locked, setLocked] = useState(false);
  const [scoreboard, setScoreboard] = useState(false);
  const [result, setResult] = useState(null);
  const [objectiveBanner, setObjectiveBanner] = useState(null);
  const [campaignLog, setCampaignLog] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!config || !gameCanvas.current) return undefined;

    const client = new GameClient({
      canvas: gameCanvas.current,
      overlayCanvas: overlayCanvas.current,
      minimapCanvas: minimapCanvas.current,
      settings: settingsRef.current,
      net,
      onHud: (state) => useStore.getState().setHud(state),
      onEvent: (event) => {
        switch (event.type) {
          case 'pauseRequested':
            setPaused((p) => {
              if (!p) client.pause('user');
              return true;
            });
            break;
          case 'lockchange':
            setLocked(event.locked);
            break;
          case 'match:end':
            setResult(event.result);
            break;
          case 'campaign':
            handleCampaignEvent(event.event, setObjectiveBanner, setCampaignLog);
            break;
          case 'error':
            setError(event.message);
            break;
          default:
            break;
        }
      },
    });

    gameRef.current = client;
    try {
      client.start(config);
    } catch (err) {
      console.error('[game] failed to start', err);
      setError(err.message || 'Could not start the match.');
      return () => {
        gameRef.current = null;
      };
    }

    window.addEventListener('resize', client.handleResize);
    return () => {
      window.removeEventListener('resize', client.handleResize);
      client.stop();
      gameRef.current = null;
    };
    // A new gameKey means a genuinely new match; re-running on `config` alone
    // would tear the match down whenever the store recreated the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameKey]);

  // Live-apply settings so the settings menu inside the pause screen is honest.
  useEffect(() => {
    gameRef.current?.applySettings(settings);
  }, [settings]);

  const resume = useCallback(() => {
    setPaused(false);
    gameRef.current?.resume();
  }, []);

  const leave = useCallback(() => {
    gameRef.current?.stop();
    if (!config?.online) useStore.getState().setHud(null);
    else net.leaveLobby();
    setResult(null);
    go(config?.online ? 'play' : 'menu');
  }, [config, go]);

  const restart = useCallback(() => {
    setResult(null);
    useStore.getState().launchMatch({ ...config, resume: false });
  }, [config]);

  const openMap = useCallback((open) => {
    gameRef.current?.setMapOpen(open);
  }, []);

  // Escape opens the pause menu; the browser releases pointer lock for us.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code === 'Tab') {
        e.preventDefault();
        setScoreboard(true);
      }
      if (e.code === 'Escape') {
        e.preventDefault();
        setPaused(true);
        gameRef.current?.pause('user');
      }
    };
    const onKeyUp = (e) => {
      if (e.code === 'Tab') {
        e.preventDefault();
        setScoreboard(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const showResults = result || (hud?.matchState === 'over' && config?.online === false && hud?.mode !== 'practice');
  const objective = hud?.campaign;
  const practice = hud?.practice;

  return (
    <div className="game-root">
      <canvas ref={gameCanvas} className="game-canvas" />
      <canvas ref={overlayCanvas} className="hud-canvas" />
      <div className="minimap-wrap" style={{ right: 20, bottom: 20, display: settings.showMinimap ? 'block' : 'none' }}>
        <canvas ref={minimapCanvas} />
      </div>

      {hud && <Hud hud={hud} settings={settings} objective={objective} practice={practice} />}

      {objectiveBanner && (
        <div className="objective-banner" key={objectiveBanner.key}>
          <div className="tag">{objectiveBanner.tag}</div>
          <div className="text">{objectiveBanner.text}</div>
        </div>
      )}

      {scoreboard && !paused && <Scoreboard hud={hud} />}

      {!locked && !paused && !showResults && (
        <div className="click-to-play" onClick={() => gameRef.current?.resume()}>
          <div className="inner">
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '0.16em' }}>CLICK TO PLAY</div>
            <div className="mono-small text-faint mt-8">
              Pointer lock is required for mouse look. Press Esc at any time to pause.
            </div>
            {error && <div className="text-bad mt-8">{error}</div>}
          </div>
        </div>
      )}

      {paused && !showResults && (
        <PauseMenu
          hud={hud}
          paused
          onResume={resume}
          onLeave={leave}
          settings={settings}
          updateSettings={updateSettings}
          onOpenMap={openMap}
        />
      )}

      {showResults && (
        <Results
          hud={hud}
          result={result}
          config={config}
          onRestart={restart}
          onLeave={leave}
        />
      )}

      {campaignLog.length > 0 && !objectiveBanner && (
        <div className="hud">
          <div className="corner bl" style={{ bottom: 200 }}>
            {campaignLog.slice(-3).map((entry) => (
              <div key={entry.key} className="mono-small text-faint">
                {entry.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function handleCampaignEvent(event, setBanner, setLog) {
  if (!event) return;
  if (event.t === 'objective') {
    setBanner({ key: `${event.text}-${Date.now()}`, tag: event.state === 'done' ? 'objective complete' : 'new objective', text: event.text });
    window.setTimeout(() => setBanner(null), 4200);
    setLog((prev) => [...prev.slice(-8), { key: `${event.text}-${Date.now()}`, text: event.text }]);
  }
  if (event.t === 'wave') {
    setBanner({ key: `wave-${event.index}-${Date.now()}`, tag: `wave ${event.index + 1} of ${event.total}`, text: `${event.enemies} hostiles inbound` });
    window.setTimeout(() => setBanner(null), 3200);
  }
  if (event.t === 'mission' && event.state === 'complete') {
    setBanner({ key: `mission-${Date.now()}`, tag: 'mission complete', text: 'Coldstore secured' });
  }
}

// ---------------------------------------------------------------------------
// HUD panels
// ---------------------------------------------------------------------------

function Hud({ hud, settings, objective, practice }) {
  const weapon = WEAPONS[hud.weaponId] || WEAPONS.ar;
  const healthPct = Math.max(0, Math.min(1, hud.health / (hud.maxHealth || 100)));
  const low = healthPct < 0.35;
  const ammoLow = hud.ammo <= Math.max(3, weapon.magSize * 0.2);

  return (
    <div className="hud">
      {/* Vitals, bottom left */}
      <div className="corner bl">
        <div className="hud-label">vitals</div>
        <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
          <div className="hud-number" style={{ color: low ? '#ff9a6a' : '#e8eef6' }}>
            {hud.health}
          </div>
          {hud.armor > 0 && (
            <div>
              <div className="mono-small" style={{ color: '#8fbde8' }}>
                {hud.armor} AP
              </div>
            </div>
          )}
        </div>
        <div className={`health-bar ${low ? 'low' : ''}`}>
          <i style={{ width: `${healthPct * 100}%` }} />
        </div>
        {hud.armor > 0 && (
          <div className="armor-bar">
            <i style={{ width: `${Math.min(100, hud.armor)}%` }} />
          </div>
        )}
        <div className="row mt-8" style={{ gap: 14 }}>
          <span className="mono-small text-faint">
            <b className="text-dim">{hud.kills}</b> kills
          </span>
          <span className="mono-small text-faint">
            <b className="text-dim">{hud.deaths}</b> deaths
          </span>
          <span className="mono-small text-faint">
            <b className="text-dim">{hud.assists}</b> assists
          </span>
        </div>
      </div>

      {/* Ammo, bottom right */}
      <div className="corner br" style={{ bottom: 226 }}>
        <div className="hud-weapon">{weapon.name}</div>
        <div className="row" style={{ justifyContent: 'flex-end', alignItems: 'baseline', gap: 6 }}>
          <span className={`hud-number ${ammoLow ? 'ammo-low' : ''}`} style={{ fontSize: 30 }}>
            {hud.ammo}
          </span>
          <span className="mono-small text-faint">/ {hud.reserve}</span>
        </div>
        <div className="mono-small text-faint">
          {hud.slot === 'primary' ? 'primary' : 'sidearm'} · {weapon.className}
        </div>
        {hud.reloading && <div className="mono-small text-accent">reloading…</div>}
        <div className="row mt-8" style={{ justifyContent: 'flex-end', gap: 6 }}>
          <span className={`badge ${hud.slot === 'primary' ? 'accent' : ''}`} style={{ opacity: hud.slot === 'primary' ? 1 : 0.5 }}>
            {(WEAPONS[hud.loadout?.primary] || {}).name || 'primary'} <span className="text-faint">1</span>
          </span>
          <span className={`badge ${hud.slot === 'secondary' ? 'accent' : ''}`} style={{ opacity: hud.slot === 'secondary' ? 1 : 0.5 }}>
            {(WEAPONS[hud.loadout?.secondary] || {}).name || 'sidearm'} <span className="text-faint">2</span>
          </span>
        </div>
      </div>

      {/* Match state, top centre */}
      <div className="corner bc" style={{ bottom: 'auto', top: 0 }}>
        <MatchHeader hud={hud} />
      </div>

      {/* Kill feed, top right */}
      <div className="corner tr">
        <div className="kill-feed">
          {hud.killFeed.slice(0, 5).map((entry, i) => (
            <div className="entry" key={`${entry.at}-${i}`}>
              <span className="killer" style={{ color: entry.killerId === hud.you ? '#ffd166' : undefined }}>
                {entry.killer}
              </span>
              <span className="weapon">{WEAPONS[entry.weapon]?.name || entry.weapon}{entry.headshot ? ' ◉' : ''}</span>
              <span className="victim">{entry.victim}</span>
            </div>
          ))}
        </div>
        <div className="row mt-8" style={{ justifyContent: 'flex-end', gap: 8 }}>
          {hud.ping > 0 && <Badge tone={pingTone(hud.ping)}>{pingLabel(hud.ping)}</Badge>}
          {settings.showFps && <Badge>{hud.fps} fps</Badge>}
          {hud.interpDelay > 0 && <Badge>{hud.interpDelay} ms playback</Badge>}
        </div>
      </div>

      {/* Practice scoring */}
      {practice && (
        <div className="corner tl" style={{ top: 96 }}>
          <div className="hud-label">practice</div>
          <div className="hud-number" style={{ fontSize: 26 }}>{practice.score}</div>
          <div className="mono-small text-faint">
            {practice.hits}/{practice.shots} hits · {practice.shots ? Math.round((practice.hits / practice.shots) * 100) : 0}%
          </div>
          <div className="mono-small text-faint">
            streak {practice.streak} · best {practice.bestStreak} · headshots {practice.headshots}
          </div>
        </div>
      )}

      {/* Campaign objective */}
      {objective && !objective.complete && (
        <div className="corner tr" style={{ top: 132 }}>
          <div className="hud-label">objective</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{objective.objective}</div>
          {objective.phase === 1 && (
            <>
              <div className="mono-small text-faint">
                {objective.wave}/{objective.waves} waves · {objective.defendLeft}s remaining
              </div>
              <div className="health-bar" style={{ width: 200, marginLeft: 'auto' }}>
                <i style={{ width: `${Math.max(0, Math.min(100, (objective.defendLeft / 90) * 100))}%`, background: '#7fd1ff' }} />
              </div>
            </>
          )}
          {objective.phase === 0 && (
            <div className="mono-small text-faint">
              {objective.cleared}/{objective.clearTarget} hostiles cleared
            </div>
          )}
          {objective.phase === 2 && <div className="mono-small text-faint">stay close to the HVT</div>}
        </div>
      )}

      {hud.dead && (
        <div className="overlay" style={{ background: 'rgba(40,6,6,0.42)', backdropFilter: 'none' }}>
          <div className="center">
            <div className="respawn-hint">eliminated</div>
            <div className="mono-small text-faint mt-8">
              {hud.mode === 'practice' ? 'respawning…' : `respawning in ${Math.ceil(hud.respawnIn || 0)}s`}
            </div>
          </div>
        </div>
      )}

      {hud.sprinting && (
        <div className="corner bc" style={{ bottom: 96 }}>
          <div className="mono-small text-faint">sprinting — you cannot shoot while sprinting</div>
        </div>
      )}

      {hud.crouching && (
        <div className="corner bc" style={{ bottom: 78 }}>
          <div className="mono-small text-faint">crouched</div>
        </div>
      )}
    </div>
  );
}

function MatchHeader({ hud }) {
  if (hud.mode === 'tdm') {
    const a = hud.teamScores?.a ?? 0;
    const b = hud.teamScores?.b ?? 0;
    return (
      <div>
        <div className="team-score">
          <span className="a">{a}</span>
          <span className="text-faint" style={{ fontSize: 12 }}>
            {formatTime(hud.timeLeft)}
          </span>
          <span className="b">{b}</span>
        </div>
        <div className="mono-small text-faint">first to {hud.killLimit} team kills</div>
      </div>
    );
  }
  if (hud.mode === 'ffa') {
    return (
      <div>
        <div className="hud-number" style={{ fontSize: 24 }}>
          {hud.kills}
          <span className="text-faint" style={{ fontSize: 14 }}> / {hud.killLimit}</span>
        </div>
        <div className="mono-small text-faint">{formatTime(hud.timeLeft)} · free for all</div>
      </div>
    );
  }
  return null;
}

function Scoreboard({ hud }) {
  if (!hud) return null;
  const rows = hud.roster || [];
  const teams = hud.mode === 'tdm' ? ['a', 'b'] : ['all'];
  return (
    <div className="scoreboard fade-in">
      <div className="row between">
        <h2 style={{ fontSize: 14 }}>{hud.levelName} · {hud.mode === 'tdm' ? 'team deathmatch' : 'free for all'}</h2>
        <span className="mono-small text-faint">
          {hud.mode === 'tdm' ? `${hud.teamScores?.a ?? 0} – ${hud.teamScores?.b ?? 0}` : `${hud.kills}/${hud.killLimit}`}
          {' · '}
          {formatTime(hud.timeLeft)}
        </span>
      </div>
      <table className="mt-16">
        <thead>
          <tr>
            <th style={{ width: 150 }}>player</th>
            <th style={{ width: 60 }}>team</th>
            <th>kills</th>
            <th>deaths</th>
            <th>assists</th>
            <th>score</th>
          </tr>
        </thead>
        <tbody>
          {teams.flatMap((team) =>
            (team === 'all' ? [{ id: '__all', team: 'all', header: true }] : [{ id: `__${team}`, team, header: true }])
              .concat(rows.filter((r) => (team === 'all' ? true : r.team === team)))
              .map((row) => {
                if (row.header) {
                  const teamRows = team === 'all' ? rows : rows.filter((r) => r.team === team);
                  const label = team === 'all' ? 'players' : `team ${team.toUpperCase()}`;
                  const total = teamRows.reduce((sum, r) => sum + (r.score || 0), 0);
                  return (
                    <tr key={row.id}>
                      <td colSpan={6} style={{ paddingTop: 16, color: team === 'a' ? 'var(--team-a)' : team === 'b' ? 'var(--team-b)' : 'var(--text-dim)' }}>
                        <b>{label}</b> <span className="text-faint mono-small">total score {total}</span>
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={row.id} className={`${row.isYou ? 'me' : ''} ${row.dead ? 'dead' : ''}`}>
                    <td>
                      {row.name}
                      {row.isYou && <span className="text-accent mono-small"> · you</span>}
                    </td>
                    <td className="text-faint">{row.team === 'a' || row.team === 'b' ? row.team.toUpperCase() : '—'}</td>
                    <td>{row.kills}</td>
                    <td>{row.deaths}</td>
                    <td>{row.assists}</td>
                    <td>{row.score}</td>
                  </tr>
                );
              }),
          )}
        </tbody>
      </table>
      <div className="mono-small text-faint mt-16">
        Hold Tab to show the scoreboard. Press M for the full map.
      </div>
    </div>
  );
}

function PauseMenu({ hud, onResume, onLeave, settings, updateSettings, onOpenMap }) {
  const [tab, setTab] = useState('resume');
  return (
    <div className="overlay">
      <div className="dialog panel">
        <div className="row between" style={{ marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 14 }}>Paused</h2>
            <div className="panel-sub">{hud?.levelName || 'Match'} · {hud?.mode || ''}</div>
          </div>
          <Chips
            options={[
              { value: 'resume', label: 'Resume' },
              { value: 'settings', label: 'Settings' },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>

        {tab === 'resume' ? (
          <div className="stack">
            {hud && (
              <div className="stat-grid">
                <div className="stat">
                  <div className="value">{hud.kills}</div>
                  <div className="key">kills</div>
                </div>
                <div className="stat">
                  <div className="value">{hud.deaths}</div>
                  <div className="key">deaths</div>
                </div>
                <div className="stat">
                  <div className="value">{hud.fps}</div>
                  <div className="key">fps</div>
                </div>
                <div className="stat">
                  <div className="value">{hud.ping ? `${hud.ping}` : '—'}</div>
                  <div className="key">ping ms</div>
                </div>
              </div>
            )}
            <div className="divider" />
            <Btn variant="primary" size="large" block onClick={onResume}>
              Resume
            </Btn>
            <Btn block onClick={() => onOpenMap(true)}>
              Full map
            </Btn>
            <Btn variant="danger" block onClick={onLeave}>
              Leave match
            </Btn>
          </div>
        ) : (
          <div className="stack">
            <Slider
              label="Mouse sensitivity"
              min={0.1}
              max={4}
              step={0.05}
              value={settings.sensitivity}
              onChange={(sensitivity) => updateSettings({ sensitivity })}
              format={(v) => v.toFixed(2)}
            />
            <Slider
              label="Field of view"
              min={70}
              max={110}
              value={settings.fov}
              onChange={(fov) => updateSettings({ fov })}
              format={(v) => `${v}°`}
            />
            <Slider
              label="Master volume"
              min={0}
              max={1}
              step={0.05}
              value={settings.masterVolume}
              onChange={(masterVolume) => updateSettings({ masterVolume })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <Slider
              label="Render scale"
              min={0.5}
              max={1.3}
              step={0.05}
              value={settings.renderScale}
              onChange={(renderScale) => updateSettings({ renderScale })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <div className="row wrap" style={{ gap: 18 }}>
              <Toggle label="Shadows" checked={settings.shadows} onChange={(shadows) => updateSettings({ shadows })} />
              <Toggle label="Bloom" checked={settings.bloom} onChange={(bloom) => updateSettings({ bloom })} />
              <Toggle
                label="Ambient occlusion"
                checked={settings.ambientOcclusion}
                onChange={(ambientOcclusion) => updateSettings({ ambientOcclusion })}
              />
            </div>
            <div className="divider" />
            <Btn variant="primary" block onClick={onResume}>
              Back to the fight
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}

function Results({ hud, result, config, onRestart, onLeave }) {
  const winner = result?.winner ?? hud?.matchState;
  const myTeam = hud?.localTeam;
  const won = winner === myTeam || (hud?.mode === 'ffa' && winner === hud?.you);
  const draw = winner === 'draw';
  const roster = result?.roster || hud?.roster || [];

  return (
    <div className="overlay">
      <div className="dialog panel">
        <div className="center">
          <div className="hud-label">{config?.online ? 'match over' : 'practice complete'}</div>
          <h2 style={{ fontSize: 26, letterSpacing: '0.16em' }}>
            {draw ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT'}
          </h2>
          {hud?.mode === 'tdm' && (
            <div className="team-score mt-8">
              <span className="a">{result?.scores?.a ?? hud?.teamScores?.a ?? 0}</span>
              <span className="text-faint" style={{ fontSize: 12 }}>—</span>
              <span className="b">{result?.scores?.b ?? hud?.teamScores?.b ?? 0}</span>
            </div>
          )}
        </div>

        <div className="divider" />

        {roster.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>player</th>
                <th>kills</th>
                <th>deaths</th>
                <th>assists</th>
                <th>score</th>
              </tr>
            </thead>
            <tbody>
              {roster.slice(0, 10).map((row) => (
                <tr key={row.id} className={row.isYou ? 'me' : ''}>
                  <td>
                    {row.name}
                    {row.isYou && <span className="text-accent mono-small"> · you</span>}
                  </td>
                  <td>{row.kills}</td>
                  <td>{row.deaths}</td>
                  <td>{row.assists}</td>
                  <td>{row.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {hud?.practice && (
          <div className="stat-grid mt-16">
            <div className="stat">
              <div className="value">{hud.practice.score}</div>
              <div className="key">score</div>
            </div>
            <div className="stat">
              <div className="value">
                {hud.practice.shots ? Math.round((hud.practice.hits / hud.practice.shots) * 100) : 0}%
              </div>
              <div className="key">accuracy</div>
            </div>
            <div className="stat">
              <div className="value">{hud.practice.bestStreak}</div>
              <div className="key">best streak</div>
            </div>
            <div className="stat">
              <div className="value">{hud.practice.headshots}</div>
              <div className="key">headshots</div>
            </div>
          </div>
        )}

        <div className="row mt-24" style={{ gap: 10 }}>
          <Btn variant="primary" size="large" onClick={onRestart}>
            Play again
          </Btn>
          <Btn size="large" onClick={onLeave}>
            Back to menu
          </Btn>
        </div>
      </div>
    </div>
  );
}

function formatTime(seconds) {
  if (!seconds || seconds <= 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
