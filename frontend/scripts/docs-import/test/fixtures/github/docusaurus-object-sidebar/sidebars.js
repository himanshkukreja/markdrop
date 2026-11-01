// @ts-check
/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  // The main docs.
  docs: [
    'intro',
    {
      type: 'category',
      label: 'Guides',
      link: { type: 'doc', id: 'guides/index' },
      items: [
        'guides/setup',
        { type: 'doc', id: 'guides/deploy', label: 'Deploy it' },
      ],
    },
    { type: 'link', label: 'Blog', href: 'https://example.com/acme-blog' },
  ],
  /* The API docs. */
  api: [`api/overview`],
};

module.exports = sidebars;
