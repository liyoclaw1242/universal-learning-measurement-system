import type { Preview } from '@storybook/react';
import '../src/styles/shell.css';

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    backgrounds: {
      default: 'canvas',
      values: [
        { name: 'canvas', value: '#f5f5f7' },
        { name: 'surface', value: '#ffffff' },
        { name: 'terminal', value: '#0a0a0a' },
      ],
    },
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/ } },
  },
};

export default preview;
