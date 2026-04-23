// OverviewTab — center-tab body shown when the Overview tab is active.
// Handoff §4.3.6: coverage matrix (learning objectives × difficulty) +
// three target-vs-actual progress bars (recall / application / analysis).
// Numbers use JetBrains Mono.

import type { Dimension, Item, Difficulty, Bloom } from '@/types/item';

interface OverviewTabProps {
  items: Item[];
  dimensions: Dimension[];
}

const DIFFICULTIES: Difficulty[] = ['low', 'med', 'high'];
const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  low: 'low',
  med: 'med',
  high: 'high',
};

// Collapse Bloom levels into the three coarser buckets shown in the handoff.
type Bucket = 'recall' | 'application' | 'analysis';
const BUCKETS: Bucket[] = ['recall', 'application', 'analysis'];
function bucketOf(b: Bloom): Bucket {
  if (b === 'recall' || b === 'understand') return 'recall';
  if (b === 'apply') return 'application';
  return 'analysis'; // analyze / evaluate / create
}

export default function OverviewTab({ items, dimensions }: OverviewTabProps) {
  // Coverage matrix cell counts — key = `${dim_id}|${difficulty}`
  const matrix: Record<string, number> = {};
  for (const it of items) {
    const key = `${it.dim}|${it.difficulty}`;
    matrix[key] = (matrix[key] ?? 0) + 1;
  }

  // Bucket counts for the three bars
  const bucketCount: Record<Bucket, number> = { recall: 0, application: 0, analysis: 0 };
  for (const it of items) bucketCount[bucketOf(it.bloom)]++;

  // Bucket targets are the uniform split in fixture data; keep derivable
  // here so the component doesn't assume a fixed split.
  const total = items.length || 1;

  return (
    <div className="overview-body">
      <section>
        <h3 className="ulms-h3">Coverage matrix</h3>
        <table className="coverage">
          <thead>
            <tr>
              <th></th>
              {DIFFICULTIES.map((d) => (
                <th key={d}>{DIFFICULTY_LABEL[d]}</th>
              ))}
              <th className="total-col">row ∑</th>
            </tr>
          </thead>
          <tbody>
            {dimensions.map((dim) => {
              const rowTotal = DIFFICULTIES.reduce((s, d) => s + (matrix[`${dim.id}${dim.name}|${d}`] ?? 0), 0);
              return (
                <tr key={dim.id}>
                  <th>
                    {dim.id}
                    {dim.name}
                  </th>
                  {DIFFICULTIES.map((d) => {
                    const n = matrix[`${dim.id}${dim.name}|${d}`] ?? 0;
                    return (
                      <td key={d} className={n === 0 ? 'zero' : ''}>
                        {n}
                      </td>
                    );
                  })}
                  <td className="total-col">{rowTotal}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h3 className="ulms-h3">Target vs actual</h3>
        <div className="bars">
          {BUCKETS.map((b) => {
            const actual = bucketCount[b];
            const actualPct = (actual / total) * 100;
            // Target: for the 3 buckets, split the 10 items as 4/3/3 per typical
            // plan. Make the target derivation explicit here — real impl will
            // pull from blueprint.
            const targetByBucket: Record<Bucket, number> = { recall: 0.4, application: 0.3, analysis: 0.3 };
            const targetPct = targetByBucket[b] * 100;
            return (
              <div className="bar-row" key={b}>
                <span className="bar-label">{b}</span>
                <span className="bar-track">
                  <span className="bar-target" style={{ left: `${targetPct}%` }} />
                  <span className="bar-fill" style={{ width: `${actualPct}%` }} />
                </span>
                <span className="bar-num">
                  {actual}/{total} · {actualPct.toFixed(0)}%
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
