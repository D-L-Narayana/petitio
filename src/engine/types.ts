/**
 * Petitio domain types. Everything here is synthetic and educational.
 * Dates are ISO-8601 calendar dates (YYYY-MM-DD) unless the field name ends in `At`,
 * in which case they are full ISO timestamps.
 */

export type Jurisdiction = 'EU-GDPR' | 'UK-GDPR' | 'US-CA-CCPA' | 'US-VA-VCDPA' | 'US-CO-CPA' | 'CA-PIPEDA';

export type RequestType = 'access' | 'erasure' | 'rectification' | 'portability' | 'opt-out-sale';

export type Stage =
  | 'received'
  | 'identity-check'
  | 'verified'
  | 'collecting'
  | 'review'
  | 'response-ready'
  | 'closed'
  | 'rejected';

/** Stages that accept no further actions. Shared by the engine, the session store and the UI. */
export const TERMINAL_STAGES: ReadonlySet<Stage> = new Set<Stage>(['closed', 'rejected']);
export function isTerminal(stage: Stage): boolean {
  return TERMINAL_STAGES.has(stage);
}

export type Action =
  | 'start-identity-check'
  | 'identity-passed'
  | 'identity-failed'
  | 'begin-collection'
  | 'record-system-result'
  | 'send-to-review'
  | 'apply-hold'
  | 'release-hold'
  | 'prepare-response'
  | 'close'
  | 'reject';

/** What the UI asks the engine to do: an action plus its optional payload and history note. */
export interface ActionRequest {
  action: Action;
  payload?: unknown;
  note?: string;
}

export type RejectReason = 'duplicate' | 'manifestly-unfounded' | 'identity-unverified' | 'out-of-scope';

export type HoldReason =
  | 'legal-hold'
  | 'ongoing-transaction'
  | 'fraud-prevention'
  | 'legal-obligation-retention'
  | 'third-party-rights';

export interface Hold {
  id: string;
  systemId: string;
  reason: HoldReason;
  note: string;
  appliedAt: string;
  releasedAt?: string;
}

export interface Requester {
  /** Stable pseudonym used for duplicate detection; never a real identity. */
  pseudonym: string;
  email: string; // synthetic *.example address
  accountId?: string;
  ageBand?: 'adult' | 'minor' | 'unknown';
}

export interface IdentityCheck {
  method: 'account-login' | 'email-loop' | 'document-upload' | 'none';
  attempts: number;
  maxAttempts: number;
  status: 'not-started' | 'pending' | 'passed' | 'failed';
}

export interface Extension {
  days: number;
  reason: string;
  notifiedOn: string; // YYYY-MM-DD
}

export interface FieldRecord {
  name: string;
  value: string;
  /** Marks a value that belongs to someone other than the requester (e.g. an agent's note about a spouse). */
  thirdParty?: boolean;
}

export interface SystemResult {
  systemId: string;
  found: boolean;
  recordId?: string;
  matchedBy?: Array<'email' | 'accountId' | 'pseudonym'>;
  fields: FieldRecord[];
  /** The system's own copy of the subject's email, used to detect identity conflicts. */
  subjectEmail?: string;
  lookedUpAt: string;
}

export interface Transition {
  at: string;
  from: Stage;
  to: Stage;
  action: Action;
  actor: string;
  note?: string;
}

export interface RightsRequest {
  id: string;
  receivedOn: string; // YYYY-MM-DD
  jurisdiction: Jurisdiction;
  type: RequestType;
  requester: Requester;
  stage: Stage;
  identity: IdentityCheck;
  extension?: Extension;
  holds: Hold[];
  systemResults: SystemResult[];
  history: Transition[];
  rejectReason?: RejectReason;
  closedOn?: string;
  notes: string[];
}

export interface SystemOfRecord {
  id: string;
  name: string;
  /** What kind of data this system holds; informs the response packet. */
  description: string;
}

export interface CaseFile {
  schema: 'petitio.casefile';
  version: 1;
  /** The date the demo clock is set to. Deadlines are computed relative to this. */
  asOf: string;
  systems: SystemOfRecord[];
  requests: RightsRequest[];
}

export interface JurisdictionProfile {
  id: Jurisdiction;
  label: string;
  /** How the statutory response window is measured. */
  window: { kind: 'calendar-months'; months: number } | { kind: 'calendar-days'; days: number };
  /** Maximum additional time that may be requested, and how many times. */
  extension: { kind: 'calendar-months'; months: number } | { kind: 'calendar-days'; days: number };
  /** Whether a requester must be told about an extension before the initial window ends. */
  extensionNoticeWithinInitialWindow: boolean;
  citation: string;
}

