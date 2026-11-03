// Lazy-loaded chart half of the Host health card — recharts stays out of the
// main chunk (it's ~114KB gz; only this view pays for it).
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import type { HostStats } from '../lib/daemon';

export default function HostHealthChart({ history }: { history: HostStats['history'] }) {
  const data = history.map((h) => ({
    t: h.ts.slice(11, 16),
    cpu: Math.round(h.cpu_pct),
    gpu: h.gpu_pct == null ? null : Math.round(h.gpu_pct),
    mem: h.mem_total > 0 ? Math.round((h.mem_used / h.mem_total) * 100) : 0,
  }));
  return (
    <ResponsiveContainer width="100%" height={140}>
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -22 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-gilt-b)" />
        <XAxis dataKey="t" stroke="var(--g-mut)" style={{ fontSize: 10 }} tickLine={false} minTickGap={40} />
        <YAxis domain={[0, 100]} stroke="var(--g-mut)" style={{ fontSize: 10 }} tickLine={false} />
        <Tooltip
          contentStyle={{ backgroundColor: 'var(--color-base)', border: '1px solid var(--color-gilt-a)', borderRadius: 3, fontSize: 11 }}
          labelStyle={{ color: 'var(--color-text)' }}
          formatter={(v, name) => [`${String(v ?? '')}%`, name === 'cpu' ? 'CPU' : name === 'gpu' ? 'GPU' : 'Memory']}
        />
        <Line type="monotone" dataKey="cpu" stroke="var(--color-primary)" strokeWidth={1.5} dot={false} />
        <Line type="monotone" dataKey="gpu" stroke="var(--color-success)" strokeWidth={1.5} dot={false} connectNulls />
        <Line type="monotone" dataKey="mem" stroke="var(--color-warning)" strokeWidth={1.5} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
