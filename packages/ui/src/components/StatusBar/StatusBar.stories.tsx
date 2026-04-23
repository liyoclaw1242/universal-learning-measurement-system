import type { Meta, StoryObj } from '@storybook/react';
import StatusBar from './index';
import ShellFrame from '../../stories/ShellFrame';
import type { Session, Stage } from '../../types/session';

const demoSession: Session = {
  id: '7f3a8c2d',
  project: 'rust-book-ch04',
  material: 'rust-book-ch04-ownership.md',
  elapsed_s: 47.2,
  cost_usd: 0.42,
  cost_cap: 1.0,
  status: 'review',
};

function StatusBarStory({ stage, status }: { stage: Stage; status: Session['status'] }) {
  return (
    <ShellFrame
      status={<StatusBar session={{ ...demoSession, status }} stage={stage} onToggleStage={() => {}} versionLabel="ULMS · storybook" />}
    />
  );
}

const meta: Meta<typeof StatusBarStory> = {
  title: 'Shell/StatusBar',
  component: StatusBarStory,
  parameters: { layout: 'fullscreen' },
};
export default meta;

type Story = StoryObj<typeof StatusBarStory>;

export const Idle: Story = { args: { stage: 'inputs', status: 'idle' } };
export const Running: Story = { args: { stage: 'running', status: 'running' } };
export const Ready: Story = { args: { stage: 'review', status: 'review' } };
export const Failed: Story = { args: { stage: 'review', status: 'failed' } };
