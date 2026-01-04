# TMA Cloud Wiki

Documentation wiki for TMA Cloud, built with Docusaurus.

## Development

```bash
npm install
npm start
```

This starts a local development server and opens up a browser window. Most changes are reflected live without having to restart the server.

## Build

```bash
npm run build
```

This command generates static content into the `build` directory and can be served using any static contents hosting service.

## Deployment

The wiki can be deployed to GitHub Pages, Netlify, Vercel, or any static hosting service.

### GitHub Pages

```bash
npm run deploy
```

This will build the wiki and deploy it to GitHub Pages.

## Structure

- `docs/` - Documentation markdown files
- `static/` - Static assets (images, etc.)
- `src/` - React components and CSS
- `docusaurus.config.ts` - Docusaurus configuration
- `sidebars.ts` - Sidebar navigation configuration

## Related

- [Main Repository](https://github.com/TMA-Cloud/TMA)
- [Documentation](https://tma-cloud.github.io)
