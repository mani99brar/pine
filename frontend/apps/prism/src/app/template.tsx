'use client'

import { motion } from 'motion/react'
import { useReduceMotion } from '@/lib/hooks'

/** Route transition: content arrives from a slight blur, like light coming into focus. */
export default function Template({ children }: { children: React.ReactNode }) {
  const reduce = useReduceMotion()
  return (
    <motion.div initial={reduce ? false : { opacity: 0, filter: 'blur(6px)', y: 6 }} animate={{ opacity: 1, filter: 'blur(0px)', y: 0, transitionEnd: { filter: 'none', transform: 'none' } }} transition={{ duration: 0.36, ease: [0.16, 1, 0.3, 1] }}>
      {children}
    </motion.div>
  )
}
