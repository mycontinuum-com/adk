import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Runs git in a test repository, where the machine's own identity, signing and hooks do not apply. */
export function git(cwd: string, ...args: string[]) {
  const settings = [
    'user.name=test',
    'user.email=test@example.invalid',
    'commit.gpgsign=false',
    'core.hooksPath=/dev/null',
  ]
  return exec('git', [...settings.flatMap((setting) => ['-c', setting]), ...args], { cwd })
}

/**
 * The shared test values of "The fingerprint" in `docs/eval-cli.md`: git's id of each fingerprinted
 * path in the repository `vectorRepository()` commits.
 */
export const VECTOR_IDS = {
  'a.txt': '4a58007052a65fbc2fc3f910f2855f45a4058e74',
  dir: '23b08af3548c6d2c1611b1671385a25e9a9fe1eb',
}
export const VECTOR_PATHS = Object.keys(VECTOR_IDS)

/** An edit under the path `dir`, and the id of `dir` once that edit is committed. */
export const VECTOR_EDIT = {
  file: 'dir/b.txt',
  content: 'beta changed\n',
  ids: { ...VECTOR_IDS, dir: '159e5f66d0f793c2eda118f01f0ea2d65f6a7b0d' },
}

/** A committed file that is under none of the fingerprinted paths. */
export const VECTOR_OUTSIDE = 'outside.txt'

/** Commits every change in `repository`. */
export async function commitAll(repository: string): Promise<void> {
  await git(repository, 'add', '-A')
  await git(repository, 'commit', '-q', '-m', 'test')
}

/** Builds and commits the repository of the shared test values. */
export async function vectorRepository(): Promise<string> {
  // git names a repository by its real path, which the temporary directory's own path is not on macOS.
  const repository = await realpath(await mkdtemp(join(tmpdir(), 'adk-scorecard-')))
  await git(repository, 'init', '-q')
  await mkdir(join(repository, 'dir'))
  const files = {
    '.gitignore': '*.log\n',
    'a.txt': 'alpha\n',
    [VECTOR_EDIT.file]: 'beta\n',
    'dir/ignored.log': 'noise\n',
    [VECTOR_OUTSIDE]: 'outside\n',
  }
  await Promise.all(
    Object.entries(files).map(([path, content]) => writeFile(join(repository, path), content)),
  )
  await commitAll(repository)
  return repository
}
