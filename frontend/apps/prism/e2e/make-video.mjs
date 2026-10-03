#!/usr/bin/env node
// Edits the recorded walkthrough (walkthrough.video.ts) into a short MP4: the long on-chain waits (publication
// confirmation, evidence inclusion) play fast, everything else at normal speed. Needs ffmpeg with libx264.
// Usage: node e2e/make-video.mjs <video.webm> <timeline.json> <out.mp4>
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const [video, timelineFile, out] = process.argv.slice(2)
if (!video || !timelineFile || !out) {
  console.error('usage: node e2e/make-video.mjs <video.webm> <timeline.json> <out.mp4>')
  process.exit(2)
}

const marks = Object.fromEntries(JSON.parse(readFileSync(timelineFile, 'utf8')).map((m) => [m.label, m.t]))
const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], { encoding: 'utf8' })
const duration = Number(probe.stdout.trim())
if (!Number.isFinite(duration) || duration <= 0) throw new Error('could not read the video duration')

// [start, end, speed]: waits are sped up, keeping a little of each side at normal speed.
const fast = [
  [marks['publish-sent'] + 2, marks['publish-confirmed'] - 1, 8],
  [marks['evidence-sent'] + 1.5, marks['evidence-done'] - 1, 4],
].filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b - a > 2)

const segments = []
let cursor = 0
for (const [a, b, speed] of fast) {
  if (a > cursor) segments.push([cursor, a, 1])
  segments.push([a, b, speed])
  cursor = b
}
if (cursor < duration) segments.push([cursor, duration, 1])

const parts = segments.map(([a, b, speed], i) => `[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=(PTS-STARTPTS)/${speed}[v${i}]`)
const filter = `${parts.join(';')};${segments.map((_, i) => `[v${i}]`).join('')}concat=n=${segments.length}:v=1:a=0,scale=1280:-2,fps=30[out]`
const args = ['-y', '-v', 'error', '-i', video, '-filter_complex', filter, '-map', '[out]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]
const run = spawnSync('ffmpeg', args, { stdio: 'inherit' })
if (run.status !== 0) process.exit(run.status ?? 1)
const outDuration = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout.trim()
console.log(`wrote ${out}: ${Number(outDuration).toFixed(1)} s from ${duration.toFixed(1)} s (${segments.length} segments)`)
