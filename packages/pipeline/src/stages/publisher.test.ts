import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SeoSchema, type Seo } from '@yt/core'
import type { PublishDecision } from '@yt/core/schemas/publish'
import type { FakeCallLog } from '@yt/providers'
import { createPublisherStage } from './publisher'
import { makeStageContext, type StageHarness } from '../../../../test/fixtures/stage-context'

let h: StageHarness

/** See illustrator.test.ts for why this narrowing cast is needed. */
const fakeCalls = (h: StageHarness): FakeCallLog => (h.providers as unknown as { calls: FakeCallLog }).calls

const seoFixture = (overrides: Partial<Seo> = {}): Seo => ({
  titles: Array.from({ length: 20 }, (_, i) => ({
    title: i === 0 ? 'The chosen title' : `Alternate title ${i}`,
    scores: { curiosity: 5, searchIntent: 5, simplicity: 5, ctr: 5 },
    total: 20,
  })),
  chosenTitle: 'The chosen title',
  description: 'A description.',
  tags: ['tag1', 'tag2'],
  hashtags: ['#tag1'],
  ...overrides,
})

/** Writes everything the Publisher stage looks for: seo.json, the rendered video, a thumbnail
 * candidate, and captions.srt — mirroring quality-gate.test.ts's healthy-run fixture. */
const setupPublishableRun = async (h: StageHarness) => {
  await h.ctx.artifacts.write('seo', SeoSchema, seoFixture())
  await fs.writeFile(path.join(h.ctx.paths.out, 'video.mp4'), Buffer.from([0]))
  await fs.writeFile(path.join(h.ctx.paths.thumbnail, 'v1.png'), Buffer.from([0]))
  await fs.writeFile(path.join(h.ctx.paths.captions, 'captions.srt'), '1\n00:00:00,000 --> 00:00:01,000\nHi\n', 'utf8')
}

const approvedDecision = (overrides: Partial<PublishDecision> = {}): PublishDecision => ({
  approved: true,
  approvedAt: '2026-08-05T00:00:00.000Z',
  ...overrides,
})

beforeEach(async () => {
  h = await makeStageContext({ videoType: 'long' })
})

afterEach(async () => {
  await h.cleanup()
})

describe('publisher stage: the review gate', () => {
  it('does not upload when there is no publish-decision.json and autoPublish is off', async () => {
    await setupPublishableRun(h)
    const stage = createPublisherStage()

    const outcome = await stage.run(h.ctx)

    expect(outcome.status).not.toBe('done')
    expect(fakeCalls(h).published).toHaveLength(0)
  })

  it('uploads once a decision file records the human review click', async () => {
    await setupPublishableRun(h)
    const stage = createPublisherStage({ readDecision: async () => approvedDecision() })

    const outcome = await stage.run(h.ctx)

    expect(outcome).toEqual({ status: 'done' })
    expect(fakeCalls(h).published).toHaveLength(1)
  })

  it('uploads without a decision file when autoPublish is explicitly enabled', async () => {
    await setupPublishableRun(h)
    h.ctx.config.autoPublish = true
    const stage = createPublisherStage({ readDecision: async () => null })

    const outcome = await stage.run(h.ctx)

    expect(outcome).toEqual({ status: 'done' })
    expect(fakeCalls(h).published).toHaveLength(1)
  })

  it('skips entirely, without consulting the review gate, when upload is disabled in config', async () => {
    await setupPublishableRun(h)
    h.ctx.config.upload = false
    const stage = createPublisherStage({
      readDecision: async () => {
        throw new Error('must not be consulted when upload is disabled')
      },
    })

    const outcome = await stage.run(h.ctx)

    expect(outcome).toEqual({ status: 'done' })
    expect(fakeCalls(h).published).toHaveLength(0)
  })
})

