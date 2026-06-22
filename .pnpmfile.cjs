function readPackage(pkg) {
  // Allow esbuild to run its build scripts
  if (pkg.name === 'esbuild') {
    pkg.pnpm = { allowBuild: true };
  }
  return pkg;
}

module.exports = {
  hooks: {
    readPackage,
  },
};
