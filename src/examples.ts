import type { Content } from './types';

export const BLANK: Content = {
 schema: 1, title: 'My UAT release',
 roles: [{ key: 'tester', label: 'Tester', description: 'Describe who this role represents in the application under test.' }],
 scenarios: [{ id: 'S1', title: 'First scenario', goal: 'What the tester should achieve', steps: [{ id: 'S1-1', text: 'Describe the action to perform.', expect: 'Describe what should happen.', roles: ['tester'] }] }]
};

const ref = (field: string) => ({ type: 'ref' as const, field });
const lit = (value: string) => ({ type: 'literal' as const, value });

export const ACME_CLAIMS: Content = {
 schema: 1, title: 'Acme Insurance claims portal — UAT',
 roles: [
  { key: 'claimant', label: 'Claimant', description: 'A policyholder reporting a loss.' },
  { key: 'adjuster', label: 'Claims adjuster', description: 'Reviews and decides on claims.' }
 ],
 statuses: [
  { key: 'pass', label: 'Looks good', kind: 'pass' }, { key: 'issue', label: 'Issue', kind: 'fail', needsNote: true },
  { key: 'known', label: 'Known issue', kind: 'info', needsNote: true, needsReference: 'number' },
  { key: 'question', label: 'Question', kind: 'info', needsNote: true }, { key: 'blocked', label: 'Blocked', kind: 'blocked', needsNote: true }
 ],
 phases: [{ key: 'day2', label: 'Next-day follow-up', offsetDays: 1 }],
 fixtures: [
  { key: 'policyholder', label: 'Your policyholder', scope: 'tester', description: 'Enter exactly as shown. Created once per tester.', fields: [
   { key: 'name', label: 'Full name', rule: { type: 'concat', parts: [{ type: 'namespace' }, lit(' '), { type: 'instance', pad: 2 }, lit(' Policyholder')] } },
   { key: 'policy', label: 'Policy number', rule: { type: 'concat', parts: [lit('POL-'), { type: 'instance', pad: 3 }, lit('-'), { type: 'int', min: 1000, max: 9999 }] } },
   { key: 'lossDate', label: 'Date of loss', rule: { type: 'date', anchor: 'created', offsetDays: -3, format: 'MM/DD/YYYY' } },
   { key: 'amount', label: 'Estimated amount', rule: { type: 'concat', parts: [lit('$'), { type: 'int', min: 500, max: 4500 }] } },
   { key: 'followUp', label: 'Follow-up date', phase: 'day2', rule: { type: 'date', anchor: 'phase:day2', offsetDays: 2, format: 'MM/DD/YYYY' } }
  ] },
  { key: 'claim', label: 'The claim you file', scope: 'shared', description: 'Created by the claimant and reviewed by an adjuster.', fields: [
   { key: 'title', label: 'Claim title', rule: { type: 'concat', parts: [lit('Water damage '), { type: 'namespace' }, lit(' '), { type: 'instance', pad: 2 }] } },
   { key: 'description', label: 'Description', rule: { type: 'pick', items: ['Burst pipe in the kitchen', 'Roof leak in the hallway', 'Washing machine overflow'] } }
  ], captures: [{ key: 'claimNumber', label: 'Claim number shown by the portal' }] }
 ],
 handoffs: [{ key: 'claim-filed', label: 'Claim filed by claimant', fixture: 'claim', producerRoles: ['claimant'], consumerRoles: ['adjuster'] }],
 documents: [{ key: 'claim-summary', title: 'Claim summary (generated)', kind: 'generated', roles: ['claimant', 'adjuster'], recipe: { title: 'Claim summary', subtitle: 'Prepared from the synthetic UAT values', rows: [
  { label: 'Policyholder', value: '{{policyholder.name}}' }, { label: 'Policy number', value: '{{policyholder.policy}}' }, { label: 'Date of loss', value: '{{policyholder.lossDate}}' },
  { label: 'Claim', value: '{{claim.title}}' }, { label: 'Description', value: '{{claim.description}}' }, { label: 'Estimated amount', value: '{{policyholder.amount}}' }], footer: 'For UAT only.' } }],
 scenarios: [
  { id: 'C1', title: 'File a claim', goal: 'Report a loss and receive a claim number', before: 'Use the values on your data card. Your policyholder is {{policyholder.name}}.', steps: [
   { id: 'C1-1', text: 'Sign in to the portal and start a new claim for policy {{policyholder.policy}}.', expect: 'The policy is recognised and the claim form opens.', roles: ['claimant'] },
   { id: 'C1-2', text: 'Enter the date of loss {{policyholder.lossDate}}, title "{{claim.title}}" and description "{{claim.description}}". Submit the claim.', expect: 'A claim number is displayed. Capture it below.', roles: ['claimant'], docs: ['claim-summary'] }
  ] },
  { id: 'C2', title: 'Review a claim', goal: 'Review the claimant\'s claim', steps: [
   { id: 'C2-1', text: 'Open the claim titled "{{claim.title}}" in the adjuster queue and check that the details match {{claim.description}}.', expect: 'The claim details are complete and correct.', roles: ['adjuster'], requires: ['claim-filed'], docs: ['claim-summary'] },
   { id: 'C2-2', text: 'Approve an estimate of {{policyholder.amount}} for the claim.', expect: 'The claim moves to Approved and the claimant is notified.', roles: ['adjuster'], requires: ['claim-filed'] }
  ] },
  { id: 'C3', title: 'Next-day follow-up', goal: 'Check the claim status the day after', steps: [
   { id: 'C3-1', text: 'Open your claim and confirm the follow-up date {{policyholder.followUp}} is shown.', expect: 'The claim is still listed and shows the follow-up date.', roles: ['claimant'], phase: 'day2' }
  ] }
 ]
};
void ref;