describe('publisher stage: building the request', () => {
  it('uses the SEO-chosen title/description/tags and the lowest-numbered thumbnail by default', async () => {
    await setupPublishableRun(h)
    const stage = createPublisherStage({ readDecision: async () => approvedDecision() })

    await stage.run(h.ctx)

    const req = fakeCalls(h).published[0]!
    expect(req.title).toBe('The chosen title')
    expect(req.description).toBe('A description.')
    expect(req.tags).toEqual(['tag1', 'tag2'])
    expect(req.thumbnailPath).toBe(path.join(h.ctx.paths.thumbnail, 'v1.png'))
    expect(req.videoPath).toBe(path.join(h.ctx.paths.out, 'video.mp4'))
    expect(req.captionsPath).toBe(path.join(h.ctx.paths.captions, 'captions.srt'))
  })

  it('defaults privacy to private when neither the decision nor config specifies one', async () => {
    await setupPublishableRun(h)
    const stage = createPublisherStage({ readDecision: async () => approvedDecision() })

    await stage.run(h.ctx)

    expect(fakeCalls(h).published[0]!.privacy).toBe('private')
  })

  it("lets the human's decision override title, description, tags, thumbnail, and privacy", async () => {
    await setupPublishableRun(h)
    await fs.writeFile(path.join(h.ctx.paths.thumbnail, 'v2.png'), Buffer.from([1]))
    const stage = createPublisherStage({
      readDecision: async () =>
        approvedDecision({
          title: 'A human-edited title',
          description: 'A human-edited description.',
          tags: ['override'],
          thumbnail: 'v2.png',
          privacy: 'public',
        }),
    })

    await stage.run(h.ctx)

    const req = fakeCalls(h).published[0]!
    expect(req.title).toBe('A human-edited title')
    expect(req.description).toBe('A human-edited description.')
    expect(req.tags).toEqual(['override'])
    expect(req.thumbnailPath).toBe(path.join(h.ctx.paths.thumbnail, 'v2.png'))
    expect(req.privacy).toBe('public')
  })

  it('halts with a specific reason when the chosen thumbnail file does not exist', async () => {
    await setupPublishableRun(h)
    const stage = createPublisherStage({
      readDecision: async () => approvedDecision({ thumbnail: 'v9.png' }),
    })

    const outcome = await stage.run(h.ctx)

    expect(outcome.status).toBe('halted')
    expect((outcome as { reason: string }).reason).toMatch(/v9\.png/)
  })

  it('halts when the rendered video is missing', async () => {
    await h.ctx.artifacts.write('seo', SeoSchema, seoFixture())
    await fs.writeFile(path.join(h.ctx.paths.thumbnail, 'v1.png'), Buffer.from([0]))
    await fs.writeFile(path.join(h.ctx.paths.captions, 'captions.srt'), 'x', 'utf8')
    const stage = createPublisherStage({ readDecision: async () => approvedDecision() })

    const outcome = await stage.run(h.ctx)

    expect(outcome.status).toBe('halted')
  })
})

describe('publisher stage: recording the result', () => {
  it('records the returned video id to publish-result.json', async () => {
    await setupPublishableRun(h)
    const stage = createPublisherStage({ readDecision: async () => approvedDecision() })

    await stage.run(h.ctx)

    const raw = await fs.readFile(path.join(h.ctx.paths.root, 'publish-result.json'), 'utf8')
    const result = JSON.parse(raw)
    expect(result.videoId).toBe('fake-0-1')
    expect(result.requestedPrivacy).toBe('private')
    expect(typeof result.testingModeCaveat).toBe('string')
    expect(result.testingModeCaveat).toMatch(/Testing mode/)
  })

  it('logs a runtime warning about Testing-mode privacy and the daily quota cap before publishing', async () => {
    await setupPublishableRun(h)
    const stage = createPublisherStage({ readDecision: async () => approvedDecision() })

    await stage.run(h.ctx)

    expect(h.logs.some((l) => l.message.includes('Testing mode'))).toBe(true)
    expect(h.logs.some((l) => l.message.includes('six uploads/day'))).toBe(true)
  })
})
