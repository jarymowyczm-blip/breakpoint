/**
 * Campaign, practice and settings screens.
 *
 * Campaign and practice both run entirely offline in the browser using the same
 * simulation module the server uses, so neither needs a connection and both are
 * instant to start. That is the payoff of keeping the simulation in shared code.
 */

import React, { useEffect, useState } from 'react';
import { useStore, net } from '../state/store.js';
import { GameClient } from '../game/GameClient.js';
import { LEVELS, LEVEL_LIST } from '../net/shared/levels.js';
import { DIFFICULTY, PLAYER } from '../net/shared/constants.js';
import { WEAPONS } from '../net/shared/weapons.js';
import { Btn, Panel, Chips, Field, TextInput, Badge, TopBar, Toggle, Slider, Stat } from './common.jsx';

export const DIFFICULTIES = [
  { value: 'recruit', label: 'Recruit', title: 'Slow reactions, forgiving aim — good for learning maps' },
  { value: 'regular', label: 'Regular', title: 'The balanced default' },
  { value: 'veteran', label: 'Veteran', title: 'Fast reactions and accurate bursts' },
  { value: 'elite', label: 'Elite', title: 'Near-instant reactions, punishing accuracy' },
];

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

const OBJECTIVES = [
  { tag: 'Objective 01', title: 'Clear the courtyard', detail: 'Push through the gate and eliminate 6 hostiles inside the compound perimeter.' },
  { tag: 'Objective 02', title: 'Hold the HQ', detail: 'Survive 90 seconds of counter-attacks. Three waves, escalating size and skill.' },
  { tag: 'Objective 03', title: 'Escort the HVT', detail: 'Keep the high-value target alive all the way to the extraction pad.' },
];

