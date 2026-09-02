# Roadmap

Portfolio Generator is focused on reliable website capture and polished portfolio assets with very little setup. This document covers the remaining product work without committing to release dates.

## Available now

- Live URL and saved-site imports
- Separate or mixed multi-site portfolios
- Desktop, tablet, and mobile capture
- Display images, device mockups, showcases, screenshots, and motion exports
- Capture quality checks and automatic fallback attempts
- Reproducible seeded layouts
- SVG, PNG, JPEG, MP4, GIF, and ZIP export
- Native macOS application and Windows packaging
- Complete local browser interface

## Planned

### More layout variety

Add further mockup and showcase arrangements while keeping the current automatic workflow straightforward.

### Preview adjustments

Allow background and corner-radius changes from the preview without turning the app into a full design editor.

### Hosted web version

The local browser interface is complete, but public hosting still needs:

- A durable job queue and concurrency limits
- Rate limiting and URL-fetch protections
- Temporary output storage and automatic cleanup
- Deployment monitoring and abuse controls

Until those safeguards are in place, the app should run locally.

### Authenticated page capture

Explore a browser extension for capturing signed-in pages that cannot be reached by the current isolated browser session.

## Outside the current scope

- Multi-user accounts and cloud project storage
- A full drag-and-drop layout editor
- Editing the source website
- A template marketplace

Portfolio Generator will continue to favour dependable capture, strong automatic layouts, and exports that are easy to finish in a design tool.
