// The network in one drawing: your computer talks to each provider's machine directly, the Solana program only holds
// the channels underneath, and the place a server would sit is empty. Names, regions and prices come from the
// rehearsal. The moving dots are SMIL and stop under reduced motion (CSS hides them).
import { perM, rehearsal } from '@/lib/rehearsal';

const W = 720;
const H = 372;
const ROUTER = { x: 24, y: 118, w: 196, h: 116 };
const PROV_X = 500;
const PROV_W = 196;
const PROV_H = 74;
const PROG = { x: 236, y: 318, w: 248, h: 38 };

export default function P2PDiagram() {
  const provs = rehearsal.providers.slice(0, 3).map((p, i) => ({
    name: p.name,
    region: p.region,
    from: perM(Math.min(...p.models.map((m) => m.input))),
    y: 22 + i * 98,
  }));
  const rx = ROUTER.x + ROUTER.w;
  const ry = ROUTER.y + ROUTER.h / 2;
  const paths = provs.map((p) => {
    const py = p.y + PROV_H / 2;
    return `M${rx} ${ry} C${rx + 120} ${ry}, ${PROV_X - 120} ${py}, ${PROV_X} ${py}`;
  });
  return (
    <figure className="p2p">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Your computer connects directly to each provider's machine. The Solana program holds payment channels underneath. There is no server in the middle.">
        <defs>
          <linearGradient id="p2p-sol" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#9945ff" />
            <stop offset="0.5" stopColor="#5f8ff2" />
            <stop offset="1" stopColor="#14f195" />
          </linearGradient>
        </defs>

        <g className="p2p__ghost">
          <rect x={300} y={146} width={120} height={60} rx={12} />
          <line x1={318} y1={160} x2={402} y2={192} />
          <text x={360} y={226} textAnchor="middle">no server in the middle</text>
        </g>

        {paths.map((d, i) => (
          <g key={i}>
            <path d={d} className="p2p__link" id={`p2p-l${i}`} />
            <circle r={3.4} className="p2p__out" opacity={0}>
              <set attributeName="opacity" to="1" begin={`${i * 0.9}s`} />
              <animateMotion dur="2.8s" begin={`${i * 0.9}s`} repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1" calcMode="linear">
                <mpath href={`#p2p-l${i}`} />
              </animateMotion>
            </circle>
            <circle r={3.4} className="p2p__back" opacity={0}>
              <set attributeName="opacity" to="1" begin={`${i * 0.9 + 1.4}s`} />
              <animateMotion dur="2.8s" begin={`${i * 0.9 + 1.4}s`} repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear">
                <mpath href={`#p2p-l${i}`} />
              </animateMotion>
            </circle>
          </g>
        ))}

        <path d={`M${ROUTER.x + ROUTER.w / 2} ${ROUTER.y + ROUTER.h} V${PROG.y + PROG.h / 2} H${PROG.x}`} className="p2p__chain" />
        <path d={`M${PROV_X + PROV_W / 2} ${provs[2].y + PROV_H} V${PROG.y + PROG.h / 2} H${PROG.x + PROG.w}`} className="p2p__chain" />
        <text x={ROUTER.x + ROUTER.w / 2 + 8} y={290} className="p2p__tag">deposit</text>
        <text x={PROV_X + PROV_W / 2 - 8} y={PROG.y - 8} textAnchor="end" className="p2p__tag">redeem</text>

        <g>
          <rect x={ROUTER.x} y={ROUTER.y} width={ROUTER.w} height={ROUTER.h} rx={16} className="p2p__box p2p__box--you" />
          <text x={ROUTER.x + 18} y={ROUTER.y + 28} className="p2p__cap">Your computer</text>
          <text x={ROUTER.x + 18} y={ROUTER.y + 62} className="p2p__name">Router</text>
          <text x={ROUTER.x + 18} y={ROUTER.y + 86} className="p2p__mono">127.0.0.1:7171</text>
          <circle cx={rx} cy={ry} r={4} className="p2p__port" />
        </g>

        {provs.map((p) => (
          <g key={p.name}>
            <rect x={PROV_X} y={p.y} width={PROV_W} height={PROV_H} rx={14} className="p2p__box" />
            <text x={PROV_X + 16} y={p.y + 30} className="p2p__name p2p__name--sm">{p.name}</text>
            <text x={PROV_X + 16} y={p.y + 52} className="p2p__mono">{p.region} · from {p.from}/M</text>
            <circle cx={PROV_X} cy={p.y + PROV_H / 2} r={4} className="p2p__port" />
          </g>
        ))}

        <g>
          <rect x={PROG.x} y={PROG.y} width={PROG.w} height={PROG.h} rx={19} className="p2p__prog" />
          <text x={PROG.x + PROG.w / 2} y={PROG.y + 24} textAnchor="middle" className="p2p__progt">Solana program · channels · 0% fee</text>
        </g>
      </svg>
      <figcaption>
        Requests and answers go straight between your router and the provider&apos;s machine. The program only holds each
        channel&apos;s deposit: a provider redeems what you signed, the rest comes back to you.
      </figcaption>
    </figure>
  );
}
