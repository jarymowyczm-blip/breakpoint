/**
 * App shell.
 *
 * Routes between screens and owns the two things that must happen exactly once
 * per session regardless of which screen is open: connecting the WebSocket and
 * unlocking the audio context on the first user gesture.
 */

import React, { useEffect, useState } from 'react';
import { useStore, net } from './state/store.js';
import MainMenu from './ui/MainMenu.jsx';
import { PlayMenu, LobbyRoom } from './ui/PlayScreens.jsx';
import { CampaignMenu, PracticeMenu, SettingsMenu } from './ui/ModeScreens.jsx';
import GameView from './ui/GameView.jsx';
import { Btn } from './ui/common.jsx';

export default function App() {
  const screen = useStore((s) => s.screen);
  const go = useStore((s) => s.go);
  const netStatus = useStore((s) => s.netStatus);
  const [ready, setReady] = useState(false);

  // Connect once. The socket carries identity, the lobby list and (later) the
  // match, so it must outlive every screen transition. The state mirror in the
  // store is what tells us the handshake completed.
  useEffect(() => {
    net.connect({});
    const unsubscribe = net.subscribe(() => setReady(true));
    return () => {
      unsubscribe();
      net.disconnect();
    };
  }, []);

  return (
    <div className="app">
      {screen === 'menu' && <MainMenu />}
      {screen === 'play' && <PlayMenu />}
      {screen === 'lobby' && <LobbyRoom />}
      {screen === 'campaign' && <CampaignMenu />}
      {screen === 'practice' && <PracticeMenu />}
      {screen === 'settings' && <SettingsMenu />}
      {screen === 'game' && <GameView />}

      {!ready && screen !== 'game' && <BootOverlay netStatus={netStatus} onSkip={() => go('practice')} />}
    </div>
  );
}

/**
 * A short connection overlay. It never blocks: single-player modes work with no
 * server at all, so the only thing this does is explain a slow connection.
 */
function BootOverlay({ netStatus, onSkip }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((e) => e + 0.25), 250);
    return () => clearInterval(timer);
  }, []);

  if (elapsed < 2) return null;

  return (
    <div className="overlay">
      <div className="dialog panel center" style={{ maxWidth: 420 }}>
        <h2 style={{ fontSize: 14 }}>Connecting to the game server</h2>
        <div className="mono-small text-faint mt-8">
          Status: {netStatus || 'connecting'} · {elapsed.toFixed(1)}s
        </div>
        <div className="divider" />
        <p className="mono-small text-dim">
          Multiplayer needs the server. The campaign and the practice range run entirely offline in your
          browser and work either way.
        </p>
        <Btn variant="primary" block onClick={onSkip}>
          Play offline instead
        </Btn>
      </div>
    </div>
  );
}
