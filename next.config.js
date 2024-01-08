/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    domains: ['images.ctfassets.net']
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'https://zensync.vercel.app/api/:path*' // Proxy to external API
      }
    ];
  }
};

module.exports = nextConfig;
