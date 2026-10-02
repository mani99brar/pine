import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      color: [
        'ink', 'sheet', 'bond', 'violet', 'flag', 'red', 'graphite', 'rule', 'rule-strong', 'violet-deep',
        'violet-wash', 'violet-line', 'ochre', 'wheat', 'wheat-line', 'plum', 'mauve', 'mauve-line', 'slate',
        'mist', 'red-wash', 'red-line', 'flag-wash', 'white', 'transparent', 'current',
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
