/** @type {import('next').NextConfig} */
const nextConfig = {
  // The workspace packages ship raw TypeScript source (`"main": "src/index.ts"`, no build
  // step), so Next's default "only compile my own app code" behaviour must be told to also
  // run its compiler over these — otherwise importing them fails at build time with a syntax
  // error the moment Next hits the first `.ts` file inside node_modules.
  transpilePackages: ['@yt/core', '@yt/db', '@yt/pipeline', '@yt/providers'],
}

module.exports = nextConfig
