/**
 * Validates that a commit message subject follows Conventional Commits.
 *
 * Usage: tsx scripts/check-commit-msg.ts <path-to-COMMIT_EDITMSG>
 * Wired up as the lefthook commit-msg hook (see lefthook.yml).
 *
 * Exits 0 silently when the message is valid (or is a merge/revert/autosquash
 * commit), and 1 with an explanation otherwise.
 */
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const COMMIT_TYPES = [
  'feat',
  'fix',
  'docs',
  'refactor',
  'test',
  'chore',
  'build',
  'ci',
  'perf',
  'style',
  'revert',
] as const;

/** type(optional-scope)!: subject */
const TYPE_ALTERNATION = COMMIT_TYPES.join('|');
const SUBJECT_PATTERN = new RegExp(`^(?:${TYPE_ALTERNATION})(?:\\([^()\\s][^()]*\\))?!?: \\S.*$`);

/** Git-generated subjects that carry no room for a conventional prefix. */
const ACCEPTED_WITHOUT_CHECK = [/^merge\b/i, /^revert\s+"/i, /^fixup!/, /^squash!/, /^amend!/];

/** The "cut here" line of `git commit --verbose`; everything below it is the diff. */
const SCISSORS_PATTERN = /^#*\s*-{3,} >8 -{3,}/;

const MAX_SUBJECT_LENGTH = 100;
const EXAMPLE = 'feat(tasks): add current task selection';

function reportInvalid(subject: string, rule: string): void {
  console.error('Invalid commit message.');
  console.error('');
  console.error(`  ${subject}`);
  console.error('');
  console.error(`Rule: ${rule}`);
  console.error(`Valid example: ${EXAMPLE}`);
  console.error(`Allowed types: ${COMMIT_TYPES.join(', ')}`);
  process.exitCode = 1;
}

/** First meaningful line: comments, the verbose diff and blank lines are ignored. */
function extractSubject(rawMessage: string): string | undefined {
  for (const line of rawMessage.split(/\r?\n/)) {
    if (SCISSORS_PATTERN.test(line)) {
      break;
    }
    if (line.startsWith('#')) {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

async function run(): Promise<void> {
  const messagePath = process.argv[2];
  if (messagePath === undefined || messagePath.length === 0) {
    console.error('Missing argument.');
    console.error('Usage: tsx scripts/check-commit-msg.ts <path-to-commit-message-file>');
    process.exitCode = 1;
    return;
  }

  let rawMessage: string;
  try {
    rawMessage = await readFile(messagePath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    console.error(`Cannot read the commit message file: ${messagePath}`);
    console.error(reason);
    process.exitCode = 1;
    return;
  }

  const subject = extractSubject(rawMessage);
  if (subject === undefined) {
    console.error('The commit message is empty.');
    console.error(`Valid example: ${EXAMPLE}`);
    process.exitCode = 1;
    return;
  }

  if (ACCEPTED_WITHOUT_CHECK.some((pattern) => pattern.test(subject))) {
    return;
  }

  if (subject.length > MAX_SUBJECT_LENGTH) {
    reportInvalid(
      subject,
      `the subject line must be at most ${MAX_SUBJECT_LENGTH} characters (it is ${subject.length})`,
    );
    return;
  }

  if (!SUBJECT_PATTERN.test(subject)) {
    reportInvalid(
      subject,
      'the subject must be "type(optional-scope)!: description" with a lower-case type, ' +
        'a space after the colon and a non-empty description',
    );
  }
}

await run();
