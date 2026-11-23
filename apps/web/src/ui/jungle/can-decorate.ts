/**
 * Whether to draw the forest's decorative layers (vines, foliage, animals, sound controls).
 * Real browsers always have `matchMedia`; test DOMs such as jsdom do not, and rendering
 * hundreds of decorative SVG nodes there only slows every test down.
 */
export function canDecorate(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}
