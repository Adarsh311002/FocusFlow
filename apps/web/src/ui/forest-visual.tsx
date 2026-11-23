import { lazy, Suspense, useState } from 'react';

const AncientTreeScene = lazy(() => import('./jungle/ancient-tree-scene'));

function canUseWebGl(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null || canvas.getContext('webgl') !== null;
  } catch {
    return false;
  }
}

/** A soft CSS glow, shown while the 3D scene loads and wherever WebGL is unavailable. */
function OrbFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="ff-breathe h-2/3 w-2/3 rounded-full bg-focus/20 blur-2xl" />
    </div>
  );
}

/**
 * The calm 3D centrepiece. `energy` is 0 when idle and approaches 1 in deep focus. The scene
 * (three.js) is code-split, skipped without WebGL and skipped when the user prefers reduced
 * motion. Purely decorative, so it is hidden from assistive technology.
 */
export function ForestVisual({ energy = 0.2, className }: { energy?: number; className?: string }) {
  const [enabled] = useState(
    () =>
      typeof window.matchMedia === 'function' &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
      canUseWebGl(),
  );

  return (
    <div aria-hidden="true" className={className ?? 'h-72 w-full'}>
      <div className="relative h-full w-full">
        {/* Misty moonlight behind the tree, so its silhouette reads in the dark. */}
        <div className="pointer-events-none absolute top-[6%] left-1/2 h-[80%] w-[70%] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,var(--ff-moon),transparent_68%)] blur-2xl" />
        <div className="pointer-events-none absolute top-[18%] left-1/2 h-[34%] w-[26%] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,var(--ff-moon-core),transparent_70%)] blur-xl" />
        <div className="absolute inset-0">
          {enabled ? (
            <Suspense fallback={<OrbFallback />}>
              <AncientTreeScene mode="panel" energy={energy} />
            </Suspense>
          ) : (
            <OrbFallback />
          )}
        </div>
      </div>
    </div>
  );
}