export function CampaignMenu() {
  const go = useStore((s) => s.go);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const launchMatch = useStore((s) => s.launchMatch);
  const profile = useStore((s) => s.profile);
  const [save, setSave] = useState(() => GameClient.loadCampaignSave());
  const [loadout, setLoadout] = useState('default');

  const level = LEVELS.compound;

  const start = (resume) => {
    launchMatch({
      mode: 'campaign',
      levelId: 'compound',
      difficulty: settings.difficulty,
      resume,
      loadout: loadoutId(loadout),
      name: profile?.name || 'Operator',
      online: false,
    });
  };

  return (
    <div className="screen">
      <TopBar title="Campaign" onBack={() => go('menu')}>
        {save && <Badge tone="accent">checkpoint available</Badge>}
      </TopBar>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Panel title="Operation: Coldstore" subtitle={level.subtitle}>
          <p className="text-dim mono-small" style={{ marginTop: 0 }}>
            {level.subtitle}. A single continuous mission in three phases, played offline against AI
            enemies that path through the compound, take cover and push objectives.
          </p>

          <div className="divider" />

          <div className="stack">
            {OBJECTIVES.map((objective, index) => {
              const state = save ? (save.phase > index ? 'done' : save.phase === index ? 'current' : 'locked') : index === 0 ? 'current' : 'locked';
              return (
                <div key={objective.tag} className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
                  <span
                    className={`badge ${state === 'done' ? 'good' : state === 'current' ? 'accent' : ''}`}
                    style={{ minWidth: 34, justifyContent: 'center' }}
                  >
                    {state === 'done' ? '✓' : index + 1}
                  </span>
                  <div>
                    <div style={{ fontWeight: 700 }}>{objective.title}</div>
                    <div className="mono-small text-faint">{objective.detail}</div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="divider" />

          <div className="stat-grid">
            <Stat label="Enemy waves" value={level.waves?.length ?? 0} />
            <Stat label="Difficulty" value={DIFFICULTY[settings.difficulty] ? titleCase(settings.difficulty) : '—'} />
            <Stat label="Render scale" value={`${Math.round(settings.renderScale * 100)}%`} />
            <Stat label="Shadows" value={settings.shadows ? 'On' : 'Off'} />
          </div>
        </Panel>

        <div className="stack">
          <Panel title="Deployment">
            <div className="stack">
              <Field label="Difficulty" hint={DIFFICULTY[settings.difficulty] ? `Reaction time ${DIFFICULTY[settings.difficulty].reactionTime}s, aim error ${DIFFICULTY[settings.difficulty].aimError}°` : ''}>
                <Chips options={DIFFICULTIES} value={settings.difficulty} onChange={(difficulty) => updateSettings({ difficulty })} />
              </Field>

              <Field label="Loadout">
                <Chips
                  options={[
                    { value: 'default', label: 'Rifleman' },
                    { value: 'close', label: 'Breacher' },
                    { value: 'marksman', label: 'Marksman' },
                    { value: 'recon', label: 'Sniper' },
                  ]}
                  value={loadout}
                  onChange={setLoadout}
                />
              </Field>

              <div className="mono-small text-faint">
                {loadoutDescription(loadout)}
              </div>

              <div className="divider" />

              {save ? (
                <div className="stack">
                  <div className="row between">
                    <div>
                      <div style={{ fontWeight: 700 }}>Resume from checkpoint</div>
                      <div className="mono-small text-faint">
                        Phase {save.phase ?? 0} · {save.cleared ?? 0} cleared ·{' '}
                        {save.savedAt ? new Date(save.savedAt).toLocaleString() : ''}
                      </div>
                    </div>
                    <Btn variant="primary" onClick={() => start(true)}>
                      Resume
                    </Btn>
                  </div>
                  <Btn
                    variant="danger"
                    onClick={() => {
                      GameClient.clearCampaignSave();
                      setSave(null);
                    }}
                  >
                    Delete checkpoint
                  </Btn>
                  <Btn variant="ghost" onClick={() => start(false)}>
                    Restart from the beginning
                  </Btn>
                </div>
              ) : (
                <Btn variant="primary" size="large" block onClick={() => start(false)}>
                  Begin operation
                </Btn>
              )}
            </div>
          </Panel>

          <Panel title="What is different offline">
            <ul className="list-plain">
              <li>
                <span className="text-dim">Same simulation.</span>
                <span className="text-faint mono-small">
                  The browser runs the identical authoritative module the server runs, so movement, spread and
                  damage behave exactly as they do online.
                </span>
              </li>
              <li>
                <span className="text-dim">Real pathfinding.</span>
                <span className="text-faint mono-small">
                  Enemies navigate a baked grid over the level, take cover behind geometry and push objectives
                  rather than walking into walls.
                </span>
              </li>
              <li>
                <span className="text-dim">Saving.</span>
                <span className="text-faint mono-small">
                  Progress is written at every objective to this device, and to the server when you are signed in.
                </span>
              </li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function loadoutId(name) {
  const map = {
    default: { primary: 'ar', secondary: 'pistol' },
    close: { primary: 'smg', secondary: 'pistol' },
    marksman: { primary: 'dmr', secondary: 'pistol' },
    recon: { primary: 'sniper', secondary: 'pistol' },
  };
  return map[name] || map.default;
}

function loadoutDescription(name) {
  const lo = loadoutId(name);
  const primary = WEAPONS[lo.primary];
  return `${primary.name} — ${primary.className}. ${primary.damage} damage, ${primary.rpm} RPM, ${primary.magSize}-round magazine.`;
}

// ---------------------------------------------------------------------------
// Practice
// ---------------------------------------------------------------------------

export function PracticeMenu() {
  const go = useStore((s) => s.go);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const launchMatch = useStore((s) => s.launchMatch);
  const profile = useStore((s) => s.profile);

  const level = LEVELS.range;

  const start = () =>
    launchMatch({
      mode: 'practice',
      levelId: 'range',
      difficulty: settings.practiceDifficulty,
      bots: settings.practiceBots,
      distance: settings.practiceDistance,
      infiniteAmmo: settings.infiniteAmmo,
      name: profile?.name || 'Operator',
      online: false,
    });

  return (
    <div className="screen">
      <TopBar title="Practice" onBack={() => go('menu')} />
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Panel title="Killhouse Range" subtitle={level.subtitle}>
          <ul className="list-plain">
            <li>
              <span className="text-dim">Five live lanes.</span>
              <span className="text-faint mono-small">
                Static plates, pop-ups on timed cycles, moving rail targets and a pair of penalty plates for
                trigger discipline.
              </span>
            </li>
            <li>
              <span className="text-dim">Recoil wall.</span>
              <span className="text-faint mono-small">
                Four stacked plates to learn a weapon's pattern against, from 25 metres.
              </span>
            </li>
            <li>
              <span className="text-dim">Movement course.</span>
              <span className="text-faint mono-small">
                Ramps, catwalks and a crouch tunnel for practising jump timing and strafing.
              </span>
            </li>
            <li>
              <span className="text-dim">Killhouse.</span>
              <span className="text-faint mono-small">
                A close-quarters block with pop-up targets in the rooms and corners.
              </span>
            </li>
          </ul>

          <div className="divider" />

          <div className="mono-small text-faint">
            Every shot is scored. Pop-ups are worth more than statics, penalty plates cost you points, and
            the streak counter tracks consecutive hits.
          </div>
        </Panel>

        <Panel title="Session">
          <div className="stack">
            <Slider
              label="Practice bots"
              min={0}
              max={6}
              value={settings.practiceBots}
              onChange={(practiceBots) => updateSettings({ practiceBots })}
              format={(v) => (v === 0 ? 'none' : `${v}`)}
              hint="Bots spawn on the range at fixed positions and fight back."
            />

            <Field label="Bot difficulty">
              <Chips
                options={DIFFICULTIES}
                value={settings.practiceDifficulty}
                onChange={(practiceDifficulty) => updateSettings({ practiceDifficulty })}
              />
            </Field>

            <Slider
              label="Target distance"
              min={8}
              max={40}
              value={settings.practiceDistance}
              onChange={(practiceDistance) => updateSettings({ practiceDistance })}
              format={(v) => `${v} m`}
            />

            <Toggle
              label="Infinite ammunition"
              checked={settings.infiniteAmmo}
              onChange={(infiniteAmmo) => updateSettings({ infiniteAmmo })}
              hint="Leave off to practise reload discipline."
            />

            <div className="divider" />

            <div className="stat-grid">
              <Stat label="Bots" value={settings.practiceBots} />
              <Stat label="Difficulty" value={titleCase(settings.practiceDifficulty)} />
              <Stat label="Their health" value={DIFFICULTY[settings.practiceDifficulty]?.health ?? PLAYER.maxHealth} />
            </div>

            <Btn variant="primary" size="large" block onClick={start}>
              Enter the range
            </Btn>
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function SettingsMenu() {
  const go = useStore((s) => s.go);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const applyQualityPreset = useStore((s) => s.applyQualityPreset);
  const resetSettings = useStore((s) => s.resetSettings);

  return (
    <div className="screen">
      <TopBar title="Settings" onBack={() => go('menu')}>
        <Btn size="tiny" variant="ghost" onClick={resetSettings}>
          Reset all
        </Btn>
      </TopBar>

      <div className="grid cols-3" style={{ alignItems: 'start' }}>
        <Panel title="Controls">
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
              label="ADS sensitivity"
              min={0.3}
              max={1.5}
              step={0.05}
              value={settings.scopeSensitivity}
              onChange={(scopeSensitivity) => updateSettings({ scopeSensitivity })}
              format={(v) => `${Math.round(v * 100)}%`}
              hint="Multiplier applied while aiming down sights."
            />
            <Toggle
              label="Invert vertical look"
              checked={settings.invertY}
              onChange={(invertY) => updateSettings({ invertY })}
            />
            <Slider
              label="Field of view"
              min={70}
              max={110}
              value={settings.fov}
              onChange={(fov) => updateSettings({ fov })}
              format={(v) => `${v}°`}
            />
            <div className="divider" />
            <div className="mono-small text-faint">
              Mouse input uses raw movement deltas with no acceleration, so the crosshair tracks your hand
              one to one at any polling rate.
            </div>
          </div>
        </Panel>

        <Panel title="Graphics" subtitle="Lower these first if the frame rate drops">
          <div className="stack">
            <Field label="Quality preset">
              <Chips
                options={[
                  { value: 'low', label: 'Low' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'high', label: 'High' },
                  { value: 'ultra', label: 'Ultra' },
                ]}
                value={settings.quality}
                onChange={applyQualityPreset}
              />
            </Field>

            <Toggle label="Shadows" checked={settings.shadows} onChange={(shadows) => updateSettings({ shadows })} />
            <Toggle label="Bloom" checked={settings.bloom} onChange={(bloom) => updateSettings({ bloom })} />
            <Toggle
              label="Ambient occlusion"
              checked={settings.ambientOcclusion}
              onChange={(ambientOcclusion) => updateSettings({ ambientOcclusion })}
              hint="Costs the most of the three."
            />

            <Slider
              label="Render scale"
              min={0.5}
              max={1.3}
              step={0.05}
              value={settings.renderScale}
              onChange={(renderScale) => updateSettings({ renderScale })}
              format={(v) => `${Math.round(v * 100)}%`}
              hint="Renders below native resolution and upscales."
            />

            <Field label="Shadow resolution">
              <Chips
                options={[
                  { value: 1024, label: '1K' },
                  { value: 2048, label: '2K' },
                  { value: 4096, label: '4K' },
                ]}
                value={settings.shadowQuality}
                onChange={(shadowQuality) => updateSettings({ shadowQuality })}
              />
            </Field>
          </div>
        </Panel>

        <Panel title="Audio & HUD">
          <div className="stack">
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
              label="Effects volume"
              min={0}
              max={1}
              step={0.05}
              value={settings.sfxVolume}
              onChange={(sfxVolume) => updateSettings({ sfxVolume })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <div className="divider" />
            <Toggle
              label="Minimap"
              checked={settings.showMinimap}
              onChange={(showMinimap) => updateSettings({ showMinimap })}
            />
            <Toggle
              label="Teammate nameplates"
              checked={settings.showNameplates}
              onChange={(showNameplates) => updateSettings({ showNameplates })}
              hint="Enemy names are never shown."
            />
            <Toggle label="Show frame rate" checked={settings.showFps} onChange={(showFps) => updateSettings({ showFps })} />
            <div className="divider" />
            <div className="mono-small text-faint">
              All sound is synthesised at runtime with the Web Audio API and positioned with an HRTF panner,
              so footsteps and gunfire pan correctly around you.
            </div>
          </div>
        </Panel>
      </div>

      <Panel className="mt-16" title="Network" subtitle="Read-only diagnostics">
        <div className="stat-grid">
          <Stat label="Server" value={useStore.getState().netStatus || 'offline'} />
          <Stat label="Ping" value={useStore.getState().ping ? `${Math.round(useStore.getState().ping)} ms` : '—'} />
          <Stat label="Playback delay" value={`${Math.round((useStore.getState().netMetrics?.interpDelay || 0) * 1000)} ms`} />
          <Stat label="Downloaded" value={bytes(useStore.getState().netMetrics?.bytesIn)} />
          <Stat label="Uploaded" value={bytes(useStore.getState().netMetrics?.bytesOut)} />
          <Stat label="Lobbies" value={useStore.getState().lobbies?.length ?? 0} />
        </div>
      </Panel>
    </div>
  );
}

function bytes(value = 0) {
  if (!value) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function titleCase(text) {
  if (!text) return '—';
  return String(text).charAt(0).toUpperCase() + String(text).slice(1);
}

export { LEVEL_LIST };
