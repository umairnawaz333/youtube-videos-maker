import React from 'react'
import { Composition, Still } from 'remotion'
import { MainVideo } from './compositions/MainVideo'
import { ThumbnailStill } from './compositions/ThumbnailStill'
import type { ThumbnailJob, VideoSpec } from './types'

/** A minimal placeholder spec so the Studio preview has something to show before a real
 * videoSpec.json is selected via input props. Never used by the CLI render entry points. */
const PLACEHOLDER_SPEC: VideoSpec = {
  runId: 'preview',
  format: 'long',
  width: 1920,
  height: 1080,
  fps: 30,
  durationSec: 5,
  title: 'Preview',
  scenes: [],
  captions: [],
  musicPath: null,
  brandCorner: { enabled: true, position: 'bottom-right' },
}

const PLACEHOLDER_THUMBNAIL_JOB: ThumbnailJob = {
  sourceImagePath: '',
  outPath: '',
  title: 'Preview',
  width: 1280,
  height: 720,
}

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="MainVideo"
      component={MainVideo}
      durationInFrames={PLACEHOLDER_SPEC.durationSec * PLACEHOLDER_SPEC.fps}
      fps={PLACEHOLDER_SPEC.fps}
      width={PLACEHOLDER_SPEC.width}
      height={PLACEHOLDER_SPEC.height}
      defaultProps={{ spec: PLACEHOLDER_SPEC }}
      calculateMetadata={async ({ props }) => ({
        durationInFrames: Math.max(1, Math.round(props.spec.durationSec * props.spec.fps)),
        fps: props.spec.fps,
        width: props.spec.width,
        height: props.spec.height,
      })}
    />
    <Still
      id="ThumbnailStill"
      component={ThumbnailStill}
      width={PLACEHOLDER_THUMBNAIL_JOB.width}
      height={PLACEHOLDER_THUMBNAIL_JOB.height}
      defaultProps={{ job: PLACEHOLDER_THUMBNAIL_JOB }}
      calculateMetadata={async ({ props }) => ({
        width: props.job.width,
        height: props.job.height,
      })}
    />
  </>
)
