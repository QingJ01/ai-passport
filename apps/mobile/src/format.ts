// Display helpers shared by the screens. Pure, so they are unit tested.

// 52340 -> "52.3K", 12300000 -> "12.3M" (truncated, like the device's usage page).
export function compact(value: unknown): string | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(\.\d+)?$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, unit] of units)
    if (n >= size) {
      const scaled = Math.floor((n / size) * 10) / 10;
      return `${scaled % 1 === 0 ? scaled.toFixed(0) : scaled.toFixed(1)}${unit}`;
    }
  return String(Math.floor(n));
}

// "刚刚", "12 秒前", "3 分钟前", "2 小时前", otherwise month and day.
export function ago(iso: string | null | undefined, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const d = new Date(t);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export type Tone = "good" | "warn" | "bad" | "idle";
const TASK: Record<string, [string, Tone]> = {
  running: ["进行中", "good"],
  waiting_user: ["等你处理", "warn"],
  queued: ["排队中", "idle"],
  idle: ["空闲", "idle"],
  completed: ["已完成", "idle"],
  failed: ["失败", "bad"],
  cancelled: ["已取消", "idle"],
};
// Chinese label and colour tone for a task state; unknown states pass through.
export function taskState(state?: string): [string, Tone] {
  return (state && TASK[state]) || [state || "未知", "idle"];
}

// Which state to show: an outcome or a request for input beats "running/idle".
export function effectiveState(t: {
  state?: string;
  execution_state?: string;
}) {
  const outcome = ["waiting_user", "completed", "failed", "cancelled"];
  return t.state && outcome.includes(t.state)
    ? t.state
    : (t.execution_state ?? t.state);
}
