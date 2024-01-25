/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    domains: ['images.ctfassets.net']
  },
  // async rewrites() {
  //   return [
  //     {
  //       source: '/api/:path*',
  //       destination: `${process.env.ROOT_URL}/api/:path*` // Proxy to external API
  //     }
  //   ];
  // }
};

module.exports = nextConfig;
