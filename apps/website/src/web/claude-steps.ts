/** How to add the platform to Claude (spec 14, WEB-1.3). Images are @2x screenshots; sizes are CSS pixels. */
export type ClaudeStep = {
  title: string;
  text: string;
  image?: { src: string; width: number; height: number; alt: string };
  /** Shows the connector name and URL with copy buttons under this step. */
  showConnectorDetails?: boolean;
};

export const CLAUDE_STEPS: ClaudeStep[] = [
  {
    title: 'Open Settings',
    text: 'Open Claude (claude.ai or the Claude app), click your name in the bottom-left corner, then click Settings.',
    image: { src: '/claude/1-settings.png', width: 263, height: 411, alt: 'Claude menu with Settings highlighted' },
  },
  {
    title: 'Go to Connectors',
    text: 'In the Settings menu on the left, click Connectors.',
    image: {
      src: '/claude/2-connectors.png',
      width: 1024,
      height: 799,
      alt: 'Claude Settings with Connectors highlighted in the left menu',
    },
  },
  {
    title: 'Add our connector',
    text: 'Click "Add custom connector". Copy the name and the address below into the two fields, then click Add. Leave everything else as it is.',
    showConnectorDetails: true,
  },
  {
    title: 'Turn it on in a chat',
    text: 'Start a new chat. Click the tools button (the sliders icon under the message box) and make sure our connector is switched on.',
  },
];
