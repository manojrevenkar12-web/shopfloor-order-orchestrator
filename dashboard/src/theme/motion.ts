/** Motion tokens (seconds, for Framer Motion). Mirrors the CSS duration tokens. */
export const duration = { instant: 0.1, quick: 0.18, standard: 0.28, emphasis: 0.45 } as const;
export const ease = {
  enter: [0.2, 0, 0, 1] as const,
  exit: [0.4, 0, 1, 1] as const,
  move: [0.4, 0, 0.2, 1] as const,
};
export const stagger = 0.05;
