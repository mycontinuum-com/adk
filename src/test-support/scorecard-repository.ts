import { execFile } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** The GitHub repository that the `origin` of `testRepository()` names. */
export const TEST_REPOSITORY = 'example/suite'
export const TEST_ORIGIN = `https://github.com/${TEST_REPOSITORY}.git`

/** A committed file of `testRepository()`, which a test edits to leave the checkout uncommitted. */
export const TEST_FILE = 'suite.txt'

/** Runs git in a test repository, where the machine's own identity, signing and hooks do not apply. */
export function git(cwd: string, ...args: string[]) {
  const settings = [
    'user.name=test',
    'user.email=test@example.invalid',
    'commit.gpgsign=false',
    'core.hooksPath=/dev/null',
    'protocol.file.allow=always',
  ]
  return exec('git', [...settings.flatMap((setting) => ['-c', setting]), ...args], { cwd })
}

/** Commits every change in `repository`. */
export async function commitAll(repository: string): Promise<void> {
  await git(repository, 'add', '-A')
  await git(repository, 'commit', '-q', '-m', 'test')
}

/** The commit at `HEAD` of `repository`. */
export async function head(repository: string): Promise<string> {
  return (await git(repository, 'rev-parse', 'HEAD')).stdout.trim()
}

/** A committed repository holding `TEST_FILE`, with `TEST_ORIGIN` as its origin. */
export async function testRepository(): Promise<string> {
  // git names a repository by its real path, which the temporary directory's own path is not on macOS.
  const repository = await realpath(await mkdtemp(join(tmpdir(), 'adk-scorecard-')))
  await git(repository, 'init', '-q')
  await git(repository, 'remote', 'add', 'origin', TEST_ORIGIN)
  await writeFile(join(repository, '.gitignore'), '*.log\n')
  await writeFile(join(repository, TEST_FILE), 'suite\n')
  await commitAll(repository)
  return repository
}
