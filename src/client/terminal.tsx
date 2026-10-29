import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  ArrowUpRight,
  CircleStop,
  LockKeyhole,
  Maximize2,
  RefreshCw,
  SquareTerminal,
} from 'lucide-react';
import type { Mode } from '../shared/types';
import { ErrorBox, Spinner } from './components';
import '@xterm/xterm/css/xterm.css';

export function TerminalPanel({
  vmId,
  enabled,
  status,
  mode,
}: {
  vmId: string;
  enabled: boolean;
  status: string;
  mode: Mode;
}) {
  const host = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLElement>(null),
    socket = useRef<WebSocket | null>(null),
    term = useRef<Terminal | null>(null),
    fit = useRef<FitAddon | null>(null);
  const [connected, setConnected] = useState(false),
    [connecting, setConnecting] = useState(false),
    [connectionRequested, setConnectionRequested] = useState(false),
    [generation, setGeneration] = useState(0),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    if (!connectionRequested || !enabled || !host.current) return;
    let disposed = false;
    setConnecting(true);
    setConnected(false);
    setError('');
    setNotice('');
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      lineHeight: 1.45,
      scrollback: 2000,
      theme: {
        background: '#0c0c0e',
        foreground: '#f1f0f0',
        cursor: '#ff7a24',
        selectionBackground: '#352217',
        black: '#0c0c0e',
        red: '#f28a84',
        green: '#7fcda0',
        yellow: '#e6bf73',
        blue: '#a9c5e9',
        magenta: '#c2afd8',
        cyan: '#a0d1d2',
        white: '#f1f0f0',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host.current);
    term.current = terminal;
    fit.current = fitAddon;
    fitAddon.fit();
    const ws = new WebSocket(
      `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/vms/${encodeURIComponent(vmId)}/terminal`,
    );
    socket.current = ws;
    const send = (data: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    };
    const dataSubscription = terminal.onData((data) => send({ type: 'input', data }));
    const resizeSubscription = terminal.onResize(({ cols, rows }) =>
      send({ type: 'resize', cols, rows }),
    );
    ws.onopen = () => {
      send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
    };
    ws.onmessage = (event) => {
      if (disposed) return;
      try {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          data?: string;
          message?: string;
          exitCode?: number;
        };
        if (message.type === 'ready') {
          clearTimeout(handshakeTimeout);
          setConnected(true);
          setConnecting(false);
          terminal.focus();
          send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
        } else if (message.type === 'output' && typeof message.data === 'string') {
          const raw = atob(message.data),
            bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
          terminal.write(bytes, () => send({ type: 'ack', bytes: bytes.byteLength }));
        } else if (message.type === 'error') {
          setError(message.message || 'The terminal connection reported an error.');
          setConnecting(false);
        } else if (message.type === 'exit') {
          setNotice(
            `The terminal process exited${message.exitCode === undefined ? '' : ` with code ${message.exitCode}`}. Your rental continues until expiry or termination.`,
          );
          setConnected(false);
          setConnecting(false);
        }
      } catch {
        setError('The terminal sent an unreadable message. Reconnect to try again.');
        ws.close();
      }
    };
    ws.onerror = () => {
      if (!disposed)
        setError(
          'Unable to connect to the terminal. Your session or rental may no longer be active.',
        );
    };
    ws.onclose = (event) => {
      if (disposed) return;
      setConnected(false);
      setConnecting(false);
      setNotice(
        event.code === 1000
          ? 'Terminal disconnected. Your rental continues until expiry or termination.'
          : 'Terminal connection closed. Reconnect to the same environment while your rental is active.',
      );
    };
    const observer = new ResizeObserver(() => {
      if (!disposed && host.current?.clientWidth) fitAddon.fit();
    });
    observer.observe(host.current);
    const ping = setInterval(() => send({ type: 'ping' }), 25000);
    const handshakeTimeout = setTimeout(() => {
      if (!disposed && ws.readyState !== WebSocket.CLOSED) {
        setConnecting(false);
        setError(
          'Terminal setup is taking longer than expected. You can disconnect and reconnect.',
        );
      }
    }, 20000);
    return () => {
      disposed = true;
      clearInterval(ping);
      clearTimeout(handshakeTimeout);
      observer.disconnect();
      dataSubscription.dispose();
      resizeSubscription.dispose();
      ws.close(1000, 'Client disconnected');
      terminal.dispose();
      socket.current = null;
      term.current = null;
      fit.current = null;
      setConnected(false);
      setConnecting(false);
    };
  }, [connectionRequested, enabled, vmId, generation]);
  const connect = () => {
    setConnectionRequested(true);
    setGeneration((value) => value + 1);
  };
  const disconnect = () => {
    setConnectionRequested(false);
    setNotice('Disconnected. Your rental remains active until expiry or termination.');
    setError('');
  };
  const fullScreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else
      void panel.current
        ?.requestFullscreen()
        .catch(() => setError('Fullscreen is unavailable in this browser.'));
  };
  return (
    <section className="terminal-panel" ref={panel}>
      <div className="terminal-toolbar">
        <div className="terminal-title">
          <SquareTerminal size={17} />
          <strong>Browser terminal</strong>
          <span className={`terminal-status ${connected ? 'connected' : ''}`}>
            <i />
            {connected ? 'Connected' : connecting ? 'Connecting' : 'Disconnected'}
          </span>
        </div>
        <div className="terminal-actions">
          <span className="terminal-private">
            <LockKeyhole size={12} />
            Private session
          </span>
          {connectionRequested && (
            <button
              onClick={disconnect}
              className="terminal-icon-button"
              title="Disconnect terminal"
              aria-label="Disconnect terminal"
            >
              <CircleStop size={16} />
            </button>
          )}
          {connected && (
            <button
              onClick={fullScreen}
              className="terminal-icon-button"
              title="Fullscreen terminal"
              aria-label="Fullscreen terminal"
            >
              <Maximize2 size={16} />
            </button>
          )}
        </div>
      </div>
      {mode === 'fixture' && (
        <div className="terminal-fixture-banner">
          Fixture terminal · simulated shell · commands do not execute on a real VM
        </div>
      )}
      <div className={`terminal-body ${connectionRequested && enabled ? 'has-session' : ''}`}>
        {connectionRequested && enabled ? (
          <>
            <div ref={host} className="xterm-host" aria-label="Environment terminal" />
            {connecting && (
              <div className="terminal-connecting">
                <Spinner label="Opening a secure session" />
              </div>
            )}
          </>
        ) : (
          <div className="terminal-empty">
            <span className="terminal-empty-icon">
              <SquareTerminal size={31} />
            </span>
            <h3>
              {enabled
                ? 'Make yourself at home.'
                : status === 'provisioning'
                  ? 'Your environment is getting ready.'
                  : 'This environment is no longer available.'}
            </h3>
            <p>
              {enabled
                ? 'Connect to your private environment and enter your own commands.'
                : status === 'provisioning'
                  ? 'Terminal access appears after Wick confirms the environment is running.'
                  : 'Terminal sessions are available only during an active, ready rental.'}
            </p>
            {enabled && (
              <button className="button terminal-connect" onClick={connect}>
                <ArrowUpRight size={16} />
                Connect terminal
              </button>
            )}
          </div>
        )}
      </div>
      {(error || notice) && (
        <div className="terminal-notice">
          {error ? <ErrorBox error={error} /> : <p>{notice}</p>}
          {enabled && !connected && !connecting && connectionRequested && (
            <button className="button small secondary" onClick={connect}>
              <RefreshCw size={14} />
              Reconnect terminal
            </button>
          )}
        </div>
      )}
      <div className="terminal-footer">
        <span>
          <LockKeyhole size={12} />
          No terminal transcript is retained
        </span>
        <span>Disconnecting leaves your rental running</span>
      </div>
    </section>
  );
}
