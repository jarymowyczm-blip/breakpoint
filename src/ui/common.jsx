/**
 * Shared UI primitives.
 *
 * Small, unstyled-by-default wrappers that keep the screens declarative and the
 * markup consistent. Nothing here holds state: behaviour lives in the screens and
 * in the store, so these stay trivially reusable and easy to reason about.
 */

import React from 'react';

export function Panel({ title, subtitle, children, className = '', actions = null, ...rest }) {
  return (
    <section className={`panel ${className}`} {...rest}>
      {(title || actions) && (
        <header className="row between" style={{ marginBottom: 14 }}>
          <div>
            {title && <h2 style={{ marginBottom: subtitle ? 2 : 0 }}>{title}</h2>}
            {subtitle && <div className="panel-sub">{subtitle}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Btn({ children, variant = '', size = '', className = '', ...rest }) {
  const classes = ['btn', variant, size, className].filter(Boolean).join(' ');
  return (
    <button type="button" className={classes} {...rest}>
      {children}
    </button>
  );
}

export function Field({ label, hint, children }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {hint && <div className="mono-small text-faint">{hint}</div>}
    </div>
  );
}

export function TextInput({ label, hint, ...rest }) {
  return (
    <Field label={label} hint={hint}>
      <input type="text" {...rest} />
    </Field>
  );
}

/**
 * Choice chips. Used for maps, modes, difficulties and bot counts, where a
 * select box would hide the options behind a click.
 */
export function Chips({ options, value, onChange, disabled = false }) {
  return (
    <div className="chips">
      {options.map((option) => {
        const value_ = typeof option === 'string' ? option : option.value;
        const label = typeof option === 'string' ? option : option.label;
        const optionDisabled = typeof option === 'object' && option.disabled;
        return (
          <button
            key={value_}
            type="button"
            className={`chip ${value === value_ ? 'active' : ''}`}
            onClick={() => onChange(value_)}
            disabled={disabled || optionDisabled}
            title={typeof option === 'object' ? option.title : undefined}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({ label, checked, onChange, hint }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="mono-small text-faint" style={{ marginLeft: 8 }}>{hint}</span>}
      </span>
    </label>
  );
}

export function Slider({ label, value, min, max, step = 1, onChange, format = (v) => v, hint }) {
  return (
    <Field label={label} hint={hint}>
      <div className="row">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="mono-small" style={{ minWidth: 54, textAlign: 'right' }}>{format(value)}</span>
      </div>
    </Field>
  );
}

export function Stat({ label, value, tone = '' }) {
  return (
    <div className="stat">
      <div className={`value ${tone}`}>{value}</div>
      <div className="key">{label}</div>
    </div>
  );
}

export function Badge({ children, tone = '' }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/** Latency colouring: what a player cares about is whether it is playable. */
export function pingTone(ping) {
  if (!ping) return '';
  if (ping < 60) return 'good';
  if (ping < 130) return '';
  return 'bad';
}

export function pingLabel(ping) {
  if (!ping) return '—';
  return `${Math.round(ping)} ms`;
}

export function TopBar({ title, subtitle, onBack, children }) {
  return (
    <div className="topbar">
      <div className="brand">
        {onBack && (
          <Btn variant="ghost" size="tiny" onClick={onBack} style={{ marginRight: 6 }}>
            ← Back
          </Btn>
        )}
        <h1>BREACHPOINT</h1>
        <span>{subtitle || title || 'browser tactical shooter'}</span>
      </div>
      {children}
    </div>
  );
}

export function ProgressBar({ value, max = 1, tone = '' }) {
  const pct = Math.max(0, Math.min(1, max ? value / max : 0)) * 100;
  return (
    <div className="health-bar" style={{ width: '100%', marginTop: 0 }}>
      <i style={{ width: `${pct}%`, background: tone === 'accent' ? 'linear-gradient(90deg,#ff9a52,#ffd166)' : undefined }} />
    </div>
  );
}

export function KeyCap({ children }) {
  return <span className="keycap">{children}</span>;
}
