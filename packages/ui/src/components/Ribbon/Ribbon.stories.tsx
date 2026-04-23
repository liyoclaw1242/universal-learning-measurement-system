import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import Ribbon, { type RibbonTab } from './index';
import ShellFrame from '../../stories/ShellFrame';
import type { Session, Stage, Density } from '../../types/session';

const demoSession: Session = {
  id: '7f3a8c2d',
  project: 'rust-book-ch04',
  material: 'rust-book-ch04-ownership.md',
  elapsed_s: 47.2,
  cost_usd: 0.42,
  cost_cap: 1.0,
  status: 'review',
};

// Ribbon spans the strip / tabs / body rows of the grid; we inject it
// into ShellFrame's `strip` slot and null out the other two slots so
// ShellFrame's placeholders don't collide.
function RibbonStory({ stage, spent }: { stage: Stage; spent: number }) {
  const [tab, setTab] = useState<RibbonTab>('home');
  const [density, setDensity] = useState<Density>('standard');
  return (
    <ShellFrame
      density={density}
      strip={
        <Ribbon
          session={{ ...demoSession, cost_usd: spent }}
          stage={stage}
          activeTab={tab}
          density={density}
          onTabChange={setTab}
          onDensityChange={setDensity}
          onRunSecondOpinion={() => {}}
          onExport={() => {}}
        />
      }
      tabs={<></>}
      body={<></>}
    />
  );
}

const meta: Meta<typeof RibbonStory> = {
  title: 'Shell/Ribbon',
  component: RibbonStory,
  parameters: { layout: 'fullscreen' },
};
export default meta;

type Story = StoryObj<typeof RibbonStory>;

export const Inputs: Story = { args: { stage: 'inputs', spent: 0 } };
export const Running: Story = { args: { stage: 'running', spent: 0.42 } };
export const Review: Story = { args: { stage: 'review', spent: 0.42 } };
export const CostWarn: Story = {
  args: { stage: 'running', spent: 0.78 },
  name: 'Cost chip · warn (>70%)',
};
export const CostOver: Story = {
  args: { stage: 'running', spent: 0.98 },
  name: 'Cost chip · over (>95%)',
};
