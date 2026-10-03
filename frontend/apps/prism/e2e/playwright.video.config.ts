import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// The recorded walkthrough (walkthrough.video.ts): slower actions and held captions so the video can be followed.
export default defineConfig({
  ...base,
  testMatch: /walkthrough\.video\.ts$/,
  outputDir: '../.qa/video-results',
  use: {
    ...base.use,
    launchOptions: { ...base.use?.launchOptions, slowMo: Number(process.env.PINE_E2E_SLOWMO ?? 140) },
  },
})
