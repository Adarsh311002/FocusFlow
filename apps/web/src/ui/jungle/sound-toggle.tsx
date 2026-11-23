import { motion } from 'motion/react';

import { canDecorate } from './can-decorate';
import { disableForest, enableForest, useForestSound } from './soundscape';

/** A floating button that turns the forest soundscape on and off. Off until pressed. */
function ForestSoundToggleInner() {
  const on = useForestSound();
  return (
    <motion.button
      type="button"
      aria-pressed={on}
      onClick={() => {
        if (on) {
          disableForest();
        } else {
          enableForest();
        }
      }}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 2.4, duration: 0.8 }}
      className="fixed bottom-5 left-5 z-50 flex items-center gap-3 rounded-full border border-[#7fbf6a]/30 bg-[#0b1a13]/80 py-2 pr-4 pl-3 text-xs text-[#efe9d6] shadow-[0_10px_40px_rgb(0_0_0_/_0.4)] backdrop-blur-xl transition hover:border-[#f3dc8a]/60"
    >
      <span aria-hidden="true" className="flex h-5 items-end gap-[3px]">
        {[0, 1, 2, 3].map((bar) => (
          <span
            key={bar}
            className={`w-[3px] rounded-full bg-[#a7d77c] ${on ? 'ff-eq' : ''}`}
            style={{
              height: on ? undefined : '4px',
              animationDelay: `${String(-bar * 0.23)}s`,
            }}
          />
        ))}
      </span>
      {on ? 'Forest sounds on' : 'Play forest sounds'}
    </motion.button>
  );
}

/** Draws ForestSoundToggle only where decorations are wanted (see `canDecorate`). */
export function ForestSoundToggle() {
  return canDecorate() ? <ForestSoundToggleInner /> : null;
}
