/** Airbag mark: a pixel "bag" bursting out of a square frame. */
export default function Logo({ className = "brand-mark" }: { className?: string }) {
  const px = [
    "..XXXX..",
    ".XXXXXX.",
    "XXXXXXXX",
    "XXXXXXXX",
    "XXXXXXXX",
    "XXXXXXXX",
    ".XXXXXX.",
    "..XXXX..",
  ];
  return (
    <svg className={className} viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden>
      <rect x="0.5" y="0.5" width="11" height="11" fill="none" stroke="#000000" strokeWidth="1" />
      {px.flatMap((row, y) =>
        [...row].map((c, x) =>
          c === "X" ? <rect key={`${x}-${y}`} x={x + 2} y={y + 2} width="1" height="1" fill={(x + y) % 3 === 0 ? "#d61f4f" : "#ff3366"} /> : null
        )
      )}
      <rect x="4" y="4" width="1" height="1" fill="#ffffff" />
    </svg>
  );
}
