// Build version, stamped by tools/build-pages.mjs on deploy ("dev" when served locally).
// Asset URLs carry it so GitHub Pages' cache can't serve stale files after a deploy.
export const VERSION = "dev";
export const assetQuery = VERSION === "dev" ? "" : `?v=${VERSION}`;
