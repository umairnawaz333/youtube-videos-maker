import React from 'react'
import { AbsoluteFill, Audio, Sequence } from 'remotion'
import type { VideoSpec } from '../types'
import { BrandCorner } from './BrandCorner'
import { CaptionsAtFrame } from './Captions'
import { ProgressBar } from './ProgressBar'
import { Scene } from './Scene'
import { TransitionWrapper } from './Transition'

export interface MainVideoProps {
  spec: VideoSpec
}

/**
 * The single top-level composition. Everything it needs — scenes, exact timings, asset
 * paths, captions, format — comes from `spec` alone (spec section 12: "the renderer is
 * therefore a pure function of that file"). No stage, provider, or model is reachable from
 * here.
 */
export const MainVideo: React.FC<MainVideoProps> = ({ spec }) => {
  const captionFontSize = spec.format === 'shorts' ? 64 : 48

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {spec.scenes.map((scene) => {
        const fromFrame = Math.round(scene.startSec * spec.fps)
        const durationInFrames = Math.round(scene.durationSec * spec.fps)
        return (
          <Sequence key={scene.id} from={fromFrame} durationInFrames={durationInFrames} name={scene.id}>
            <TransitionWrapper durationInFrames={durationInFrames}>
              <Scene scene={scene} />
            </TransitionWrapper>
            <Audio src={scene.audioPath} />
          </Sequence>
        )
      })}

      {spec.musicPath && <Audio src={spec.musicPath} volume={0.12} />}

      <CaptionsAtFrame words={spec.captions} fps={spec.fps} fontSize={captionFontSize} />
      <BrandCorner enabled={spec.brandCorner.enabled} position={spec.brandCorner.position} />
      <ProgressBar />
    </AbsoluteFill>
  )
}
