/** @type {import('next').NextConfig} */
const backend = process.env.BACKEND_INTERNAL_URL || 'http://localhost:8080';

const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    // Saat dev tanpa nginx, /api diteruskan ke backend agar cookie & CORS tidak bermasalah.
    return [{ source: '/api/:path*', destination: `${backend}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
