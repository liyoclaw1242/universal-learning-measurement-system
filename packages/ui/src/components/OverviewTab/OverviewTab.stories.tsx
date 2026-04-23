import type { Meta, StoryObj } from '@storybook/react';
import OverviewTab from './index';
import { items as fxItems, dimensions as fxDimensions } from '../../fixtures';

const meta: Meta<typeof OverviewTab> = {
  title: 'TabBody/OverviewTab',
  component: OverviewTab,
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj<typeof OverviewTab>;

export const Default: Story = { args: { items: fxItems, dimensions: fxDimensions } };

export const OneDimensionEmpty: Story = {
  args: {
    items: fxItems.filter((it) => it.dim !== '②概念'),
    dimensions: fxDimensions,
  },
  name: 'Coverage gap (no ②概念 items)',
};
