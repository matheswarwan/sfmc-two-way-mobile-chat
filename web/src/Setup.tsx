import { useCallback, useEffect, useState } from 'react';

type StepState = 'ok' | 'missing' | 'error' | 'manual' | 'unknown';

interface SetupStep {
  id: string;
  title: string;
  automatable: boolean;
  state: StepState;
  detail: string;
  instructions?: string[];
  docsUrl?: string;
}

interface SetupStatus {
  mode: string;
  steps: SetupStep[];
  config: Record<string, string | null>;
}

const STATE_LABEL: Record<StepState, string> = {
  ok: 'Ready',
  missing: 'Not created',
  error: 'Error',
  manual: 'Manual step',
  unknown: 'Unverified',
};

export function Setup(): JSX.Element {
  const [status, setStatus] = useState<SetupStatus | undefined>();
  const [ampscript, setAmpscript] = useState('');
  const [busy, setBusy] = useState<string | undefined>();
  const [log, setLog] = useState<string[]>([]);
  const [verifyNumber, setVerifyNumber] = useState('');
  const [copied, setCopied] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    const [statusRes, ampRes] = await Promise.all([
      fetch('/api/setup/status').then((r) => r.json() as Promise<SetupStatus>),
      fetch('/api/setup/ampscript').then((r) => r.json() as Promise<{ ampscript: string }>),
    ]);
    setStatus(statusRes);
    setAmpscript(ampRes.ampscript);
  }, []);

  useEffect(() => {
    void refresh().catch((e) => note(`Could not load status: ${String(e)}`));
  }, [refresh]);

  /** Green steps collapse; anything still needing attention stays open. */
  function isOpen(step: SetupStep): boolean {
    return overrides[step.id] ?? step.state !== 'ok';
  }

  function toggle(step: SetupStep): void {
    setOverrides((prev) => ({ ...prev, [step.id]: !isOpen(step) }));
  }

  function note(message: string): void {
    setLog((prev) => [`${new Date().toLocaleTimeString()}  ${message}`, ...prev].slice(0, 20));
  }

  async function provision(stepId: string): Promise<void> {
    setBusy(stepId);
    try {
      const result = (await fetch(`/api/setup/provision/${stepId}`, { method: 'POST' }).then((r) =>
        r.json(),
      )) as { ok?: boolean; detail?: string; error?: string };
      note(result.detail ?? result.error ?? 'No response');
      await refresh();
    } catch (error) {
      note(`Failed: ${String(error)}`);
    } finally {
      setBusy(undefined);
    }
  }

  async function verifyInbound(): Promise<void> {
    const mobileNumber = verifyNumber.trim();
    if (!mobileNumber) return;

    setBusy('verify');
    note('Replaying an inbound message and waiting for it to arrive...');
    try {
      const result = (await fetch('/api/setup/verify-inbound', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobileNumber }),
      }).then((r) => r.json())) as { ok?: boolean; detail?: string; error?: string };
      note(result.detail ?? result.error ?? 'No response');
    } catch (error) {
      note(`Failed: ${String(error)}`);
    } finally {
      setBusy(undefined);
    }
  }

  async function copyAmpscript(): Promise<void> {
    try {
      await navigator.clipboard.writeText(ampscript);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      note('Clipboard blocked. Select the text and copy manually.');
    }
  }

  if (!status) return <div className="setup"><p className="empty">Loading setup status...</p></div>;

  return (
    <div className="setup">
      <header className="setup-header">
        <h2>Setup</h2>
        <div>
          <span className={`mode mode-${status.mode}`}>{status.mode} mode</span>
          <button type="button" onClick={() => void refresh()}>Refresh</button>
        </div>
      </header>

      {status.mode !== 'live' && (
        <p className="notice">
          Running in mock mode. Status is not checked against a real tenant and provisioning only
          pretends to create things. Set SFMC_MODE=live in .env to work against your account.
        </p>
      )}

      <ol className="steps">
        {status.steps.map((step) => (
          <li key={step.id} className={`step step-${step.state}`}>
            <div className="step-head">
              <button
                type="button"
                className="step-toggle"
                aria-expanded={isOpen(step)}
                onClick={() => toggle(step)}
              >
                <span className={`chevron ${isOpen(step) ? 'open' : ''}`} aria-hidden="true">
                  &#9656;
                </span>
                <span className={`pill pill-${step.state}`}>{STATE_LABEL[step.state]}</span>
                <span className="step-title">{step.title}</span>
              </button>
              {step.automatable && step.state !== 'ok' && (
                <button
                  type="button"
                  disabled={busy !== undefined}
                  onClick={() => void provision(step.id)}
                >
                  {busy === step.id ? 'Working...' : 'Create for me'}
                </button>
              )}
            </div>

            {isOpen(step) && (
              <div className="step-body">
                <p className="detail">{step.detail}</p>

                {step.instructions && (
                  <ol className="instructions">
                    {step.instructions.map((instruction) => (
                      <li key={instruction}>{instruction}</li>
                    ))}
                  </ol>
                )}

                {step.docsUrl && (
                  <a href={step.docsUrl} target="_blank" rel="noreferrer" className="docs">
                    Salesforce documentation
                  </a>
                )}

                {step.id === 'text-response' && (
                  <div className="ampscript">
                    <div className="ampscript-head">
                      <strong>Paste this into the response body</strong>
                      <button type="button" onClick={() => void copyAmpscript()}>
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <pre>{ampscript}</pre>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>

      <section className="verify">
        <h3>Verify inbound</h3>
        <p className="detail">
          Replays an inbound message against your short code and waits for it to reach the app. This
          checks the Text Response message, which is the one part that cannot be created for you.
        </p>
        <div className="verify-row">
          <input
            value={verifyNumber}
            onChange={(e) => setVerifyNumber(e.target.value)}
            placeholder="A mobile number subscribed to your code"
            aria-label="Mobile number for verification"
          />
          <button
            type="button"
            disabled={busy !== undefined || !verifyNumber.trim()}
            onClick={() => void verifyInbound()}
          >
            {busy === 'verify' ? 'Checking...' : 'Run verification'}
          </button>
        </div>
      </section>

      {log.length > 0 && (
        <section className="log">
          <h3>Activity</h3>
          <ul>
            {log.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
