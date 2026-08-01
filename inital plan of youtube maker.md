# AI YouTube Factory
## Master Project Blueprint (Free & Local-First)

> **Mission**
>
> Build a completely free, local-first AI application that automatically creates original YouTube videos and uploads them to my YouTube channel.
>
> The entire workflow should require **one click** (or one command) and produce a ready-to-publish video.
>
> The system must be modular so any AI model or provider can be replaced later without changing the overall architecture.

---

# Core Philosophy

This project is **NOT** just a video generator.

It is an **AI Content Factory**.

The application should behave like a small production company where each AI component has a specific job.

Example:

```
CEO (Main Pipeline)

│

├── Trend Researcher

├── Content Strategist

├── Script Writer

├── Fact Checker

├── SEO Expert

├── Narrator

├── Video Editor

├── Thumbnail Designer

├── Quality Reviewer

└── YouTube Publisher
```

Each module is independent.

If one module changes, the rest continue working.

---

# Primary Goal

Create high-quality **original** videos that people actually want to watch.

The objective is **not** to generate random AI videos.

The objective is to build videos capable of:

- Getting views
- Increasing watch time
- Increasing CTR
- Increasing subscribers
- Eventually generating YouTube revenue

---

# Important Principles

## Everything Must Be Free

The MVP should avoid paid services wherever possible.

Preferred tools:

| Feature | Tool |
|----------|------|
| LLM | Ollama |
| Script | Qwen / Llama |
| Voice | Piper TTS |
| Images | Stable Diffusion |
| Captions | Whisper.cpp |
| Video | Remotion |
| Editing | FFmpeg |
| Database | SQLite |
| Backend | NestJS |
| Frontend | Next.js |

Paid providers can be added later behind an abstraction layer.

---

# Local First

Everything should run locally.

No:

- AWS
- Azure
- GCP
- S3
- Cloudinary
- Supabase
- Firebase

Storage:

```
Laptop

↓

storage/

↓

All Assets

↓

SQLite
```

Nothing should leave the computer except:

- YouTube Upload
- Optional internet requests for trend research

---

# Original Content Only

The application should **never** download another creator's YouTube video and re-upload it.

Instead it should create original videos using:

- AI-generated scripts
- AI narration
- AI-generated graphics
- Public-domain images
- Public-domain footage
- Creative Commons media with compatible licenses
- Self-generated animations
- Data visualizations
- Maps
- Timelines
- Infographics

This keeps the project sustainable and reduces copyright risk.

---

# Vision

Imagine clicking one button.

```
Generate Today's Video
```

The application should automatically:

```
Find Topic

↓

Research

↓

Write Script

↓

Split Scenes

↓

Generate Voice

↓

Generate Images

↓

Generate Animations

↓

Create Captions

↓

Render Video

↓

Generate Thumbnail

↓

Generate SEO

↓

Upload

↓

Done
```

No manual editing.

---

# Project Objectives

The project should eventually support:

✓ Multiple Niches

✓ Multiple Channels

✓ Multiple Languages

✓ Shorts

✓ Long Videos

✓ Podcasts

✓ Documentary Videos

✓ Educational Videos

✓ Animated Videos

✓ Daily Scheduling

✓ Analytics

✓ AI Learning

---

# Development Philosophy

Every feature should be replaceable.

Example

Current

```
Ollama

↓

Script
```

Later

```
Claude

↓

Script
```

Nothing else changes.

The same applies to:

- TTS
- Image generation
- Video rendering
- SEO
- Analytics

Every module communicates through interfaces.

---

# Free AI Strategy

## Large Language Models

Run locally using Ollama.

Possible models:

- Qwen
- Llama
- Gemma
- Mistral

Responsibilities:

- Video ideas
- Research summaries
- Script writing
- SEO
- Titles
- Descriptions
- Prompt generation

---

## Voice Generation

Piper TTS

Responsibilities:

- Narration
- Multiple voices
- Different speaking speeds
- Local generation

---

## Images

Stable Diffusion

Generate:

- Characters
- Backgrounds
- Objects
- Illustrations
- Thumbnails

---

## Captions

Whisper.cpp

Responsibilities:

- Subtitle generation
- Timing
- Export SRT

---

# Types of Niches

The application should not be hardcoded.

A niche should simply be a configuration.

Example:

```
History

↓

Prompt

↓

Voice

↓

Visual Style

↓

Music

↓

SEO Rules
```

Another niche:

```
Space

↓

Different Prompt

↓

Different Images

↓

Different Music

↓

Same Pipeline
```

Possible niches:

- History
- Space
- AI
- Business
- Finance
- Luxury
- Psychology
- Motivation
- Programming
- Islamic History
- Geography
- Animals
- Mystery
- Technology

---

# How Videos Become Interesting

The system should not just explain facts.

Every script should use storytelling.

Example structure:

```
Hook

↓

Question

↓

Conflict

↓

Curiosity

↓

Reveal

↓

Unexpected Twist

↓

Conclusion

↓

CTA
```

Every 15–30 seconds the script should introduce something new to keep viewers engaged.

---

# Visual Strategy

Instead of showing static images for the entire video, the renderer should create movement.

Effects:

- Slow zoom
- Pan
- Blur transitions
- Fade
- Parallax
- Motion graphics
- Animated captions
- Progress bars
- Maps
- Timelines

The result should feel edited, not like a slideshow.

---

# SEO Strategy

For every video generate:

- 20 title ideas
- 5 thumbnail concepts
- Description
- Tags
- Hashtags

Score each title based on:

- Curiosity
- Search intent
- Simplicity
- CTR potential

Pick the highest-scoring option automatically.

---

# Thumbnail Philosophy

The thumbnail should be treated as important as the video itself.

Goals:

- High contrast
- Readable text
- Emotional focus
- Clear subject
- Minimal clutter

Store every thumbnail for later comparison.

---

# Analytics (Future)

Track:

- Views
- CTR
- Watch time
- Audience retention
- Subscribers
- Likes
- Comments

Use these insights to improve future prompts.

---

# Quality Control

Before upload, perform checks:

- Script length
- Missing assets
- Audio duration
- Video duration
- Thumbnail exists
- Captions exist
- Upload credentials valid

If any check fails, stop the pipeline and show the reason.

---

# Configuration

Everything should be configurable.

Example:

```json
{
  "niche": "history",
  "language": "English",
  "videoType": "long",
  "duration": 8,
  "voice": "male",
  "resolution": "1920x1080",
  "upload": true,
  "captions": true,
  "thumbnail": true
}
```

No values should be hardcoded.

---

# Long-Term Roadmap

## Phase 1 – MVP (100% Local)

- One niche
- One channel
- Local AI
- Original script
- Local rendering
- Manual trigger
- Automatic upload

## Phase 2 – Better Content

- Better prompts
- Better animations
- Better thumbnails
- Public-domain asset integration
- Improved scene planning

## Phase 3 – Automation

- Daily scheduled generation
- Queue system
- Retry system
- Notifications
- Email reports

## Phase 4 – Multiple Channels

- Different niches
- Different voices
- Different branding
- Independent upload schedules

## Phase 5 – Optimization

- Learn from analytics
- A/B test titles
- A/B test thumbnails
- Prompt improvements
- Content recommendations

---

# Success Definition

The project is successful when I can:

1. Open the dashboard.
2. Click **Generate Video**.
3. Wait for the pipeline to finish.
4. Review the generated video if desired.
5. Click **Upload** (or let it upload automatically).
6. Repeat the process tomorrow with a new original video.

No manual editing should be required for the MVP, and every generated video should be based on original scripts and legally reusable or AI-generated assets.