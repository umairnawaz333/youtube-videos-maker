import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Thin seam over child_process so tests never spawn the real python interpreter. */
export interface ProcessRunner {
  run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>
}

export const nodeProcessRunner = (): ProcessRunner => ({
  async run(command, args) {
    return execFileAsync(command, args, { maxBuffer: 64 * 1024 * 1024 })
  },
})
