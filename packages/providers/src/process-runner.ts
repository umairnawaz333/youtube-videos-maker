import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * The seam every provider that shells out to a local binary is tested through — whisper-cli for
 * captions, python for Kokoro. Injecting it keeps the unit suite from spawning real processes.
 *
 * Shared rather than per-provider: the TTS and caption providers were built in parallel and each
 * defined an identical copy, which then collided in the package barrel. One definition, many
 * consumers.
 */
export interface ProcessRunner {
  run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>
}

export const nodeProcessRunner = (): ProcessRunner => ({
  async run(command, args) {
    // Whisper's JSON for a long narration and Kokoro's diagnostics both overrun the 1 MB
    // default, and an exceeded maxBuffer surfaces as a killed process rather than a clear error.
    return execFileAsync(command, args, { maxBuffer: 64 * 1024 * 1024 })
  },
})
