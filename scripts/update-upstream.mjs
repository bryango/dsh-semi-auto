import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expectedReviewer, sha256 } from './generate-reviewer.mjs'

const root = new URL('../', import.meta.url)
const args = process.argv.slice(2)
const options = new Map()
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]
  const value = args[index + 1]
  if (!['--source', '--ref'].includes(key) || value === undefined || options.has(key)) {
    throw new Error('Usage: node scripts/update-upstream.mjs --source <checkout> [--ref <git-ref>]')
  }
  options.set(key, value)
}
if (!options.has('--source')) {
  throw new Error('Usage: node scripts/update-upstream.mjs --source <checkout> [--ref <git-ref>]')
}
const previous = JSON.parse(await readFile(new URL('vendor/upstream.json', root), 'utf8'))
const checkout = resolve(options.get('--source'))
const ref = options.get('--ref') ?? previous.commit
const git = (...argv) => execFileSync('git', ['-C', checkout, ...argv], { maxBuffer: 8 * 1024 * 1024 })
const commit = git('rev-parse', '--verify', `${ref}^{commit}`).toString('utf8').trim()
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Git did not return an exact commit id')
const sourcePath = 'packages/experimental/auto-review/src/index.ts'
const source = git('show', `${commit}:${sourcePath}`)
const license = git('show', `${commit}:LICENSE`)
const pkg = JSON.parse(git('show', `${commit}:packages/experimental/auto-review/package.json`).toString('utf8'))
if (pkg.name !== '@deepseek-ai/dsh-experimental-auto-review' || typeof pkg.version !== 'string') {
  throw new Error('Selected Git revision does not contain the expected official reviewer package')
}
const metadata = {
  repository: 'https://github.com/deepseek-ai/deepseek-harness',
  version: pkg.version,
  commit,
  files: {
    autoReview: { path: sourcePath, sha256: sha256(source) },
    license: { path: 'LICENSE', sha256: sha256(license) },
  },
}
// Git show reads the committed blobs, never the checkout's modified working files.
// Import intentionally precedes generation: changed upstream layouts remain available for manual review.
await mkdir(new URL('vendor/upstream/', root), { recursive: true })
await writeFile(new URL('vendor/upstream/auto-review.ts', root), source)
await writeFile(new URL('vendor/upstream/LICENSE', root), license)
await writeFile(new URL('vendor/upstream.json', root), JSON.stringify(metadata, null, 2) + '\n')
await mkdir(new URL('src/', root), { recursive: true })
await writeFile(new URL('src/auto-review.ts', root), await expectedReviewer())
console.log(`Imported official reviewer ${metadata.version} at ${commit}; review changes and run compatibility tests.`)
