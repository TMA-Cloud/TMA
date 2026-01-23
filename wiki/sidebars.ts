import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  tutorialSidebar: [
    "intro",
    {
      type: "category",
      label: "Getting Started",
      items: [
        "getting-started/overview",
        "getting-started/installation",
        "getting-started/docker",
        "getting-started/agent-setup",
        "getting-started/environment-setup",
        "getting-started/first-login",
      ],
    },
    {
      type: "category",
      label: "Concepts",
      items: [
        "concepts/architecture",
        "concepts/authentication",
        "concepts/authorization",
        "concepts/file-system",
        "concepts/sharing-model",
        "concepts/storage-management",
        "concepts/security-model",
      ],
    },
    {
      type: "category",
      label: "User Guides",
      items: [
        "guides/user/upload-files",
        "guides/user/manage-folders",
        "guides/user/share-files",
        "guides/user/starred-files",
        "guides/user/trash-restore",
      ],
    },
    {
      type: "category",
      label: "Admin Guides",
      items: [
        "guides/admin/user-management",
        "guides/admin/storage-limits",
        "guides/admin/signup-control",
        "guides/admin/mfa-management",
        "guides/admin/custom-drives",
      ],
    },
    {
      type: "category",
      label: "Operations",
      items: [
        "guides/operations/audit-logs",
        "guides/operations/logging",
        "guides/operations/background-workers",
        "guides/operations/monitoring",
        "guides/operations/backups",
      ],
    },
    {
      type: "category",
      label: "API Reference",
      items: [
        "api/overview",
        "api/authentication",
        "api/sessions",
        "api/files",
        "api/sharing",
        "api/users",
        "api/onlyoffice",
        "api/monitoring",
        "api/agent",
        "api/errors",
        "api/examples",
      ],
    },
    {
      type: "category",
      label: "Debugging",
      items: [
        "debugging/overview",
        "debugging/common-errors",
        "debugging/auth-issues",
        "debugging/upload-issues",
        "debugging/audit-issues",
        "debugging/redis-issues",
        "debugging/docker-issues",
        "debugging/onlyoffice-issues",
      ],
    },
    {
      type: "category",
      label: "Reference",
      items: [
        "reference/environment-variables",
        "reference/database-schema",
        "reference/audit-events",
        "reference/error-codes",
        "reference/rate-limits",
        "reference/cli-commands",
      ],
    },
    {
      type: "category",
      label: "Changelog",
      items: ["changelog/overview", "changelog/v2", "changelog/v1"],
    },
  ],
};

export default sidebars;
