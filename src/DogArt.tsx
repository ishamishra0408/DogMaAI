// Original drawings for DogMaAI: friendly flat pups that share one outline colour with the app text.
// The dog-art class opts out of the app's global icon styling (20 px size, inherited stroke).
const outline = "#3a302a";
interface Coat { fur: string; ear: string; patch: string; collar: string }
const caramel: Coat = { fur: "#dfa262", ear: "#b36d35", patch: "#f7e6cf", collar: "#6f9c8c" };
const cream: Coat = { fur: "#f3e4cf", ear: "#9c6a45", patch: "#fffaf2", collar: "#d9674f" };

function Head({ coat, tongue = false, eyePatch = false, sleepy = false }: { coat: Coat; tongue?: boolean; eyePatch?: boolean; sleepy?: boolean }) {
  return <g>
    <ellipse cx="0" cy="0" rx="18" ry="17" fill={coat.fur} stroke={outline} strokeWidth="2" />
    {eyePatch && <ellipse cx="7.5" cy="-3.5" rx="6" ry="5.5" fill={coat.ear} />}
    <path d="M-15 -9 C-26 -8 -29 9 -21 16 C-16 12 -13 3 -11 -5 Z" fill={coat.ear} stroke={outline} strokeWidth="2" strokeLinejoin="round" />
    <path d="M15 -9 C26 -8 29 9 21 16 C16 12 13 3 11 -5 Z" fill={coat.ear} stroke={outline} strokeWidth="2" strokeLinejoin="round" />
    {sleepy
      ? <path d="M-10 -3.5 Q-7 -0.5 -4 -3.5 M4 -3.5 Q7 -0.5 10 -3.5" fill="none" stroke={outline} strokeWidth="1.8" strokeLinecap="round" />
      : <><circle cx="-7" cy="-3" r="2.3" fill={outline} /><circle cx="7" cy="-3" r="2.3" fill={outline} /><circle cx="-6.2" cy="-3.8" r=".7" fill="#fff" /><circle cx="7.8" cy="-3.8" r=".7" fill="#fff" /></>}
    <ellipse cx="0" cy="7" rx="8.5" ry="6.5" fill={coat.patch} stroke={outline} strokeWidth="1.4" />
    {tongue && <path d="M-2 9.6 Q0 15.5 2 9.6 Z" fill="#e2837a" stroke={outline} strokeWidth="1" strokeLinejoin="round" />}
    <ellipse cx="0" cy="4" rx="3.4" ry="2.4" fill={outline} />
    <path d="M0 6.4 V8.6 M-3.6 9 Q0 11.8 3.6 9" fill="none" stroke={outline} strokeWidth="1.3" strokeLinecap="round" />
  </g>;
}

