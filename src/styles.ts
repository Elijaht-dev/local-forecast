import { css } from "lit";

export const controls = css`
  :host {
    --lf-surface: var(--card-background-color, #fff);
    --lf-border: var(--divider-color, #d5dee6);
    --lf-accent: var(--primary-color, #0079a8);
    --lf-muted: var(--secondary-text-color, #52606b);
    color: var(--primary-text-color, #15232b);
    font: 14px/1.45 var(--primary-font-family, Roboto, Arial, sans-serif);
  }
  *, *::before, *::after { box-sizing: border-box; }
  button, input, select { font: inherit; }
  button {
    display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    color: var(--lf-accent); background: var(--lf-surface);
    border: 1px solid var(--lf-accent); border-radius: 7px;
    min-height: 38px; padding: 6px 12px; cursor: pointer; font-weight: 600;
  }
  button.primary {
    color: var(--text-primary-color, #fff); background: var(--lf-accent); border-color: var(--lf-accent);
  }
  button:hover:not(:disabled) { filter: brightness(0.94); }
  button:disabled { cursor: default; opacity: 0.48; }
  button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible {
    outline: 2px solid var(--lf-accent); outline-offset: 2px;
  }
  label { display: grid; min-width: 0; gap: 4px; font-weight: 600; }
  input:not([type=checkbox]), select {
    color: inherit; background: var(--lf-surface); border: 1px solid var(--lf-border);
    border-radius: 7px; min-height: 36px; min-width: 0; width: 100%; padding: 5px 8px; font-weight: 400;
  }
  input[type=checkbox] { accent-color: var(--lf-accent); width: 16px; height: 16px; margin: 0; }
  label.check { display: flex; align-items: center; gap: 8px; }
  h1, h2, h3, p { margin: 0; }
  h2 { font-size: 22px; line-height: 1.25; }
  h3 { font-size: 18px; line-height: 1.3; }
  small, .muted { color: var(--lf-muted); font-weight: 400; }
  a { color: var(--lf-accent); }
  ha-icon { --mdc-icon-size: 18px; display: inline-flex; }
  .box { border: 1px solid var(--lf-border); border-radius: 10px; background: var(--lf-surface); }
  .error { color: var(--error-color, #ad302c); }
  .notice { padding: 10px 12px; border-inline-start: 3px solid var(--lf-accent); background: var(--lf-surface); }
  details { min-width: 0; }
  summary { cursor: pointer; font-weight: 650; }
`;
