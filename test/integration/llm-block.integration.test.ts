import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScenePlanSchema, ScriptSchema, SECTION_KINDS, SeoSchema, TopicSchema } from '@yt/core'
import { createFakeProviders, createHttpOllamaClient, OllamaLlmProvider, WikipediaResearchProvider, HttpTrendProvider } from '@yt/providers'
import type { Repositories } from '@yt/db'
import { buildLlmStages, FileArtifactStore, runPaths, runPipeline } from '@yt/pipeline'
import { createTestDb } from '../setup/db'

const HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
const MODEL = process.env.LLM_MODEL ?? 'qwen3:8b'
const configDir = path.resolve(__dirname, '../../config')

let repos: Repositories
let cleanup: () => Promise<void>
let storageRoot: string

beforeEach(async () => {
  const db = await createTestDb()
  repos = db.repos
  cleanup = db.cleanup
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-int-'))
})
afterEach(async () => {
  await cleanup()
  await fs.rm(storageRoot, { recursive: true, force: true })
})

describe('the LLM block against a real local model', () => {
  it('produces a grounded script, a scene plan and scored SEO from a real topic', async () => {
    const client = createHttpOllamaClient({ host: HOST })
    const llm = new OllamaLlmProvider({ client, model: MODEL, log: (m) => console.log(`  llm: ${m}`) })

    const result = await runPipeline({
      runId: 'run-integration',
      repos,
      configDir,
      storageRoot,
      // `long` deliberately: the eight-section arc needs at least 120s, and running the
      // headline deliverable at the format with the most room gives the clearest read on
      // whether the prompts work.
      request: { niche: 'space', videoType: 'long' },
      // NOT useFakes: Plan 1's guard rejects useFakes combined with explicit stages or
      // providers, precisely so a real run can never silently fall back to fakes. Supply the
      // fake bundle explicitly and override the three providers this block actually uses.
      providers: createFakeProviders(),
      stages: buildLlmStages(),
      llm,
      trend: new HttpTrendProvider({ log: (m) => console.log(`  trend: ${m}`) }),
      research: new WikipediaResearchProvider({ log: (m) => console.log(`  research: ${m}`) }),
      onLog: (e) => console.log(`  [${e.level}] ${e.message}`),
    })

    // A halt is a legitimate outcome (an ungrounded script SHOULD stop the run), so assert on
    // what was produced rather than only on the status.
    console.log(`run finished: ${result.status}${result.reason ? ` — ${result.reason}` : ''}`)

    const artifacts = new FileArtifactStore(runPaths(storageRoot, 'run-integration'))

    const topic = await artifacts.read('topic', TopicSchema)
    expect(topic.title.length).toBeGreaterThan(0)
    expect(topic.angle.length).toBeGreaterThan(10)
    console.log(`topic: ${topic.title} (${topic.total}/40) — ${topic.angle}`)

    // A halt as early as researcher (no facts found for any entity) is a legitimate outcome
    // too, and leaves no script.json behind — script-writer never got a chance to run. Only
    // assert on the script's shape when one was actually produced.
    const wroteScript = await artifacts.exists('script')
    if (wroteScript) {
      const script = await artifacts.read('script', ScriptSchema)
      expect(script.sections.map((s) => s.kind)).toEqual([...SECTION_KINDS])
      const beats = script.sections.flatMap((s) => s.beats)
      expect(beats.every((b) => b.targetSeconds >= 15 && b.targetSeconds <= 30)).toBe(true)
      console.log(`script: ${beats.length} beats, ~${beats.reduce((a, b) => a + b.targetSeconds, 0)}s`)
      console.log(`hook: ${script.sections[0]!.beats[0]!.text}`)
    }

    if (result.status !== 'failed') {
      const scenes = await artifacts.read('scenes', ScenePlanSchema)
      expect(scenes.scenes.length).toBeGreaterThan(0)
      const seo = await artifacts.read('seo', SeoSchema)
      expect(seo.titles).toHaveLength(20)
      expect(seo.titles.some((t) => t.title === seo.chosenTitle)).toBe(true)
      console.log(`chosen title: ${seo.chosenTitle}`)
    }
  })
})