export const NORTHWIND: Content = {
 schema: 1, title: 'Northwind Clinic scheduling — UAT',
 roles: [{ key: 'front-desk', label: 'Front desk' }, { key: 'nurse', label: 'Nurse' }],
 statuses: [
  { key: 'works', label: 'Works', kind: 'pass' }, { key: 'defect', label: 'Defect', kind: 'fail', needsNote: true },
  { key: 'query', label: 'Query', kind: 'info', needsNote: true }, { key: 'blocked', label: 'Blocked', kind: 'blocked', needsNote: true }
 ],
 fixtures: [{ key: 'patient', label: 'Test patient', scope: 'tester', fields: [
  { key: 'first', label: 'First name', rule: { type: 'concat', parts: [lit('Test'), { type: 'instance', pad: 2 }] } },
  { key: 'last', label: 'Last name', rule: lit('Patient') },
  { key: 'dob', label: 'Date of birth', rule: { type: 'date', anchor: 'campaignStart', offsetDays: -12000, format: 'YYYY-MM-DD' } },
  { key: 'visit', label: 'Visit date', rule: { type: 'date', anchor: 'created', weekday: 1, format: 'YYYY-MM-DD' } }
 ] }],
 documents: [{ key: 'referral', title: 'Referral letter (generated)', kind: 'generated', roles: ['front-desk', 'nurse'], recipe: { title: 'Referral letter', rows: [{ label: 'Patient', value: '{{patient.first}} {{patient.last}}' }, { label: 'Date of birth', value: '{{patient.dob}}' }, { label: 'Visit', value: '{{patient.visit}}' }] } }],
 scenarios: [
  { id: 'A', title: 'Book an appointment', steps: [
   { id: 'A-1', text: 'Register patient {{patient.first}} {{patient.last}}, born {{patient.dob}}.', expect: 'The patient appears in search.', roles: ['front-desk'] },
   { id: 'A-2', text: 'Book a visit on {{patient.visit}}.', expect: 'The appointment is listed on the calendar.', roles: ['front-desk'], docs: ['referral'] }
  ] },
  { id: 'B', title: 'Prepare for the visit', steps: [{ id: 'B-1', text: 'Open the chart for {{patient.first}} {{patient.last}} and record vitals.', expect: 'Vitals are saved to the chart.', roles: ['nurse'] }] }
 ]
};
export const EXAMPLES: Record<string, { label: string; content: Content }> = {
 blank: { label: 'Blank template', content: BLANK },
 'acme-claims': { label: 'Example: Acme Insurance claims (handoffs, phases, generated PDF)', content: ACME_CLAIMS },
 northwind: { label: 'Example: Northwind Clinic scheduling (simple)', content: NORTHWIND }
};
