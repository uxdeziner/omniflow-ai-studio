// Build-time switches. `npm run build` writes a Web Store edition with `youtube: false`,
// because Chrome Web Store policy does not allow extensions that save YouTube videos.
globalThis.OFVS_CONFIG = {
  youtube: true,
};
