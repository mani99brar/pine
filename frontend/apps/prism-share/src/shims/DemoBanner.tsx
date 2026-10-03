/**
 * Prism's demo banner plus one line about the static preview. The real banner renders unchanged; the
 * extra line sits directly under it in the same strip and hides with it (`:first-child` rule in
 * src/styles.css applies when the real banner has been dismissed and rendered nothing).
 */
import { DemoBanner as PrismDemoBanner } from '@prism/components/shell/DemoBanner'

export function DemoBanner() {
  return (
    <div className="ps-banner">
      <PrismDemoBanner />
      <p className="ps-banner-line relative z-[61] border-b border-edge bg-[#1c1512]">
        <span className="mx-auto block max-w-[1440px] px-4 pb-2 text-[0.78rem] leading-[1.4] text-lumen-3 sm:px-6 lg:px-8">
          Static artifact preview: Pine Prism running entirely in your browser. Data stays in this browser.
        </span>
      </p>
    </div>
  )
}