export type DeadlineStatus = 'on-track' | 'at-risk' | 'overdue' | 'closed' | 'rejected';

/** Whether a closed request met its effective due date. */
export type ClosureOutcome = 'on-time' | 'late';

export interface DeadlineOptions {
  /** Days before the effective due date that count as at-risk; defaults to AT_RISK_DAYS (5). */
  atRiskDays?: number;
}

export interface DeadlineAssessment {
  statutoryDueOn: string;
  effectiveDueOn: string;
  extended: boolean;
  daysRemaining: number;
  daysElapsed: number;
  totalWindowDays: number;
  status: DeadlineStatus;
  /** 0..1 fraction of the effective window that has elapsed, clamped. */
  progress: number;
  /** Last day on which an extension notice may be given; equals statutoryDueOn for profiles that require notice inside the initial window. */
  noticeDeadlineOn?: string;
  /** Closed requests only: closedOn <= effectiveDueOn → 'on-time', otherwise 'late'. */
  closureOutcome?: ClosureOutcome;
  /** Closed-late requests only: whole days between effectiveDueOn and closedOn. */
  daysLateAtClose?: number;
}

/** Explains, before the analyst clicks, whether an extension can still be recorded as of a given date. */
export interface ExtensionEligibility {
  eligible: boolean;
  code?: Extract<WorkflowErrorCode, 'ALREADY_EXTENDED' | 'EXTENSION_TOO_LATE' | 'EXTENSION_NOT_ALLOWED'>;
  /** Human sentence in the same voice as WorkflowError messages. */
  reason?: string;
  noticeDeadlineOn: string;
  maxDays: number;
}

export type DocketSort = 'urgency' | 'received' | 'due' | 'id';

export interface DocketFilters {
  jurisdiction: string;
  type: string;
  status: string;
  /** Free-text search over id, pseudonym, email and account id. */
  query: string;
  sort: DocketSort;
}

export interface DocketSummary {
  total: number;
  visible: number;
  byStatus: Record<DeadlineStatus, number>;
  duplicates: number;
}

export type WorkflowErrorCode =
  | 'INVALID_TRANSITION'
  | 'UNRESOLVED_HOLDS'
  | 'IDENTITY_NOT_VERIFIED'
  | 'IDENTITY_ATTEMPTS_EXHAUSTED'
  | 'MISSING_SYSTEM_RESULTS'
  | 'MISSING_REJECT_REASON'
  | 'HOLD_NOT_FOUND'
  | 'EXTENSION_TOO_LATE'
  | 'EXTENSION_TOO_LONG'
  | 'ALREADY_EXTENDED'
  | 'INVALID_EXTENSION_INPUT'
  /** A systemId that is not one of the case file's systems of record. */
  | 'UNKNOWN_SYSTEM'
  /** An active hold already exists on that system; release it first. */
  | 'DUPLICATE_HOLD'
  /** The action payload has the wrong shape (previously reported as INVALID_TRANSITION). */
  | 'INVALID_PAYLOAD'
  /** The request is in a terminal stage and cannot be extended. */
  | 'EXTENSION_NOT_ALLOWED';

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  requestId: string;
  action: string;
  detail: string;
  prevHash: string;
  hash: string;
}

/** Envelope for an exported audit log so a file can be re-imported and its chain verified. */
export interface AuditLogFile {
  schema: 'petitio.auditlog';
  version: 1;
  exportedAt: string;
  entries: AuditEntry[];
}

export interface Redaction {
  systemId: string;
  field: string;
  reason: 'third-party-data' | 'identity-conflict';
}

export interface Exclusion {
  systemId: string;
  reason: HoldReason;
  note: string;
}

/** What the response packet proposes per system, derived from the request type and the reconciliation outcome. */
export type PacketAction = 'disclose' | 'export' | 'erase' | 'rectify' | 'opt-out' | 'retain' | 'withhold';

export interface PacketActionItem {
  systemId: string;
  action: PacketAction;
  reason?: string;
}

export interface ResponsePacket {
  requestId: string;
  type: RequestType;
  generatedOn: string;
  disclosures: Array<{ systemId: string; recordId?: string; fields: FieldRecord[] }>;
  redactions: Redaction[];
  exclusions: Exclusion[];
  conflicts: string[];
  partial: boolean;
  /** Right-aware per-system actions (simulated; nothing is executed). */
  actions?: PacketActionItem[];
  /** One-sentence operational summary of the packet. */
  summary?: string;
}
