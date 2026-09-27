import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/lib/auth';
import { ToastProvider } from '@/components/ui';
import { LocaleProvider } from '@/lib/i18n';
import { ThemeProvider, themeInitScript } from '@/lib/theme';
import { PwaProvider } from '@/components/pwa/PwaProvider';

export const metadata: Metadata = {
  title: 'QuadranGIS',
  description: 'GIS jaringan kelistrikan berbasis web / Electrical network GIS',
  applicationName: 'QuadranGIS',
  manifest: '/manifest.webmanifest',
  icons: { icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }, { url: '/icons/icon-192.png', sizes: '192x192' }], apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'QuadranGIS', statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#1d59f0' },
    { media: '(prefers-color-scheme: dark)', color: '#111827' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="font-sans antialiased">
        <ThemeProvider>
          <LocaleProvider>
            <ToastProvider>
              <AuthProvider>
                <PwaProvider>{children}</PwaProvider>
              </AuthProvider>
            </ToastProvider>
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
