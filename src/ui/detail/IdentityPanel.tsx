import type { IdentityCheck, RightsRequest } from '../../engine/types';

export interface IdentityPanelProps {
  request: RightsRequest;
}

const STATUS_TAG: Record<IdentityCheck['status'], string> = {
  passed: 'tag tag-green',
  failed: 'tag tag-red',
  pending: 'tag tag-amber',
  'not-started': 'tag',
};

/** "Identity proofing": the simulated check's method, attempts and status, plus the requester's account facts. */
export function IdentityPanel({ request }: IdentityPanelProps) {
  const id = request.identity;
  return (
    <section className="panel" aria-labelledby="identity-title">
      <header><h3 id="identity-title">Identity proofing</h3><span className={STATUS_TAG[id.status]}>{id.status}</span></header>
      <div className="panel-body">
        <table>
          <tbody>
            <tr><th scope="row">Method</th><td>{id.method}</td></tr>
            <tr><th scope="row">Attempts</th><td>{id.attempts} of {id.maxAttempts}</td></tr>
            <tr><th scope="row">Account id</th><td className="mono">{request.requester.accountId ?? '—'}</td></tr>
            <tr><th scope="row">Age band</th><td>{request.requester.ageBand ?? 'unknown'}</td></tr>
          </tbody>
        </table>
        <p className="identity-note">
          Identity proofing is simulated: no email is sent and no document is read. The engine only enforces that lookups cannot begin before a pass is recorded.
        </p>
      </div>
    </section>
  );
}
