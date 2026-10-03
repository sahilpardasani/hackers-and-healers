// SMART on FHIR standalone launch using the official fhirclient library.
// fhirclient handles PKCE, state, token exchange and pagination.
import FHIR from 'fhirclient';

export const SERVERS = [
  {
    id: 'smart',
    label: 'SMART Health IT sandbox (no registration)',
    iss: 'https://launch.smarthealthit.org/v/r4/fhir',
    clientId: 'patient-agency-demo'
  },
  {
    id: 'epic',
    label: 'Epic sandbox (MyChart test users)',
    iss: 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4',
    clientId: import.meta.env?.VITE_EPIC_CLIENT_ID || ''
  }
];

export const SCOPES = [
  'openid', 'fhirUser', 'launch/patient',
  'patient/Patient.read', 'patient/Observation.read', 'patient/Condition.read',
  'patient/MedicationRequest.read', 'patient/Medication.read', 'patient/AllergyIntolerance.read'
].join(' ');

const redirectUri = () =>
  import.meta.env?.VITE_REDIRECT_URI || window.location.origin + window.location.pathname;

export function isReturningFromAuth() {
  const p = new URLSearchParams(window.location.search);
  return p.has('code') && p.has('state');
}

export function connect(serverId) {
  const s = SERVERS.find(x => x.id === serverId);
  if (!s) throw new Error('Unknown server');
  if (!s.clientId) throw new Error('Missing client ID. Set VITE_EPIC_CLIENT_ID in .env.local');
  sessionStorage.setItem('patient-agency.server', s.label);
  return FHIR.oauth2.authorize({ clientId: s.clientId, scope: SCOPES, iss: s.iss, redirectUri: redirectUri(), pkceMode: 'ifSupported' });
}

// Resource queries Patient Agency needs (see PRD section 6.1). Each failure is isolated.
const QUERIES = pid => [
  `Observation?patient=${pid}&category=vital-signs&_count=200`,
  `Observation?patient=${pid}&category=laboratory&_count=200`,
  `Condition?patient=${pid}`,
  `MedicationRequest?patient=${pid}`,
  `AllergyIntolerance?patient=${pid}`
];

// Memoized so React StrictMode's double effect doesn't exchange the auth code twice
let pending = null;
export function completeAuthAndFetch() {
  if (!pending) pending = doCompleteAuthAndFetch().finally(() => { setTimeout(() => { pending = null; }, 0); });
  return pending;
}

async function doCompleteAuthAndFetch() {
  const client = await FHIR.oauth2.ready();
  const pid = client.patient.id;
  const patient = await client.patient.read();
  const results = await Promise.allSettled(
    QUERIES(pid).map(q => client.request(q, { pageLimit: 0, flat: true }))
  );
  const resources = [patient];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') resources.push(...(r.value || []));
    else errors.push(QUERIES(pid)[i].split('?')[0]);
  });
  // Clean the auth code out of the URL (tokens stay in fhirclient's sessionStorage, never logged)
  window.history.replaceState({}, '', window.location.pathname);
  return { resources, errors, source: sessionStorage.getItem('patient-agency.server') || 'Health record' };
}
