import { useState, type FormEvent } from 'react';
import type { FieldRecord, SystemOfRecord, SystemResult } from '../../engine/types';

export interface RecordResultFormProps {
  /** Systems still without a result; the first one is preselected. */
  systems: SystemOfRecord[];
  asOf: string;
  onSubmit: (result: SystemResult) => void;
}

const EMPTY_FIELD: FieldRecord = { name: '', value: '' };

/** Records one simulated lookup result: nothing is queried, the analyst types what the system "returned". */
export function RecordResultForm({ systems, asOf, onSubmit }: RecordResultFormProps) {
  const [systemId, setSystemId] = useState(systems[0]?.id ?? '');
  const [found, setFound] = useState(true);
  const [recordId, setRecordId] = useState('');
  const [subjectEmail, setSubjectEmail] = useState('');
  const [fields, setFields] = useState<FieldRecord[]>([EMPTY_FIELD]);
  // The chosen system may have been recorded since (the list shrinks); fall back to the first outstanding one.
  const effectiveSystem = systems.some((s) => s.id === systemId) ? systemId : (systems[0]?.id ?? '');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!effectiveSystem) return;
    const cleanFields = fields.filter((f) => f.name.trim()).map((f) => ({ name: f.name.trim(), value: f.value, ...(f.thirdParty ? { thirdParty: true } : {}) }));
    const result: SystemResult = {
      systemId: effectiveSystem,
      found,
      fields: found ? cleanFields : [],
      lookedUpAt: `${asOf}T12:00:00Z`,
      ...(found && recordId.trim() ? { recordId: recordId.trim() } : {}),
      ...(found && subjectEmail.trim() ? { subjectEmail: subjectEmail.trim() } : {}),
    };
    onSubmit(result);
    setRecordId('');
    setSubjectEmail('');
    setFields([EMPTY_FIELD]);
  }

  function updateField(index: number, patch: Partial<FieldRecord>) {
    setFields(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }

  return (
    <form className="form" onSubmit={submit} aria-label="Record a simulated system lookup">
      <fieldset>
        <legend>Record a lookup result (simulated — nothing is queried)</legend>
        <div className="form-inline">
          <div className="form-row">
            <label htmlFor="res-system">System</label>
            <select id="res-system" value={effectiveSystem} onChange={(e) => setSystemId(e.target.value)}>{systems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </div>
          <div className="form-row">
            <label htmlFor="res-found">Outcome</label>
            <select id="res-found" value={found ? 'found' : 'none'} onChange={(e) => setFound(e.target.value === 'found')}>
              <option value="found">Record found</option>
              <option value="none">No record</option>
            </select>
          </div>
          {found && (
            <>
              <div className="form-row">
                <label htmlFor="res-record">Record id</label>
                <input id="res-record" value={recordId} onChange={(e) => setRecordId(e.target.value)} placeholder="tickets-10431" />
              </div>
              <div className="form-row">
                <label htmlFor="res-email">Subject email on file</label>
                <input id="res-email" value={subjectEmail} onChange={(e) => setSubjectEmail(e.target.value)} placeholder="name@people.example" />
              </div>
            </>
          )}
        </div>
        {found && (
          <div className="field-list fieldset-gap">
            {fields.map((f, i) => (
              <div className="field-list-row" key={i}>
                <input aria-label={`Field ${i + 1} name`} value={f.name} onChange={(e) => updateField(i, { name: e.target.value })} placeholder="field name" />
                <input aria-label={`Field ${i + 1} value`} value={f.value} onChange={(e) => updateField(i, { value: e.target.value })} placeholder="value (synthetic)" />
                <label className="check"><input type="checkbox" checked={Boolean(f.thirdParty)} onChange={(e) => updateField(i, { thirdParty: e.target.checked })} /> third party</label>
                <button type="button" className="btn btn-sm" onClick={() => setFields(fields.length === 1 ? [EMPTY_FIELD] : fields.filter((_, j) => j !== i))} aria-label={`Remove field ${i + 1}`}>Remove</button>
              </div>
            ))}
            <div><button type="button" className="btn btn-sm" onClick={() => setFields([...fields, EMPTY_FIELD])}>Add field</button></div>
          </div>
        )}
        <div className="form-actions fieldset-gap">
          <button type="submit" className="btn btn-primary">Record result</button>
        </div>
      </fieldset>
    </form>
  );
}
