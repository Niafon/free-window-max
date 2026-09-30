import type { Candidate } from '../../../packages/contracts/index';
const hh = (t: number | string) => new Date(t).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const minute = 60000;
type Span = { from: string; to: string };
// One member's plan inside the free window: road there → event → road back → spare time.
export function WindowTimeline({ window, c, member = 0, compact = false }: { window: Span; c: Candidate; member?: number; compact?: boolean }) {
  const m = c.members[member]; if (!m) return null;
  const from = Date.parse(window.from), to = Date.parse(window.to), start = Date.parse(c.startAt), end = Date.parse(c.endAt), back = Date.parse(m.returnAt);
  const depart = start - (m.travel.outbound + 10) * minute;
  const lo = Math.min(from, depart), hi = Math.max(to, back), pct = (t: number) => `${((t - lo) / (hi - lo)) * 100}%`, width = (a: number, b: number) => `${Math.max(0, ((b - a) / (hi - lo)) * 100)}%`;
  return <div className={`window-timeline ${compact ? 'compact' : ''}`} role="img" aria-label={`Выйти в ${hh(depart)}, событие ${hh(start)}–${hh(end)}, вернуться к ${hh(back)}, запас ${m.spareMinutes} минут`}>
    <div className="wt-bar">
      <span className="wt-window" style={{ left: pct(from), width: width(from, to) }}/>
      <span className="wt-road" style={{ left: pct(depart), width: width(depart, start) }}/>
      <span className="wt-event" style={{ left: pct(start), width: width(start, end) }}/>
      <span className="wt-road" style={{ left: pct(end), width: width(end, back) }}/>
      {back < to && <span className="wt-spare" style={{ left: pct(back), width: width(back, to) }}/>}
    </div>
    {compact ? <div className="wt-labels"><span>{hh(from)}</span><span>выйти {hh(depart)}</span><span>{hh(to)}</span></div>
      : <div className="wt-legend"><span><i className="wt-road"/>Выйти {hh(depart)} · {m.travel.outbound} мин</span><span><i className="wt-event"/>{hh(start)}–{hh(end)}</span><span><i className="wt-road"/>Дома {hh(back)}</span><span><i className="wt-spare"/>Запас {m.spareMinutes} мин</span></div>}
  </div>;
}
// Everyone's free time on one axis with the common window highlighted.
export function GroupWindows({ members, meId }: { members: Array<{ userId: string; name: string; window: Span | null }>; meId?: string }) {
  const ready = members.filter(m => m.window);
  if (ready.length < 1) return null;
  const lo = Math.min(...ready.map(m => Date.parse(m.window!.from))), hi = Math.max(...ready.map(m => Date.parse(m.window!.to)));
  const common = { from: Math.max(...ready.map(m => Date.parse(m.window!.from))), to: Math.min(...ready.map(m => Date.parse(m.window!.to))) };
  const pct = (t: number) => `${((t - lo) / (hi - lo || 1)) * 100}%`, width = (a: number, b: number) => `${Math.max(0, ((b - a) / (hi - lo || 1)) * 100)}%`;
  const overlap = common.from < common.to;
  return <div className="group-windows">
    <div className="gw-title">{ready.length < 2 ? 'Окна участников появятся здесь' : overlap ? <>Общее окно <b>{hh(common.from)}–{hh(common.to)}</b></> : <span className="gw-none">Общего окна пока нет — кому-то нужно освободиться раньше или позже</span>}</div>
    <div className="gw-rows">
      {ready.length > 1 && overlap && <div className="gw-overlay"><span className="gw-common" style={{ left: pct(common.from), width: width(common.from, common.to) }}/></div>}
      {ready.map(m => <div className="gw-row" key={m.userId}><span className="gw-name">{m.name}{m.userId === meId ? ' (ты)' : ''}</span><div className="gw-track"><span className="gw-bar" style={{ left: pct(Date.parse(m.window!.from)), width: width(Date.parse(m.window!.from), Date.parse(m.window!.to)) }}>{hh(m.window!.from)}–{hh(m.window!.to)}</span></div></div>)}
    </div>
  </div>;
}
