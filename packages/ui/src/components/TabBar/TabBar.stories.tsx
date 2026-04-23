import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import TabBar, { type Tab } from './index';
import ShellFrame from '../../stories/ShellFrame';

const demoTabs: Tab[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'item_003', label: 'item_003', closable: true },
  { id: 'term-unified', label: 'unified', glyph: 'cog', closable: true },
  { id: 'term-agent-2', label: 'agent-2', glyph: 'cog', closable: true },
];

function TabBarStory() {
  const [tabs, setTabs] = useState(demoTabs);
  const [active, setActive] = useState<string>('item_003');
  return (
    <ShellFrame
      center={
        <section className="center">
          <TabBar
            tabs={tabs}
            activeTabId={active}
            onActivate={setActive}
            onClose={(id) => {
              setTabs((prev) => prev.filter((t) => t.id !== id));
              if (active === id) setActive('overview');
            }}
            onAdd={() => {}}
          />
          <div className="tab-body" style={{ padding: 20 }}>
            <p className="ulms-meta">(active tab body is {active})</p>
          </div>
        </section>
      }
    />
  );
}

const meta: Meta = {
  title: 'Shell/TabBar',
  parameters: { layout: 'fullscreen' },
};
export default meta;

export const Default: StoryObj = { render: () => <TabBarStory /> };