// A sitting pup whose origin is the ground between its front paws.
function Pup({ x, y, scale = 1, coat, tilt = 0, paws = "down", tongue = false, eyePatch = false }: { x: number; y: number; scale?: number; coat: Coat; tilt?: number; paws?: "down" | "up"; tongue?: boolean; eyePatch?: boolean }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`}>
    <path d="M15 -12 C29 -16 34 -31 29 -41" fill="none" stroke={coat.ear} strokeWidth="5" strokeLinecap="round" />
    <path d="M-18 0 C-20 -22 -14 -38 0 -40 C14 -38 20 -22 18 0 Z" fill={coat.fur} stroke={outline} strokeWidth="2" strokeLinejoin="round" />
    <path d="M-8 -3 C-9 -17 -5 -28 0 -29 C5 -28 9 -17 8 -3 Z" fill={coat.patch} />
    {paws === "down"
      ? <><ellipse cx="-8" cy="-1" rx="7" ry="4.2" fill={coat.patch} stroke={outline} strokeWidth="1.8" /><ellipse cx="8" cy="-1" rx="7" ry="4.2" fill={coat.patch} stroke={outline} strokeWidth="1.8" /></>
      : <><ellipse cx="-9" cy="-1" rx="6" ry="3.6" fill={coat.patch} stroke={outline} strokeWidth="1.8" /><ellipse cx="9" cy="-1" rx="6" ry="3.6" fill={coat.patch} stroke={outline} strokeWidth="1.8" /><ellipse cx="-10" cy="-27" rx="5.5" ry="4.2" fill={coat.patch} stroke={outline} strokeWidth="1.8" transform="rotate(-20 -10 -27)" /><ellipse cx="10" cy="-27" rx="5.5" ry="4.2" fill={coat.patch} stroke={outline} strokeWidth="1.8" transform="rotate(20 10 -27)" /></>}
    <path d="M-13 -37 Q0 -30 13 -37" fill="none" stroke={coat.collar} strokeWidth="3.5" strokeLinecap="round" />
    <circle cx="0" cy="-32.8" r="2.2" fill="#e0b04a" stroke={outline} strokeWidth="1" />
    <g transform={`translate(0 -53) rotate(${tilt})`}><Head coat={coat} tongue={tongue} eyePatch={eyePatch} /></g>
  </g>;
}

const Ground = ({ width }: { width: number }) => <ellipse cx={width / 2} cy="108" rx={width * 0.36} ry="6" fill="#f1e3d3" />;

// A cloud top from x to x + width, with bumps of varying size; seeded, so it looks the same on every render. Puffy clouds
// overlap: each bump is most of an oval and starts before the last one ends, as on joshwcomeau.com.
function cloudTop(x: number, width: number, top: number, bottom: number, sizes: [number, number], seed: number, puffy = false) {
  let value = seed;
  const next = () => { value = (value * 9301 + 49297) % 233280; return value / 233280; };
  let at = x;
  let d = `M${at} ${bottom} L${at} ${(top + next() * 6).toFixed(1)}`;
  while (at < x + width) {
    const radius = sizes[0] + next() * (sizes[1] - sizes[0]);
    const height = radius * (puffy ? 0.72 + next() * 0.22 : 0.82);
    at += radius * (puffy ? 1.5 : 2);
    d += ` A${radius.toFixed(1)} ${height.toFixed(1)} 0 ${puffy ? 1 : 0} 1 ${at.toFixed(1)} ${(top + next() * (puffy ? 12 : 6)).toFixed(1)}`;
  }
  return `${d} L${at.toFixed(1)} ${bottom} Z`;
}
// A soft two-layer cloud for the pups to stand on, in place of the ground shadow.
const CloudGround = ({ width }: { width: number }) => <>
  <path d={cloudTop(width * 0.12, width * 0.76, 97, 118, [9, 15], 11)} fill="#f1e3d3" />
  <path d={cloudTop(width * 0.08, width * 0.84, 103, 118, [8, 13], 5)} fill="#ffffff" />
</>;

/** Layered clouds along the bottom edge of a section, as on joshwcomeau.com. The front layer should match the colour below. */
export function CloudEdge({ className, back = "#f8e7d4", front = "#ffffff" }: { className?: string; back?: string; front?: string }) {
  return <svg className={`dog-art cloud-edge ${className ?? ""}`} viewBox="0 0 1200 90" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <path d={cloudTop(-60, 1340, 62, 90, [24, 40], 7, true)} fill={back} />
    <path d={cloudTop(-60, 1340, 66, 90, [20, 32], 3, true)} fill={front} />
  </svg>;
}

/** Two pups sitting close, the small one leaning in. */
export function DogsTogether({ className }: { className?: string }) {
  return <svg className={`dog-art ${className ?? ""}`} viewBox="0 0 200 118" aria-hidden="true">
    <Ground width={200} />
    <Pup x={82} y={106} coat={caramel} tilt={7} />
    <Pup x={129} y={106} scale={0.8} coat={cream} tilt={-10} eyePatch tongue />
    <path d="M105 26 C105 21 98 20 98 26 C98 31 105 35 105 35 C105 35 112 31 112 26 C112 20 105 21 105 26 Z" fill="#e07a6b" stroke={outline} strokeWidth="1.5" strokeLinejoin="round" />
  </svg>;
}

/** Two pups playing: one begs for the ball while the other waits with its tongue out. */
export function DogsPlaying({ className, onCloud = false }: { className?: string; onCloud?: boolean }) {
  return <svg className={`dog-art ${className ?? ""}`} viewBox="0 0 220 118" aria-hidden="true">
    {onCloud ? <CloudGround width={220} /> : <Ground width={220} />}
    <Pup x={72} y={106} coat={caramel} tilt={9} paws="up" />
    <Pup x={152} y={106} scale={0.85} coat={cream} tilt={-12} eyePatch tongue />
    <path d="M88 26 Q98 10 109 22" fill="none" stroke="#c9b39b" strokeWidth="2" strokeDasharray="3 5" strokeLinecap="round" />
    <circle cx="117" cy="30" r="8.5" fill="#d9674f" stroke={outline} strokeWidth="2" />
    <path d="M110 26.5 Q117 31 124 26.5 M110 33.5 Q117 29 124 33.5" fill="none" stroke="#fff3e6" strokeWidth="1.5" strokeLinecap="round" />
  </svg>;
}

/** The DogMaAI mark: one pup's face. */
export function DogMark({ className }: { className?: string }) {
  return <svg className={`dog-art ${className ?? ""}`} viewBox="-31 -21 62 42" aria-hidden="true"><Head coat={caramel} /></svg>;
}

/** A pup asleep on its bed, for nap time. */
export function SleepyDog({ className }: { className?: string }) {
  return <svg className={`dog-art ${className ?? ""}`} viewBox="0 0 200 118" aria-hidden="true">
    <Ground width={200} />
    <ellipse cx="102" cy="100" rx="66" ry="13" fill="#e8d3bd" stroke={outline} strokeWidth="2" />
    <path d="M144 92 C158 90 166 80 160 71" fill="none" stroke={caramel.ear} strokeWidth="5" strokeLinecap="round" />
    <path d="M64 98 C60 74 88 64 114 67 C139 70 151 83 147 98 Z" fill={caramel.fur} stroke={outline} strokeWidth="2" strokeLinejoin="round" />
    <path d="M100 98 C98 86 106 78 116 79 C126 80 131 88 129 98 Z" fill={caramel.patch} />
    <ellipse cx="72" cy="97" rx="10" ry="4.6" fill={caramel.patch} stroke={outline} strokeWidth="1.8" />
    <g transform="translate(74 80) rotate(-10) scale(0.92)"><Head coat={caramel} sleepy /></g>
    <path d="M100 44 H109 L100 53 H109 M114 30 H121 L114 37 H121 M125 18 H130 L125 23 H130" fill="none" stroke="#9c8a78" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
