import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "TMA Cloud",
  tagline: "Self-hosted Cloud Storage Platform",

  future: {
    v4: true,
  },

  url: "https://tma-cloud.github.io",
  baseUrl: "/",

  organizationName: "TMA-Cloud",
  projectName: "TMA",

  onBrokenLinks: "throw",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  plugins: [
    [
      require.resolve("@easyops-cn/docusaurus-search-local"),
      {
        indexBlog: false,
        indexPages: false,
        hashed: false,
        language: ["en"],
        docsRouteBasePath: "/",
        searchBarShortcut: true,
        searchBarShortcutHint: true,
      },
    ],
  ],

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "/",
          editUrl: "https://github.com/TMA-Cloud/TMA/tree/main/wiki/",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: false,
      defaultMode: "dark",
      disableSwitch: false,
    },
    navbar: {
      title: "TMA Cloud",
      logo: {
        alt: "TMA Cloud Logo",
        src: "img/logo.svg",
        width: 32,
        height: 32,
      },
      hideOnScroll: true,
      items: [
        {
          type: "docSidebar",
          sidebarId: "tutorialSidebar",
          position: "left",
          label: "Documentation",
        },
        {
          href: "https://github.com/TMA-Cloud/TMA",
          label: "GitHub",
          position: "right",
          className: "header-github-link",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Documentation",
          items: [
            {
              label: "Getting Started",
              to: "/getting-started/overview",
            },
            {
              label: "API Reference",
              to: "/api/overview",
            },
            {
              label: "Concepts",
              to: "/concepts/architecture",
            },
          ],
        },
        {
          title: "Guides",
          items: [
            {
              label: "User Guides",
              to: "/guides/user/upload-files",
            },
            {
              label: "Admin Guides",
              to: "/guides/admin/user-management",
            },
            {
              label: "Operations",
              to: "/guides/operations/audit-logs",
            },
          ],
        },
        {
          title: "Resources",
          items: [
            {
              label: "GitHub",
              href: "https://github.com/TMA-Cloud/TMA",
            },
            {
              label: "Debugging",
              to: "/debugging/overview",
            },
            {
              label: "Reference",
              to: "/reference/environment-variables",
            },
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} TMA Cloud, All rights reserved.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "sql"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
