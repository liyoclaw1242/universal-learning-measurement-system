import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import NavRail from './index';
import ShellFrame from '../../stories/ShellFrame';
import { items as fxItems, agents as fxAgents } from '../../fixtures';
import type { AgentId } from '../../types/agent';
import type { Stage } from '../../types/session';

function ReviewStory() {
  const [selectedItem, setSelectedItem] = useState<string | null>('item_003');
  return (
    <ShellFrame
      rail={
        <NavRail
          stage={'review'}
          items={fxItems}
          selectedItemId={selectedItem}
          onSelectItem={setSelectedItem}
        />
      }
    />
  );
}

function RunningStory({ stage }: { stage: Stage }) {
  const [activeAgent, setActiveAgent] = useState<AgentId | null>('agent-2');
  return (
    <ShellFrame
      rail={
        <NavRail
          stage={stage}
          agents={fxAgents}
          activeAgentId={activeAgent}
          onSelectAgent={setActiveAgent}
          expandedAgentId={activeAgent}
        />
      }
    />
  );
}

const meta: Meta = {
  title: 'Shell/NavRail',
  parameters: { layout: 'fullscreen' },
};
export default meta;

export const Review: StoryObj = { render: () => <ReviewStory /> };
export const Running: StoryObj = { render: () => <RunningStory stage="running" /> };
