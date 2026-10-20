import { useEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from "react";
import { Numbers } from "./Whimsy";

// Chart colours, checked with the dataviz palette validator on the white card surface: the four activity colours pass
// the colour-blind separation checks in this order. Honey is below 3:1 on white, so every chart also has a table view.
export const colors = {
  resting: "#3b7dd8", moving: "#c8611f", playing: "#2f9e6e", eating: "#e0a100",
  // Moods in a stretch alone, checked with the same validator: blue like resting, orange like moving, and brick red.
  calm: "#5b9bd5", unsettled: "#e39b4b", upset: "#b8433a",
  // A stretch the camera did not see enough of: a dashed grey outline rather than a mood colour.
  unseen: "#9c9087",
  spot: "#4e7a6b", before: "#e2b48f", grid: "#f0e6da", axis: "#d6c6b3", ink: "#3a302a", muted: "#75685c", surface: "#ffffff"
};

type Show = (event: MouseEvent<Element> | FocusEvent<Element>, lines: string[]) => void;
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => setWidth(Math.floor(entries[0].contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

// Holds one chart's hover and focus tooltip. The value leads and the label follows.
export function ChartFrame({ label, children }: { label: string; children: (show: Show, hide: () => void, width: number) => ReactNode }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const show: Show = (event, lines) => {
    const frame = ref.current?.getBoundingClientRect();
    const mark = (event.currentTarget as Element).getBoundingClientRect();
    if (frame) setTip({ x: mark.left + mark.width / 2 - frame.left, y: mark.top - frame.top, lines });
  };
  return <div className="pa-frame" ref={ref} role="group" aria-label={label}>
    {width > 0 && children(show, () => setTip(null), width)}
    {tip && <div className="pa-tooltip" style={{ left: Math.max(70, Math.min(width - 70, tip.x)), top: Math.max(0, tip.y) }}>
      <strong>{tip.lines[0]}</strong>{tip.lines.slice(1).map(line => <span key={line}>{line}</span>)}
    </div>}
  </div>;
}

export interface TableData { head: string[]; rows: (string | number)[][] }
export function ChartCard({ icon, title, subtitle, table, tag, wide = false, children }: { icon: ReactNode; title: string; subtitle?: string; table?: TableData; tag?: string; wide?: boolean; children: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return <section className={`pa-card ${wide ? "pa-wide" : ""}`}>
    <header className="pa-card-head">
      <span className="pa-card-icon" aria-hidden="true">{icon}</span>
      <div><h3>{title}{tag && <> <span className="pa-tag">{tag}</span></>}</h3>{subtitle && <p><Numbers text={subtitle} /></p>}</div>
      {table && <button className="pa-table-toggle" data-sound="flip" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>{asTable ? "Chart" : "Table"}</button>}
    </header>
    {asTable && table ? <div className="pa-table-wrap"><table className="pa-table"><thead><tr>{table.head.map(cell => <th key={cell}>{cell}</th>)}</tr></thead><tbody>{table.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table></div> : children}
  </section>;
}

// A column rounded 4 px at its data end and square at the baseline.
const column = (x: number, y: number, width: number, height: number) => {
  const r = Math.min(4, height, width / 2);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
};
const barRight = (x: number, y: number, width: number, height: number) => {
  const r = Math.min(4, width, height / 2);
  return `M${x},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height - r}Q${x + width},${y + height} ${x + width - r},${y + height}H${x}Z`;
};

export interface ColumnDatum { key: string; axis: string; value: number | null; lines: string[] }
export function Columns({ data, max, color, ticks, format, label }: { data: ColumnDatum[]; max: number; color: string; ticks: number[]; format: (value: number) => string; label: string }) {
  return <ChartFrame label={label}>{(show, hide, width) => {
    const left = 44; const top = 8; const plot = 128; const height = top + plot + 22;
    const band = (width - left) / data.length;
    const thick = Math.min(24, Math.max(4, band * 0.62));
    const y = (value: number) => top + plot - (Math.min(value, max) / max) * plot;
    return <svg width={width} height={height} className="pa-svg">
      {ticks.map(tick => <g key={tick}><line x1={left} x2={width} y1={y(tick)} y2={y(tick)} stroke={tick === 0 ? colors.axis : colors.grid} strokeWidth="1" /><text x={left - 6} y={y(tick) + 3.5} textAnchor="end" className="pa-tick">{format(tick)}</text></g>)}
      {data.map((datum, index) => {
        const x = left + index * band + (band - thick) / 2;
        const drawn = datum.value !== null && datum.value > 0;
        return <g key={datum.key}>
          {drawn && <path d={column(x, y(datum.value!), thick, top + plot - y(datum.value!))} fill={color} />}
          {datum.axis && <text x={left + index * band + band / 2} y={top + plot + 15} textAnchor="middle" className="pa-tick">{datum.axis}</text>}
          <rect x={left + index * band} y={top} width={band} height={plot} fill="transparent" tabIndex={0} aria-label={datum.lines.join(", ")}
            onMouseEnter={event => show(event, datum.lines)} onFocus={event => show(event, datum.lines)} onMouseLeave={hide} onBlur={hide} />
        </g>;
      })}
    </svg>;
  }}</ChartFrame>;
}

export interface Segment { key: string; label: string; share: number; color: string; ink: string }
// One bar split into parts that add up to 100%, separated by 2 px of the surface colour.
export function SplitBar({ segments, label }: { segments: Segment[]; label: string }) {
  const shown = segments.filter(segment => segment.share > 0);
  return <div>
    <ChartFrame label={label}>{(show, hide, width) => {
      const gap = 2; const height = 30;
      const usable = width - gap * Math.max(0, shown.length - 1);
      let x = 0;
      return <svg width={width} height={height} className="pa-svg">
        {shown.map((segment, index) => {
          const segmentWidth = Math.max(2, usable * segment.share);
          const left = x; x += segmentWidth + gap;
          const first = index === 0; const last = index === shown.length - 1;
          const r = 6;
          const path = `M${left + (first ? r : 0)},0H${left + segmentWidth - (last ? r : 0)}${last ? `Q${left + segmentWidth},0 ${left + segmentWidth},${r}V${height - r}Q${left + segmentWidth},${height} ${left + segmentWidth - r},${height}` : `V${height}`}H${left + (first ? r : 0)}${first ? `Q${left},${height} ${left},${height - r}V${r}Q${left},0 ${left + r},0` : `V0`}Z`;
          const text = `${Math.round(segment.share * 100)}%`;
          const lines = [text, segment.label];
          return <g key={segment.key}>
            <path d={path} fill={segment.color} />
            {segmentWidth >= 44 && <text x={left + segmentWidth / 2} y={height / 2 + 4} textAnchor="middle" className="pa-inside" fill={segment.ink}>{text}</text>}
            <rect x={left} y={0} width={segmentWidth + gap} height={height} fill="transparent" tabIndex={0} aria-label={lines.join(", ")} onMouseEnter={event => show(event, lines)} onFocus={event => show(event, lines)} onMouseLeave={hide} onBlur={hide} />
          </g>;
        })}
      </svg>;
    }}</ChartFrame>
    <ul className="pa-legend">{segments.map(segment => <li key={segment.key}><i style={{ background: segment.color }} />{segment.label}<b>{Math.round(segment.share * 100)}%</b></li>)}</ul>
  </div>;
}

export interface DayItem { key: string; day: string; start: number; end?: number; color: string; hollow?: boolean; lines: string[] }
// One row per day across the hours of the day: dots for moments, bars for spans.
export function DayRows({ days, items, from, to, ticks, label }: { days: { key: string; label: string }[]; items: DayItem[]; from: number; to: number; ticks: { minute: number; label: string }[]; label: string }) {
  return <ChartFrame label={label}>{(show, hide, width) => {
    const left = 48; const row = 26; const height = days.length * row + 24;
    const x = (minute: number) => left + ((Math.min(to, Math.max(from, minute)) - from) / (to - from)) * (width - left - 8);
    return <svg width={width} height={height} className="pa-svg">
      {ticks.map(tick => <g key={tick.minute}><line x1={x(tick.minute)} x2={x(tick.minute)} y1={0} y2={days.length * row} stroke={colors.grid} /><text x={x(tick.minute)} y={days.length * row + 16} textAnchor="middle" className="pa-tick">{tick.label}</text></g>)}
      {days.map((day, index) => <g key={day.key}>
        <line x1={left} x2={width - 8} y1={index * row + row / 2} y2={index * row + row / 2} stroke={colors.grid} />
        <text x={0} y={index * row + row / 2 + 4} className="pa-tick pa-day">{day.label}</text>
      </g>)}
      {items.map(item => {
        const index = days.findIndex(day => day.key === item.day);
        if (index < 0) return null;
        const cy = index * row + row / 2;
        const handlers = { tabIndex: 0, "aria-label": item.lines.join(", "), onMouseEnter: (event: MouseEvent<Element>) => show(event, item.lines), onFocus: (event: FocusEvent<Element>) => show(event, item.lines), onMouseLeave: hide, onBlur: hide };
        if (item.end !== undefined) {
          const x1 = x(item.start); const x2 = Math.max(x1 + 3, x(item.end));
          // Square dash ends: the page's round line caps would close the gaps.
          const outline = item.hollow ? { fill: colors.surface, stroke: item.color, strokeWidth: 1.5, strokeDasharray: "4 3", strokeLinecap: "butt" as const } : { fill: item.color };
          return <g key={item.key}><rect x={x1} y={cy - 5} width={x2 - x1} height={10} rx={4} {...outline} /><rect x={x1 - 4} y={cy - 12} width={x2 - x1 + 8} height={24} fill="transparent" {...handlers} /></g>;
        }
        return <g key={item.key}>
          <circle cx={x(item.start)} cy={cy} r={6} fill={colors.surface} />
          <circle cx={x(item.start)} cy={cy} r={item.hollow ? 4 : 5} fill={item.hollow ? colors.surface : item.color} stroke={item.color} strokeWidth={item.hollow ? 2.5 : 0} />
          <circle cx={x(item.start)} cy={cy} r={12} fill="transparent" {...handlers} />
        </g>;
      })}
    </svg>;
  }}</ChartFrame>;
}

export interface BarRow { key: string; label: string; value: number; text: string; lines: string[] }
// Horizontal bars in one colour, with the value at each bar's tip.
export function Bars({ rows, color, label }: { rows: BarRow[]; color: string; label: string }) {
  return <ChartFrame label={label}>{(show, hide, width) => {
    // The label column fits the longest label, at about 7 px a character, and the room past each bar fits its value,
    // such as "1 h 45 min", at about 6.5 px a character.
    const left = Math.max(86, ...rows.map(item => item.label.length * 7 + 12)); const row = 30;
    const room = Math.max(44, ...rows.map(item => Math.ceil(item.text.length * 6.5) + 10));
    const x = (value: number) => Math.max(0, value) * (width - left - room);
    return <svg width={width} height={rows.length * row} className="pa-svg">
      {rows.map((item, index) => <g key={item.key}>
        <text x={0} y={index * row + 19} className="pa-label">{item.label}</text>
        <path d={barRight(left, index * row + 7, Math.max(2, x(item.value)), 16)} fill={color} />
        <text x={left + x(item.value) + 6} y={index * row + 19} className="pa-value">{item.text}</text>
        <rect x={0} y={index * row} width={width} height={row} fill="transparent" tabIndex={0} aria-label={item.lines.join(", ")} onMouseEnter={event => show(event, item.lines)} onFocus={event => show(event, item.lines)} onMouseLeave={hide} onBlur={hide} />
      </g>)}
    </svg>;
  }}</ChartFrame>;
}

export interface DumbbellRow { key: string; label: string; before: number; after: number; lines: string[] }
// Before and after on one scale: the lighter shade is before, the darker after.
export function Dumbbell({ rows, label }: { rows: DumbbellRow[]; label: string }) {
  return <div>
    <ChartFrame label={label}>{(show, hide, width) => {
      const left = 104; const row = 34; const right = 60;
      const x = (share: number) => left + share * (width - left - right);
      return <svg width={width} height={rows.length * row + 20} className="pa-svg">
        {[0, 0.5, 1].map(tick => <g key={tick}><line x1={x(tick)} x2={x(tick)} y1={0} y2={rows.length * row} stroke={colors.grid} /><text x={x(tick)} y={rows.length * row + 14} textAnchor="middle" className="pa-tick">{Math.round(tick * 100)}%</text></g>)}
        {rows.map((item, index) => {
          const cy = index * row + row / 2;
          const change = Math.round((item.after - item.before) * 100);
          return <g key={item.key}>
            <text x={0} y={cy + 4} className="pa-label">{item.label}</text>
            <line x1={x(item.before)} x2={x(item.after)} y1={cy} y2={cy} stroke={colors.axis} strokeWidth="2" strokeLinecap="round" />
            <circle cx={x(item.before)} cy={cy} r={6} fill={colors.before} stroke={colors.surface} strokeWidth="2" />
            <circle cx={x(item.after)} cy={cy} r={6} fill={colors.moving} stroke={colors.surface} strokeWidth="2" />
            <text x={width - right + 8} y={cy + 4} className="pa-value">{change > 0 ? "+" : change < 0 ? "−" : ""}{Math.abs(change)} pts</text>
            <rect x={0} y={index * row} width={width} height={row} fill="transparent" tabIndex={0} aria-label={item.lines.join(", ")} onMouseEnter={event => show(event, item.lines)} onFocus={event => show(event, item.lines)} onMouseLeave={hide} onBlur={hide} />
          </g>;
        })}
      </svg>;
    }}</ChartFrame>
    <ul className="pa-legend"><li><i style={{ background: colors.before }} />15 min before</li><li><i style={{ background: colors.moving }} />15 min after</li></ul>
  </div>;
}
