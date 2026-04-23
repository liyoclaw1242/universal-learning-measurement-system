import type { Meta, StoryObj } from '@storybook/react';
import ItemDetailTab from './index';
import { items as fxItems, itemChecks, itemCode, itemOptions, sourceExcerpt } from '../../fixtures';

const meta: Meta<typeof ItemDetailTab> = {
  title: 'TabBody/ItemDetailTab',
  component: ItemDetailTab,
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj<typeof ItemDetailTab>;

const item003 = fxItems.find((i) => i.id === 'item_003')!;
const item004 = fxItems.find((i) => i.id === 'item_004')!;

export const AcceptedAgreement: Story = {
  args: {
    item: item003,
    options: itemOptions.item_003,
    checks: itemChecks.item_003,
    stemCode: itemCode.item_003,
    sourceExcerpt: sourceExcerpt.item_003,
  },
  name: 'item_003 · accept · C = G',
};

export const Disagreement: Story = {
  args: {
    item: item004,
    checks: itemChecks.item_004,
  },
  name: 'item_004 · disagree · C ≠ G',
};

export const BareMinimum: Story = {
  args: { item: fxItems[0] },
  name: 'No options / checks / excerpt (loading state)',
};
