import { canDecorate } from './jungle/can-decorate';
import { CornerFoliage, Fireflies, LightRays, Mist } from './jungle/foliage';

/**
 * The forest floor behind every app page: deep green darkness, slanting moonlight, mist,
 * fireflies and foliage growing in from the corners. Decorative and never interactive; it
 * sits behind the content.
 */
export function AmbientBackground() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--ff-canvas-2),var(--ff-canvas)_70%)]" />
      {canDecorate() && (
        <>
          <LightRays />
          <Fireflies count={18} />
          <Mist />
          <div className="absolute inset-0 opacity-60">
            <CornerFoliage side="left" />
            <CornerFoliage side="right" />
          </div>
        </>
      )}
    </div>
  );
}
