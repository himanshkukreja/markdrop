import type { Config } from '@docusaurus/types';

// A fictional config: the docs live in content/ and are the site root.
const config: Config = {
  title: 'Acme Handbook',
  url: 'https://handbook.acme.example.com',
  baseUrl: '/',
  presets: [
    [
      'classic',
      {
        docs: {
          path: 'content',
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
        },
      },
    ],
  ],
};

export default config;
