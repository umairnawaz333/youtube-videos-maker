import path from 'node:path'

/**
 * Every path the dashboard needs to agree with the pipeline CLI on, resolved the same way
 * `packages/pipeline/src/cli.ts` resolves them, so a run triggered from here and a run
 * triggered from the terminal write to (and are read from) the exact same place.
 *
 * `next dev` / `next start` are invoked with this package's directory as `cwd` (that's how
 * `pnpm --filter dashboard <script>` runs any script), so `apps/dashboard/..(..)` reaches the
 * repo root the same way `path.resolve(__dirname, '../../..')` does from inside
 * `packages/pipeline/src/cli.ts`. REPO_ROOT is available as an escape hatch if the app is ever
 * started from a different working directory.
 */
export const repoRoot = (): string => process.env.REPO_ROOT ?? path.resolve(process.cwd(), '../..')

export const storageRoot = (): string => process.env.STORAGE_ROOT ?? path.join(repoRoot(), 'storage')

/** Matches the default in `packages/pipeline/src/cli.ts`'s `run` verb exactly. */
export const databaseUrl = (): string =>
  process.env.DATABASE_URL ?? `file:${path.join(repoRoot(), 'storage/factory.db')}`
