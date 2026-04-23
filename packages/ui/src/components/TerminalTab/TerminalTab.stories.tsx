import type { Meta, StoryObj } from '@storybook/react';
import TerminalTab from './index';
import { streamLog } from '../../fixtures';

const meta: Meta<typeof TerminalTab> = {
  title: 'TabBody/TerminalTab',
  component: TerminalTab,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div style={{ height: '100vh', width: '100vw', display: 'flex' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <Story />
        </div>
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof TerminalTab>;

export const Agent1: Story = { args: { agentId: 'agent-1', streamLog } };
export const Agent2: Story = { args: { agentId: 'agent-2', streamLog } };
export const Unified: Story = { args: { agentId: 'unified', streamLog } };
