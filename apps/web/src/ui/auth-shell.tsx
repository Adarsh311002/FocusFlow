import { motion } from 'motion/react';
import type { ReactNode } from 'react';

import { ForestVisual } from './forest-visual';
import { Critter, EyesArt } from './jungle/critters';

const EASE = [0.22, 1, 0.36, 1] as const;

const PROMISES = [
  ['Intent first', 'Every session starts from the one task you chose.'],
  ['Honest time', 'The server keeps the clock, even if a tab closes.'],
  ['Side by side', 'Focus rooms with a shared, host-led timer.'],
] as const;

/** Sign in and sign up: the neural brain and the promise on one side, the form on the other. */
export function AuthShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid min-h-[calc(100vh-10rem)] items-center gap-12 lg:grid-cols-[1.15fr_1fr]">
      <motion.div
        className="relative hidden overflow-hidden rounded-[2.5rem] border border-line bg-canvas-2/60 p-10 lg:block"
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1, ease: EASE }}
      >
        <p className="text-xs tracking-[0.3em] text-focus uppercase">( Deep work, together )</p>
        <h2 className="font-display mt-6 text-6xl leading-[1.02]">
          Find your flow.
          <br />
          <em className="text-focus">Stay there.</em>
        </h2>
        <div className="relative">
          <ForestVisual energy={0.45} className="-mx-10 h-80" />
          <Critter kind="jaguar" className="right-2 bottom-6" bubble="above">
            <EyesArt />
          </Critter>
        </div>
        <ul className="grid grid-cols-3 gap-6 border-t border-line pt-6">
          {PROMISES.map(([title, body]) => (
            <li key={title}>
              <p className="font-display text-xl">{title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{body}</p>
            </li>
          ))}
        </ul>
      </motion.div>

      <motion.div
        className="mx-auto w-full max-w-md rounded-[2rem] border border-line bg-surface p-8 shadow-card backdrop-blur-xl md:p-10"
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1, delay: 0.15, ease: EASE }}
      >
        {children}
      </motion.div>
    </div>
  );
}
