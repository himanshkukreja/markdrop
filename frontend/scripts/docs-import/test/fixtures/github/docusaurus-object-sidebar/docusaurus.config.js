// @ts-check
// A fictional Docusaurus config. The importer reads it as text; it never runs.
const config = {
  title: 'Acme Widgets',
  tagline: 'Widgets for every team',
  favicon: 'img/favicon.png',
  url: 'https://acme.example.com',
  baseUrl: '/',
  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.js',
        },
        blog: false,
      },
    ],
  ],
  themeConfig: {
    navbar: {
      title: 'Acme',
      logo: {
        alt: 'Acme logo',
        src: 'img/logo.png',
      },
    },
  },
};

module.exports = config;
