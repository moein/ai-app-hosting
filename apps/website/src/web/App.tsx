import { WEBSITE_APP_DESCRIPTION_MAX_CHARS } from '@repo/shared/limits';
import { useEffect, useId, useState } from 'react';
import { CLAUDE_STEPS } from './claude-steps';
import { type Audience, buildPrompt } from './prompt';

export type Config = { mcpUrl: string; connectorName: string };
type Step = 'ai' | 'connect' | 'describe' | 'prompt';
const STEPS: { id: Step; label: string }[] = [
  { id: 'ai', label: 'Your AI' },
  { id: 'connect', label: 'Connect' },
  { id: 'describe', label: 'Your app' },
  { id: 'prompt', label: 'Your prompt' },
];

const AIS = [
  { id: 'claude', name: 'Claude', available: true },
  { id: 'chatgpt', name: 'ChatGPT', available: false },
  { id: 'gemini', name: 'Gemini', available: false },
  { id: 'other', name: 'Something else', available: false },
] as const;

const stepFromHash = (): Step => {
  const id = window.location.hash.replace(/^#\/?/, '');
  return STEPS.some((s) => s.id === id) ? (id as Step) : 'ai';
};

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="button secondary small"
      onClick={async () => {
        await copy(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? 'Copied ✓' : label}
    </button>
  );
}

function Progress({ current }: { current: Step }) {
  const index = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="progress" aria-label="Progress">
      {STEPS.map((step, i) => (
        <li
          key={step.id}
          className={i < index ? 'done' : i === index ? 'current' : ''}
          aria-current={i === index ? 'step' : undefined}
        >
          <span className="dot">{i < index ? '✓' : i + 1}</span>
          <span className="label">{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

export function App({ loadConfig = defaultLoadConfig }: { loadConfig?: () => Promise<Config> }) {
  const [step, setStepState] = useState<Step>(stepFromHash);
  const [config, setConfig] = useState<Config | null>(null);
  const [description, setDescription] = useState('');
  const [audience, setAudience] = useState<Audience>('me');
  const [touched, setTouched] = useState(false);
  const descriptionId = useId();

  useEffect(() => {
    loadConfig().then(setConfig, () => setConfig(null));
  }, [loadConfig]);
  useEffect(() => {
    const onHash = () => setStepState(stepFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const setStep = (next: Step) => {
    setStepState(next);
    window.location.hash = `/${next}`;
    window.scrollTo?.({ top: 0 });
  };

  // The prompt needs an app description; deep links past the form go back to it.
  const shown: Step = step === 'prompt' && !description.trim() ? 'describe' : step;
  const tooLong = description.length > WEBSITE_APP_DESCRIPTION_MAX_CHARS;
  const invalid = !description.trim() || tooLong;
  const connectorName = config?.connectorName ?? 'AI App Hosting';

  return (
    <div className="page">
      <header className="header">
        <span className="logo" aria-hidden="true">
          ▲
        </span>
        <span className="brand">AI App Hosting</span>
      </header>
      <main className="card">
        <Progress current={shown} />

        {shown === 'ai' && (
          <section aria-labelledby="ai-title">
            <h1 id="ai-title">Build your own app just by chatting with your AI</h1>
            <p className="lead">
              Tell your AI what you want. It writes the app, and we put it online for you — no technical knowledge
              needed. First, which AI do you use?
            </p>
            <div className="choices">
              {AIS.map((ai) => (
                <button
                  key={ai.id}
                  type="button"
                  className="choice"
                  disabled={!ai.available}
                  onClick={() => setStep('connect')}
                >
                  <span className="choice-name">{ai.name}</span>
                  <span className="soon">{ai.available ? 'Choose →' : 'Coming soon'}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {shown === 'connect' && (
          <section aria-labelledby="connect-title">
            <h1 id="connect-title">Connect Claude to us</h1>
            <p className="lead">You only do this once. It takes about a minute.</p>
            <ol className="instructions">
              {CLAUDE_STEPS.map((s, i) => (
                <li key={s.title}>
                  <h2>
                    <span className="number">{i + 1}</span> {s.title}
                  </h2>
                  <p>{s.text}</p>
                  {s.showConnectorDetails && (
                    <dl className="details">
                      <div>
                        <dt>Name</dt>
                        <dd>
                          <code>{connectorName}</code>
                          <CopyButton text={connectorName} label="Copy name" />
                        </dd>
                      </div>
                      <div>
                        <dt>Address (URL)</dt>
                        <dd>
                          <code>{config?.mcpUrl ?? 'Loading…'}</code>
                          {config && <CopyButton text={config.mcpUrl} label="Copy address" />}
                        </dd>
                      </div>
                    </dl>
                  )}
                  {s.image && (
                    <img
                      className="screenshot"
                      src={s.image.src}
                      width={s.image.width}
                      height={s.image.height}
                      alt={s.image.alt}
                      loading="lazy"
                    />
                  )}
                </li>
              ))}
            </ol>
            <div className="actions">
              <button type="button" className="button secondary" onClick={() => setStep('ai')}>
                Back
              </button>
              <button type="button" className="button" onClick={() => setStep('describe')}>
                Done, it's connected
              </button>
            </div>
          </section>
        )}

        {shown === 'describe' && (
          <section aria-labelledby="describe-title">
            <h1 id="describe-title">What app do you want?</h1>
            <p className="lead">Describe it in your own words: what it does, and what people can do with it.</p>
            <label className="field-label" htmlFor={descriptionId}>
              Your app
            </label>
            <textarea
              id={descriptionId}
              className="textarea"
              rows={7}
              value={description}
              placeholder="For example: a shared shopping list for my family. Anyone can add items, tick them off when bought, and see who added what."
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={touched && invalid}
              aria-describedby={`${descriptionId}-help`}
            />
            <p id={`${descriptionId}-help`} className={`help ${touched && invalid ? 'error' : ''}`}>
              {tooLong
                ? `Please keep it under ${WEBSITE_APP_DESCRIPTION_MAX_CHARS} characters.`
                : touched && !description.trim()
                  ? 'Tell us a little about your app first.'
                  : `${description.length} / ${WEBSITE_APP_DESCRIPTION_MAX_CHARS}`}
            </p>
            <fieldset className="audience">
              <legend className="field-label">Who will use it?</legend>
              <div className="toggle" role="radiogroup">
                {(
                  [
                    ['me', 'Only me'],
                    ['many', 'Several people'],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value} className={audience === value ? 'selected' : ''}>
                    <input
                      type="radio"
                      name="audience"
                      value={value}
                      checked={audience === value}
                      onChange={() => setAudience(value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="actions">
              <button type="button" className="button secondary" onClick={() => setStep('connect')}>
                Back
              </button>
              <button type="button" className="button" disabled={invalid} onClick={() => setStep('prompt')}>
                Create my prompt
              </button>
            </div>
          </section>
        )}

        {shown === 'prompt' && (
          <section aria-labelledby="prompt-title">
            <h1 id="prompt-title">Your prompt is ready</h1>
            <p className="lead">
              Copy it, open a new chat in Claude, paste it and send. Claude will ask for your email and a code we send
              you, then build your app and give you its link.
            </p>
            <pre className="prompt" data-testid="prompt">
              {buildPrompt({ description, audience, connectorName })}
            </pre>
            <div className="actions">
              <CopyButton text={buildPrompt({ description, audience, connectorName })} label="Copy prompt" />
              <a className="button" href="https://claude.ai/new" target="_blank" rel="noreferrer">
                Open Claude ↗
              </a>
            </div>
            <div className="actions">
              <button type="button" className="button secondary" onClick={() => setStep('describe')}>
                Back
              </button>
              <button
                type="button"
                className="link"
                onClick={() => {
                  setDescription('');
                  setAudience('me');
                  setTouched(false);
                  setStep('ai');
                }}
              >
                Start over
              </button>
            </div>
          </section>
        )}
      </main>
      <footer className="footer">Your description stays in your browser — we don't store it.</footer>
    </div>
  );
}

async function defaultLoadConfig(): Promise<Config> {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error(`config ${response.status}`);
  return (await response.json()) as Config;
}
