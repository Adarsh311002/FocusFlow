/** The Focus Flow mark: three linked neurons, the middle one pulsing. */
export function NeuronMark({ className = 'h-7 w-7' }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <path
        d="M6 22 L16 10 L26 20 M16 10 L18 26"
        stroke="var(--ff-focus)"
        strokeWidth="1.2"
        fill="none"
        opacity="0.7"
      />
      <circle cx="6" cy="22" r="2.4" fill="var(--ff-violet)" />
      <circle cx="26" cy="20" r="2.4" fill="var(--ff-violet)" />
      <circle cx="18" cy="26" r="2" fill="var(--ff-violet)" />
      <circle cx="16" cy="10" r="3.4" fill="var(--ff-focus)">
        <animate attributeName="r" values="3;4.2;3" dur="2.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="1;0.6;1" dur="2.4s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}
