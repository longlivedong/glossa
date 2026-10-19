// Shared data shapes. Every module reads and writes these; change them only here.

/** @typedef {'critical'|'high'|'standard'|'low'} Tier */
/** @typedef {'safety'|'legal'|'regulated'|'brand'|'product'|'ui'|'commerce'|'category'|'marketing'|'generic'|'code'} TermType */
/** @typedef {'pending'|'accepted'|'edited'|'rejected'|'asked_client'|'escalated'} Status */
/** @typedef {'queue'|'random_check'|'auto'} Bucket */
/** @typedef {'hard'|'guidance'} Enforcement */
/** @typedef {'all'|'legal_safety'|'marketing'} Scope */
/** @typedef {'critical'|'reopened'|'import_disagrees'|'high_low_conf'|'high_sample'|'low_low_conf'|null} Floor */

/**
 * @typedef {Object} Decision
 * @property {'accept'|'edit'|'reject'|'ask_client'} action
 * @property {Bucket} bucket            bucket the concept was in when decided (keeps it there when the line moves)
 * @property {string} at                ISO timestamp
 * @property {string} [newText]         edit: the linguist's rendering
 * @property {string} [previousText]    edit: the drafter's rendering it replaced
 * @property {boolean} [applyToConcept] edit: applies to all variants
 * @property {number} [variantCount]    edit: forms covered (variants + source) when applyToConcept
 * @property {string} [reason]          reject: one of REJECT_REASONS
 * @property {string} [note]            reject: free text when reason is 'other'
 * @property {string} [question]        ask_client: the question sent
 */

/**
 * @typedef {Object} Concept
 * @property {string} id                       'c_0001'
 * @property {string} source                   canonical source term (en)
 * @property {string[]} variants               other surface forms clustered into this concept
 * @property {TermType} termType
 * @property {Tier} tier
 * @property {string} tierReason               one line, shown on hover/tap of the tier badge
 * @property {boolean} [tierForced]            tier came from the imported CSV `tier` column
 * @property {number} frequency                occurrences across crawled pages (counted in code)
 * @property {string[]} pages                  URLs (or paths) where the term was seen
 * @property {{text: string, reason: string}} proposal   drafter's rendering (updated by an edit)
 * @property {string[]} renderings             the 3 drafter phrasings; [0] is the original proposal
 * @property {number} confidence               judge score 0..1 after calibration in code (rules.calibrateConfidence)
 * @property {number} [judgeConfidence]        the judge's raw score before calibration (live runs)
 * @property {{importedAgrees: boolean|null, siblingAgrees: boolean|null, styleFit: boolean, selfConsistent: boolean, blindAgrees?: boolean|null, clearMeaning?: boolean}} judgeChecks
 *                                             null = check not applicable (no import / no sibling)
 * @property {string} judgeNote                judge's one-line explanation
 * @property {string|null} [judgeOwn]          the term the judge would have written itself (live runs)
 * @property {boolean} [doNotTranslate]        every draft kept it as in the source, so tier was set to Low
 * @property {{text: string, sourceName: string}|null} imported
 * @property {{locale: string, text: string}|null} sibling
 * @property {string[]} context                2–3 sentences from the site containing the term
 * @property {Enforcement} enforcement
 * @property {Scope} scope
 * @property {Bucket} bucket
 * @property {Floor} floor                     why it is forced into the queue, or null
 * @property {boolean} reopened                pulled back from auto-approved by a linguist
 * @property {Status} status
 * @property {Decision|null} decision
 */

/**
 * @typedef {Object} PreviewTerm
 * @property {string} conceptId
 * @property {string} source
 * @property {string} expected     glossary rendering
 * @property {Enforcement} mode
 * @property {boolean} found       expected text present in the translation
 */

/**
 * @typedef {Object} PreviewItem     Step 8 enforcement preview: one translated sentence
 * @property {string} source
 * @property {string} translation    final translation shown
 * @property {PreviewTerm[]} terms
 * @property {boolean} retried       a hard-term miss triggered one stricter retry
 * @property {string|null} firstAttempt   translation before the retry, if retried
 */

/**
 * @typedef {Object} StepStats
 * @property {number} ms
 * @property {number} calls
 * @property {number} promptTokens
 * @property {number} completionTokens
 */

/**
 * @typedef {Object} RunStats
 * @property {number} durationMs        crawl start to line drawn
 * @property {number} candidates        unique candidate terms sent to clustering
 * @property {Partial<Record<'crawl'|'extract'|'cluster'|'draft'|'sibling'|'judge'|'line', StepStats>>} steps
 */

/**
 * @typedef {Object} Run
 * @property {string} id
 * @property {'demo'|'live'} mode
 * @property {string} createdAt
 * @property {{source: string, target: string, sibling: string|null}} locale
 * @property {{name: string, url: string, industry: string, pages: {url: string, title: string}[]}} site
 * @property {{entriesPerHour: number, hours: number, capacity: number}} budget
 * @property {{concepts: number, auto: number, queue: number, randomCheck: number}|null} totals
 *           demo only: whole-site numbers the sample stands for. Live runs use null and count concepts.
 * @property {string} styleGuide
 * @property {{drafter: string, judge: string}|null} models   model names used (live)
 * @property {{calls: number, promptTokens: number, completionTokens: number}|null} usage
 * @property {RunStats} [stats]        live only: timing and token use per step, for the run report
 * @property {Concept[]} concepts
 * @property {PreviewItem[]|null} preview
 */

export const STATUSES = ['pending', 'accepted', 'edited', 'rejected', 'asked_client', 'escalated'];

export const STATUS_LABEL = {
  pending: 'Pending',
  accepted: 'Accepted',
  edited: 'Edited',
  rejected: 'Rejected',
  asked_client: 'Awaiting client',
  escalated: 'Escalated: second linguist, then locale lead',
};

export const REJECT_REASONS = [
  ['wrong_meaning', 'Wrong meaning'],
  ['wrong_register', 'Wrong register'],
  ['not_natural', 'Not natural'],
  ['violates_style', 'Violates style guide'],
  ['other', 'Other'],
];

export const SCOPE_LABEL = {
  all: 'All pages',
  legal_safety: 'Legal & safety pages',
  marketing: 'Marketing copy',
};

export const LOCALE_LABEL = {
  en: 'English',
  'es-ES': 'Spanish (Spain)',
  'es-MX': 'Spanish (Mexico)',
  'fr-FR': 'French (France)',
  'fr-CA': 'French (Canada)',
  'de-DE': 'German (Germany)',
  'de-AT': 'German (Austria)',
  'pt-BR': 'Portuguese (Brazil)',
  'pt-PT': 'Portuguese (Portugal)',
  'it-IT': 'Italian',
  'nl-NL': 'Dutch',
  'ja-JP': 'Japanese',
  'hi-IN': 'Hindi',
};
